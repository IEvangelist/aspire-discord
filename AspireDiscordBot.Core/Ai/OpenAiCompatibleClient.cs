using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;
using AspireDiscordBot.Core.Configuration;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace AspireDiscordBot.Core.Ai;

/// <summary>
/// A single <see cref="HttpClient"/>-based client that speaks the OpenAI chat/embeddings
/// wire format, which GitHub Copilot, Azure OpenAI, Azure AI Foundry and OpenAI all implement.
/// The provider differences (URL shape + auth header) are resolved from <see cref="AiOptions.Provider"/>.
/// </summary>
public sealed class OpenAiCompatibleClient(
    IHttpClientFactory httpFactory,
    CopilotTokenProvider copilotTokenProvider,
    IOptions<AiOptions> options,
    ILogger<OpenAiCompatibleClient> logger) : IChatModel, IEmbeddingModel
{
    private static readonly JsonSerializerOptions SerializerOptions = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };
    private readonly AiOptions _options = options.Value;

    public async Task<string> CompleteAsync(IReadOnlyList<AiChatMessage> messages, CancellationToken cancellationToken = default)
    {
        var provider = _options.Provider;
        var url = BuildUrl(provider, isEmbedding: false, _options.ChatModel);
        var body = new ChatRequest
        {
            Model = ModelInBody(provider) ? _options.ChatModel : null,
            Messages = messages.Select(m => new ChatRequestMessage { Role = m.Role, Content = m.Content }).ToList(),
            Temperature = _options.Temperature,
            MaxTokens = _options.MaxOutputTokens,
        };

        var http = httpFactory.CreateClient("ai");
        using var request = await CreateRequestAsync(provider, HttpMethod.Post, url, body, cancellationToken);
        using var response = await http.SendAsync(request, cancellationToken);
        await EnsureSuccessAsync(response, cancellationToken);

        var payload = await response.Content.ReadFromJsonAsync<ChatResponse>(SerializerOptions, cancellationToken)
                      ?? throw new InvalidOperationException("Chat response body was empty.");
        return payload.Choices?.FirstOrDefault()?.Message?.Content?.Trim() ?? string.Empty;
    }

    public async Task<IReadOnlyList<float[]>> EmbedAsync(IReadOnlyList<string> inputs, CancellationToken cancellationToken = default)
    {
        if (inputs.Count == 0)
        {
            return [];
        }

        // Embeddings may use a different provider than chat (see AiOptions.EmbeddingProvider).
        var provider = string.IsNullOrWhiteSpace(_options.EmbeddingProvider) ? _options.Provider : _options.EmbeddingProvider!;
        var url = BuildUrl(provider, isEmbedding: true, _options.EmbeddingModel);
        var body = new EmbeddingRequest
        {
            Model = ModelInBody(provider) ? _options.EmbeddingModel : null,
            Input = inputs,
        };

        var http = httpFactory.CreateClient("ai");
        using var request = await CreateRequestAsync(provider, HttpMethod.Post, url, body, cancellationToken);
        using var response = await http.SendAsync(request, cancellationToken);
        await EnsureSuccessAsync(response, cancellationToken);

        var payload = await response.Content.ReadFromJsonAsync<EmbeddingResponse>(SerializerOptions, cancellationToken)
                      ?? throw new InvalidOperationException("Embedding response body was empty.");

        // Preserve request order using the returned index.
        return payload.Data
            .OrderBy(d => d.Index)
            .Select(d => d.Embedding)
            .ToList();
    }

    // Azure OpenAI puts the model in the URL (deployment); every other provider puts it in the body.
    private static bool ModelInBody(string provider) => !string.Equals(provider, "azureopenai", StringComparison.OrdinalIgnoreCase);

    private string BuildUrl(string provider, bool isEmbedding, string model)
    {
        var op = isEmbedding ? "embeddings" : "chat/completions";

        return provider.ToLowerInvariant() switch
        {
            "copilot" => $"{_options.Copilot.ApiBase.TrimEnd('/')}/{op}",
            "azureopenai" => $"{_options.Endpoint.TrimEnd('/')}/openai/deployments/{model}/{op}?api-version={_options.ApiVersion}",
            "azureaifoundry" => $"{_options.Endpoint.TrimEnd('/')}/{op}?api-version={_options.ApiVersion}",
            "openai" => $"{_options.Endpoint.TrimEnd('/')}/v1/{op}",
            _ => throw new InvalidOperationException(
                $"Unknown AI provider '{provider}'. Use copilot, azureopenai, azureaifoundry, or openai."),
        };
    }

    private async Task<HttpRequestMessage> CreateRequestAsync<T>(
        string provider, HttpMethod method, string url, T body, CancellationToken cancellationToken)
    {
        var request = new HttpRequestMessage(method, url)
        {
            Content = JsonContent.Create(body, options: SerializerOptions),
        };

        switch (provider.ToLowerInvariant())
        {
            case "copilot":
                var token = await copilotTokenProvider.GetTokenAsync(cancellationToken);
                request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
                request.Headers.TryAddWithoutValidation("Copilot-Integration-Id", _options.Copilot.IntegrationId);
                request.Headers.TryAddWithoutValidation("Editor-Version", _options.Copilot.EditorVersion);
                request.Headers.TryAddWithoutValidation("Editor-Plugin-Version", _options.Copilot.EditorPluginVersion);
                break;

            case "openai":
                request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _options.ApiKey);
                break;

            default: // azureopenai, azureaifoundry
                request.Headers.TryAddWithoutValidation("api-key", _options.ApiKey);
                break;
        }

        return request;
    }

    private async Task EnsureSuccessAsync(HttpResponseMessage response, CancellationToken cancellationToken)
    {
        if (response.IsSuccessStatusCode)
        {
            return;
        }

        var content = await response.Content.ReadAsStringAsync(cancellationToken);
        logger.LogError("AI provider request failed ({StatusCode}): {Body}", (int)response.StatusCode, content);
        throw new HttpRequestException(
            $"AI provider request failed with status {(int)response.StatusCode}. See logs for details.");
    }

    private sealed class ChatRequest
    {
        [JsonPropertyName("model")] public string? Model { get; set; }
        [JsonPropertyName("messages")] public required List<ChatRequestMessage> Messages { get; set; }
        [JsonPropertyName("temperature")] public double Temperature { get; set; }
        [JsonPropertyName("max_tokens")] public int MaxTokens { get; set; }
    }

    private sealed class ChatRequestMessage
    {
        [JsonPropertyName("role")] public required string Role { get; set; }
        [JsonPropertyName("content")] public required string Content { get; set; }
    }

    private sealed class ChatResponse
    {
        [JsonPropertyName("choices")] public List<ChatChoice>? Choices { get; set; }
    }

    private sealed class ChatChoice
    {
        [JsonPropertyName("message")] public ChatResponseMessage? Message { get; set; }
    }

    private sealed class ChatResponseMessage
    {
        [JsonPropertyName("content")] public string? Content { get; set; }
    }

    private sealed class EmbeddingRequest
    {
        [JsonPropertyName("model")] public string? Model { get; set; }
        [JsonPropertyName("input")] public required IReadOnlyList<string> Input { get; set; }
    }

    private sealed class EmbeddingResponse
    {
        [JsonPropertyName("data")] public List<EmbeddingData> Data { get; set; } = [];
    }

    private sealed class EmbeddingData
    {
        [JsonPropertyName("index")] public int Index { get; set; }
        [JsonPropertyName("embedding")] public float[] Embedding { get; set; } = [];
    }
}
