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
/// wire format, which Azure OpenAI, Azure AI Foundry and OpenAI all implement. The provider
/// differences (URL shape + auth header) are resolved from <see cref="AiOptions.Provider"/>.
/// </summary>
public sealed class OpenAiCompatibleClient : IChatModel, IEmbeddingModel
{
    private static readonly JsonSerializerOptions SerializerOptions = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    private readonly IHttpClientFactory _httpFactory;
    private readonly AiOptions _options;
    private readonly ILogger<OpenAiCompatibleClient> _logger;

    public OpenAiCompatibleClient(IHttpClientFactory httpFactory, IOptions<AiOptions> options, ILogger<OpenAiCompatibleClient> logger)
    {
        _httpFactory = httpFactory;
        _options = options.Value;
        _logger = logger;
    }

    public async Task<string> CompleteAsync(IReadOnlyList<AiChatMessage> messages, CancellationToken cancellationToken = default)
    {
        var url = BuildUrl(isEmbedding: false, _options.ChatModel);
        var body = new ChatRequest
        {
            Model = ModelInBody ? _options.ChatModel : null,
            Messages = messages.Select(m => new ChatRequestMessage { Role = m.Role, Content = m.Content }).ToList(),
            Temperature = _options.Temperature,
            MaxTokens = _options.MaxOutputTokens,
        };

        var http = _httpFactory.CreateClient("ai");
        using var request = CreateRequest(HttpMethod.Post, url, body);
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

        var url = BuildUrl(isEmbedding: true, _options.EmbeddingModel);
        var body = new EmbeddingRequest
        {
            Model = ModelInBody ? _options.EmbeddingModel : null,
            Input = inputs,
        };

        var http = _httpFactory.CreateClient("ai");
        using var request = CreateRequest(HttpMethod.Post, url, body);
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

    private bool ModelInBody => !string.Equals(_options.Provider, "azureopenai", StringComparison.OrdinalIgnoreCase);

    private bool UsesApiKeyHeader => !string.Equals(_options.Provider, "openai", StringComparison.OrdinalIgnoreCase);

    private string BuildUrl(bool isEmbedding, string model)
    {
        var endpoint = _options.Endpoint.TrimEnd('/');
        var op = isEmbedding ? "embeddings" : "chat/completions";

        return _options.Provider.ToLowerInvariant() switch
        {
            "azureopenai" => $"{endpoint}/openai/deployments/{model}/{op}?api-version={_options.ApiVersion}",
            "azureaifoundry" => $"{endpoint}/{op}?api-version={_options.ApiVersion}",
            "openai" => $"{endpoint}/v1/{op}",
            _ => throw new InvalidOperationException(
                $"Unknown AI provider '{_options.Provider}'. Use azureopenai, azureaifoundry, or openai."),
        };
    }

    private HttpRequestMessage CreateRequest<T>(HttpMethod method, string url, T body)
    {
        var request = new HttpRequestMessage(method, url)
        {
            Content = JsonContent.Create(body, options: SerializerOptions),
        };

        if (UsesApiKeyHeader)
        {
            request.Headers.TryAddWithoutValidation("api-key", _options.ApiKey);
        }
        else
        {
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _options.ApiKey);
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
        _logger.LogError("AI provider request failed ({StatusCode}): {Body}", (int)response.StatusCode, content);
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
