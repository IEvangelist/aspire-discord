using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using AspireDiscordBot.Core.Configuration;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace AspireDiscordBot.Core.Ai;

/// <summary>
/// A single <see cref="HttpClient"/>-based client for chat + embeddings. Chat uses the modern
/// <b>Responses API</b> (<c>/responses</c>) — the successor to chat/completions and the only surface
/// that serves GPT-5-class models — for GitHub Copilot, Azure OpenAI, Azure AI Foundry and OpenAI.
/// Ollama, which has no Responses API, keeps its native chat/completions surface. Embeddings use the
/// current <c>/embeddings</c> endpoint. Provider differences (URL shape + auth header) are resolved
/// from <see cref="AiOptions.Provider"/>.
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

        // Every modern provider (Copilot, OpenAI, Azure OpenAI, Azure AI Foundry) uses the Responses
        // API — the successor to chat/completions and the only surface that serves GPT-5-class
        // models. Ollama has no Responses API, so it keeps its native chat/completions surface.
        return UsesResponsesApi(provider)
            ? await CompleteViaResponsesAsync(provider, messages, cancellationToken)
            : await CompleteViaChatCompletionsAsync(provider, messages, cancellationToken);
    }

    /// <summary>Whether this provider supports the tool-calling agent loop (Responses API only).</summary>
    public bool SupportsTools => UsesResponsesApi(_options.Provider);

    /// <summary>
    /// Runs a single agent turn on the Responses API: sends the running conversation plus the tool
    /// specs, and returns either the model's final text or the tool calls it wants executed.
    /// </summary>
    public async Task<AgentTurn> RunAgentTurnAsync(
        IReadOnlyList<AgentItem> items,
        IReadOnlyList<ToolSpec> tools,
        CancellationToken cancellationToken = default)
    {
        var provider = _options.Provider;
        if (!UsesResponsesApi(provider))
        {
            throw new InvalidOperationException($"Provider '{provider}' does not support tool calling.");
        }

        var input = new JsonArray();
        foreach (var item in items)
        {
            input.Add(item switch
            {
                AgentMessage m => new JsonObject { ["role"] = m.Role, ["content"] = m.Content },
                AgentToolCall c => new JsonObject
                {
                    ["type"] = "function_call",
                    ["call_id"] = c.CallId,
                    ["name"] = c.Name,
                    ["arguments"] = c.ArgumentsJson,
                },
                AgentToolOutput o => new JsonObject
                {
                    ["type"] = "function_call_output",
                    ["call_id"] = o.CallId,
                    ["output"] = o.Output,
                },
                _ => throw new InvalidOperationException($"Unknown agent item {item.GetType().Name}."),
            });
        }

        var toolArray = new JsonArray();
        foreach (var t in tools)
        {
            toolArray.Add(new JsonObject
            {
                ["type"] = "function",
                ["name"] = t.Name,
                ["description"] = t.Description,
                ["parameters"] = JsonNode.Parse(t.ParametersJsonSchema),
            });
        }

        var body = new JsonObject
        {
            ["model"] = _options.ChatModel,
            ["input"] = input,
            ["tools"] = toolArray,
            ["tool_choice"] = "auto",
            ["parallel_tool_calls"] = true,
            ["max_output_tokens"] = _options.MaxOutputTokens,
        };
        if (!string.IsNullOrWhiteSpace(_options.ReasoningEffort))
        {
            body["reasoning"] = new JsonObject { ["effort"] = _options.ReasoningEffort };
        }

        var http = httpFactory.CreateClient("ai");
        using var request = await CreateRequestAsync(provider, HttpMethod.Post, BuildResponsesUrl(provider), body, cancellationToken);
        using var response = await http.SendAsync(request, cancellationToken);
        await EnsureSuccessAsync(response, cancellationToken);

        var payload = await response.Content.ReadFromJsonAsync<ResponsesResponse>(SerializerOptions, cancellationToken)
                      ?? throw new InvalidOperationException("Responses body was empty.");

        var calls = new List<ToolCall>();
        foreach (var item in payload.Output ?? [])
        {
            if (string.Equals(item.Type, "function_call", StringComparison.Ordinal)
                && item.CallId is { Length: > 0 } callId
                && item.Name is { Length: > 0 } name)
            {
                calls.Add(new ToolCall(callId, name, item.Arguments ?? "{}"));
            }
        }

        return new AgentTurn(ExtractOutputText(payload).Trim(), calls);
    }


    private async Task<string> CompleteViaResponsesAsync(
        string provider, IReadOnlyList<AiChatMessage> messages, CancellationToken cancellationToken)
    {
        var url = BuildResponsesUrl(provider);
        var body = new ResponsesRequest
        {
            Model = _options.ChatModel,
            Input = messages.Select(m => new ResponsesMessage { Role = m.Role, Content = m.Content }).ToList(),
            MaxOutputTokens = _options.MaxOutputTokens,
            // Reasoning models (GPT-5-class) only accept the default temperature, so none is sent.
            // The reasoning block is omitted when ReasoningEffort is empty (non-reasoning models).
            Reasoning = string.IsNullOrWhiteSpace(_options.ReasoningEffort)
                ? null
                : new ResponsesReasoning { Effort = _options.ReasoningEffort },
        };

        var http = httpFactory.CreateClient("ai");
        using var request = await CreateRequestAsync(provider, HttpMethod.Post, url, body, cancellationToken);
        using var response = await http.SendAsync(request, cancellationToken);
        await EnsureSuccessAsync(response, cancellationToken);

        var payload = await response.Content.ReadFromJsonAsync<ResponsesResponse>(SerializerOptions, cancellationToken)
                      ?? throw new InvalidOperationException("Responses body was empty.");
        return ExtractOutputText(payload).Trim();
    }

    private async Task<string> CompleteViaChatCompletionsAsync(
        string provider, IReadOnlyList<AiChatMessage> messages, CancellationToken cancellationToken)
    {
        var url = BuildChatCompletionsUrl(provider);
        var body = new ChatRequest
        {
            Model = _options.ChatModel,
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

    /// <summary>
    /// Extracts the assistant's text from a Responses payload. The convenience <c>output_text</c>
    /// field isn't populated by every provider (Copilot returns null), so the text is aggregated
    /// from the <c>message</c> output items, skipping reasoning and tool items.
    /// </summary>
    private static string ExtractOutputText(ResponsesResponse payload)
    {
        if (!string.IsNullOrEmpty(payload.OutputText))
        {
            return payload.OutputText;
        }

        if (payload.Output is null)
        {
            return string.Empty;
        }

        var builder = new StringBuilder();
        foreach (var item in payload.Output)
        {
            if (!string.Equals(item.Type, "message", StringComparison.Ordinal) || item.Content is null)
            {
                continue;
            }

            foreach (var part in item.Content)
            {
                if (string.Equals(part.Type, "output_text", StringComparison.Ordinal) && part.Text is { Length: > 0 })
                {
                    builder.Append(part.Text);
                }
            }
        }

        return builder.ToString();
    }

    public async Task<IReadOnlyList<float[]>> EmbedAsync(IReadOnlyList<string> inputs, CancellationToken cancellationToken = default)
    {
        if (inputs.Count == 0)
        {
            return [];
        }

        // Embeddings may use a different provider than chat (see AiOptions.EmbeddingProvider).
        var provider = string.IsNullOrWhiteSpace(_options.EmbeddingProvider) ? _options.Provider : _options.EmbeddingProvider!;
        var url = BuildEmbeddingsUrl(provider, _options.EmbeddingModel);
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

    // Azure OpenAI puts the model in the URL (deployment) for embeddings; others put it in the body.
    private static bool ModelInBody(string provider) => !string.Equals(provider, "azureopenai", StringComparison.OrdinalIgnoreCase);

    // Ollama has no Responses API, so it stays on its native chat/completions surface.
    private static bool UsesResponsesApi(string provider) =>
        !string.Equals(provider, "ollama", StringComparison.OrdinalIgnoreCase);

    private string BuildResponsesUrl(string provider) => provider.ToLowerInvariant() switch
    {
        "copilot" => $"{_options.Copilot.ApiBase.TrimEnd('/')}/responses",
        // The Azure OpenAI v1 GA surface takes the model in the body (no deployment path / api-version).
        "azureopenai" or "azureaifoundry" => $"{_options.Endpoint.TrimEnd('/')}/openai/v1/responses",
        "openai" => $"{_options.Endpoint.TrimEnd('/')}/v1/responses",
        _ => throw new InvalidOperationException(
            $"Provider '{provider}' does not support the Responses API. Use copilot, azureopenai, azureaifoundry, or openai."),
    };

    private string BuildChatCompletionsUrl(string provider) => provider.ToLowerInvariant() switch
    {
        "ollama" => $"{_options.Endpoint.TrimEnd('/')}/v1/chat/completions",
        _ => throw new InvalidOperationException(
            $"Provider '{provider}' should use the Responses API, not chat/completions."),
    };

    private string BuildEmbeddingsUrl(string provider, string model) => provider.ToLowerInvariant() switch
    {
        "copilot" => $"{_options.Copilot.ApiBase.TrimEnd('/')}/embeddings",
        "azureopenai" => $"{_options.Endpoint.TrimEnd('/')}/openai/deployments/{model}/embeddings?api-version={_options.ApiVersion}",
        "azureaifoundry" => $"{_options.Endpoint.TrimEnd('/')}/embeddings?api-version={_options.ApiVersion}",
        "openai" or "ollama" => $"{_options.Endpoint.TrimEnd('/')}/v1/embeddings",
        _ => throw new InvalidOperationException(
            $"Unknown AI provider '{provider}'. Use copilot, azureopenai, azureaifoundry, openai, or ollama."),
    };

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

            case "ollama":
                // Local Ollama needs no authentication; send only the API key if one was configured.
                if (!string.IsNullOrEmpty(_options.ApiKey))
                {
                    request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _options.ApiKey);
                }
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

    private sealed class ResponsesRequest
    {
        [JsonPropertyName("model")] public required string Model { get; set; }
        [JsonPropertyName("input")] public required List<ResponsesMessage> Input { get; set; }
        [JsonPropertyName("max_output_tokens")] public int MaxOutputTokens { get; set; }
        [JsonPropertyName("reasoning")] public ResponsesReasoning? Reasoning { get; set; }
    }

    private sealed class ResponsesMessage
    {
        [JsonPropertyName("role")] public required string Role { get; set; }
        [JsonPropertyName("content")] public required string Content { get; set; }
    }

    private sealed class ResponsesReasoning
    {
        [JsonPropertyName("effort")] public required string Effort { get; set; }
    }

    private sealed class ResponsesResponse
    {
        [JsonPropertyName("output_text")] public string? OutputText { get; set; }
        [JsonPropertyName("output")] public List<ResponsesOutputItem>? Output { get; set; }
    }

    private sealed class ResponsesOutputItem
    {
        [JsonPropertyName("type")] public string? Type { get; set; }
        [JsonPropertyName("content")] public List<ResponsesContentPart>? Content { get; set; }
        [JsonPropertyName("call_id")] public string? CallId { get; set; }
        [JsonPropertyName("name")] public string? Name { get; set; }
        [JsonPropertyName("arguments")] public string? Arguments { get; set; }
    }

    private sealed class ResponsesContentPart
    {
        [JsonPropertyName("type")] public string? Type { get; set; }
        [JsonPropertyName("text")] public string? Text { get; set; }
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
