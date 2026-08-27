using System.Diagnostics;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;
using AspireDiscordBot.Core.Configuration;
using AspireDiscordBot.Core.Telemetry;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace AspireDiscordBot.Core.Ai;

/// <summary>Embedding client for documented OpenAI-compatible providers.</summary>
public sealed class OpenAiCompatibleClient(
    IHttpClientFactory httpFactory,
    IOptions<AiOptions> options,
    ILogger<OpenAiCompatibleClient> logger) : IEmbeddingModel
{
    private static readonly JsonSerializerOptions SerializerOptions = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };
    private readonly AiOptions _options = options.Value;

    public async Task<IReadOnlyList<float[]>> EmbedAsync(
        IReadOnlyList<string> inputs,
        CancellationToken cancellationToken = default)
    {
        if (inputs.Count == 0)
        {
            return [];
        }

        var provider = string.IsNullOrWhiteSpace(_options.EmbeddingProvider)
            ? _options.Provider
            : _options.EmbeddingProvider;
        var url = BuildEmbeddingsUrl(provider, _options.EmbeddingModel);
        var sameProvider = string.Equals(provider, _options.Provider, StringComparison.OrdinalIgnoreCase);
        var effectiveEmbeddingEndpoint = !string.IsNullOrWhiteSpace(_options.EmbeddingEndpoint)
            ? _options.EmbeddingEndpoint
            : sameProvider
                ? _options.Endpoint
                : null;
        var endpointsMatch = sameProvider
            && !provider.Equals("ollama", StringComparison.OrdinalIgnoreCase)
            && NormalizeEndpoint(_options.Endpoint) == NormalizeEndpoint(effectiveEmbeddingEndpoint);
        var embeddingApiKey = !string.IsNullOrWhiteSpace(_options.EmbeddingApiKey)
            ? _options.EmbeddingApiKey
            : endpointsMatch
                ? _options.ApiKey
                : null;
        if (!provider.Equals("ollama", StringComparison.OrdinalIgnoreCase)
            && string.IsNullOrWhiteSpace(embeddingApiKey))
        {
            throw new InvalidOperationException(
                $"Embedding provider '{provider}' requires Ai:EmbeddingApiKey.");
        }

        var body = new EmbeddingRequest
        {
            Model = ModelInBody(provider) ? _options.EmbeddingModel : null,
            Input = inputs,
        };

        var http = httpFactory.CreateClient("ai");
        using var activity = GenAiTelemetry.StartOperation(
            GenAiTelemetry.OpEmbeddings,
            provider,
            _options.EmbeddingModel);
        activity?.SetTag("gen_ai.request.input_count", inputs.Count);
        var start = Stopwatch.GetTimestamp();
        string? errorType = null;
        try
        {
            using var request = CreateRequest(provider, url, body, embeddingApiKey);
            using var response = await http.SendAsync(request, cancellationToken);
            await EnsureSuccessAsync(response, cancellationToken);

            var payload = await response.Content.ReadFromJsonAsync<EmbeddingResponse>(
                SerializerOptions,
                cancellationToken)
                ?? throw new InvalidOperationException("Embedding response body was empty.");
            if (payload.Data.Count != inputs.Count)
            {
                throw new InvalidOperationException(
                    $"Embedding provider returned {payload.Data.Count} vectors for {inputs.Count} inputs.");
            }

            if (payload.Usage?.PromptTokens is { } promptTokens)
            {
                GenAiTelemetry.RecordUsage(
                    activity,
                    GenAiTelemetry.OpEmbeddings,
                    provider,
                    _options.EmbeddingModel,
                    promptTokens,
                    null);
            }

            return payload.Data
                .OrderBy(data => data.Index)
                .Select(data => data.Embedding)
                .ToList();
        }
        catch (Exception ex)
        {
            errorType = ex.GetType().FullName;
            GenAiTelemetry.RecordError(activity, ex);
            throw;
        }
        finally
        {
            GenAiTelemetry.RecordDuration(
                GenAiTelemetry.OpEmbeddings,
                provider,
                _options.EmbeddingModel,
                Stopwatch.GetElapsedTime(start).TotalSeconds,
                errorType);
        }
    }

    private string BuildEmbeddingsUrl(string provider, string model)
    {
        var sameProvider = string.Equals(provider, _options.Provider, StringComparison.OrdinalIgnoreCase);
        var endpoint = !string.IsNullOrWhiteSpace(_options.EmbeddingEndpoint)
            ? _options.EmbeddingEndpoint
            : sameProvider
                ? _options.Endpoint
                : null;
        if (string.IsNullOrWhiteSpace(endpoint))
        {
            throw new InvalidOperationException(
                $"Embedding provider '{provider}' requires Ai:EmbeddingEndpoint.");
        }

        var apiVersion = string.IsNullOrWhiteSpace(_options.EmbeddingApiVersion)
            ? _options.ApiVersion
            : _options.EmbeddingApiVersion;
        return provider.ToLowerInvariant() switch
        {
            "azureopenai" =>
                $"{endpoint.TrimEnd('/')}/openai/deployments/{model}/embeddings?api-version={apiVersion}",
            "azureaifoundry" => $"{endpoint.TrimEnd('/')}/embeddings?api-version={apiVersion}",
            "openai" or "ollama" => $"{endpoint.TrimEnd('/')}/v1/embeddings",
            "copilot" => throw new InvalidOperationException(
                "GitHub Copilot does not expose a supported embeddings API."),
            _ => throw new InvalidOperationException(
                $"Unknown embedding provider '{provider}'."),
        };
    }

    private HttpRequestMessage CreateRequest<T>(
        string provider,
        string url,
        T body,
        string? apiKey)
    {
        var request = new HttpRequestMessage(HttpMethod.Post, url)
        {
            Content = JsonContent.Create(body, options: SerializerOptions),
        };
        switch (provider.ToLowerInvariant())
        {
            case "ollama":
                if (!string.IsNullOrWhiteSpace(apiKey))
                {
                    request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", apiKey);
                }
                break;
            case "openai":
                request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", apiKey);
                break;
            default:
                request.Headers.TryAddWithoutValidation("api-key", apiKey);
                break;
        }
        return request;
    }

    private async Task EnsureSuccessAsync(
        HttpResponseMessage response,
        CancellationToken cancellationToken)
    {
        if (response.IsSuccessStatusCode)
        {
            return;
        }

        var content = await response.Content.ReadAsStringAsync(cancellationToken);
        logger.LogError(
            "Embedding provider request failed ({StatusCode}): {Body}",
            (int)response.StatusCode,
            content);
        throw new HttpRequestException(
            $"Embedding provider request failed with status {(int)response.StatusCode}.");
    }

    private static bool ModelInBody(string provider) =>
        !provider.Equals("azureopenai", StringComparison.OrdinalIgnoreCase);

    private static string NormalizeEndpoint(string? endpoint)
    {
        if (!Uri.TryCreate(endpoint, UriKind.Absolute, out var uri))
        {
            return "";
        }

        var port = uri.IsDefaultPort ? "" : $":{uri.Port}";
        var path = uri.GetComponents(UriComponents.Path, UriFormat.UriEscaped).TrimEnd('/');
        var query = uri.GetComponents(UriComponents.Query, UriFormat.UriEscaped);
        return $"{uri.Scheme.ToLowerInvariant()}://{uri.IdnHost.ToLowerInvariant()}{port}/{path}"
            + (string.IsNullOrEmpty(query) ? "" : $"?{query}");
    }

    private sealed class EmbeddingRequest
    {
        [JsonPropertyName("model")]
        public string? Model { get; set; }

        [JsonPropertyName("input")]
        public required IReadOnlyList<string> Input { get; set; }
    }

    private sealed class EmbeddingResponse
    {
        [JsonPropertyName("data")]
        public List<EmbeddingData> Data { get; set; } = [];

        [JsonPropertyName("usage")]
        public EmbeddingUsage? Usage { get; set; }
    }

    private sealed class EmbeddingData
    {
        [JsonPropertyName("index")]
        public int Index { get; set; }

        [JsonPropertyName("embedding")]
        public float[] Embedding { get; set; } = [];
    }

    private sealed class EmbeddingUsage
    {
        [JsonPropertyName("prompt_tokens")]
        public int? PromptTokens { get; set; }
    }
}
