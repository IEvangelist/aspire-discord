using System.Net.Http.Json;
using AspireDiscordBot.Core.Configuration;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace AspireDiscordBot.Core.Ai;

/// <summary>Ensures a configured local Ollama embedding model exists before ingestion starts.</summary>
public sealed class EmbeddingModelReadiness(
    IHttpClientFactory httpClientFactory,
    IOptions<AiOptions> options,
    ILogger<EmbeddingModelReadiness> logger)
{
    private readonly AiOptions _options = options.Value;

    public async Task EnsureReadyAsync(CancellationToken cancellationToken = default)
    {
        var provider = string.IsNullOrWhiteSpace(_options.EmbeddingProvider)
            ? _options.Provider
            : _options.EmbeddingProvider;
        if (!string.Equals(provider, "ollama", StringComparison.OrdinalIgnoreCase))
        {
            return;
        }

        var endpoint = string.IsNullOrWhiteSpace(_options.EmbeddingEndpoint)
            ? _options.Endpoint
            : _options.EmbeddingEndpoint;
        if (string.IsNullOrWhiteSpace(endpoint))
        {
            throw new InvalidOperationException(
                "Ollama embeddings require Ai:EmbeddingEndpoint.");
        }

        var http = httpClientFactory.CreateClient("ollama-bootstrap");
        logger.LogInformation(
            "Ensuring Ollama embedding model '{Model}' is available.",
            _options.EmbeddingModel);
        using var response = await http.PostAsJsonAsync(
            $"{endpoint.TrimEnd('/')}/api/pull",
            new { model = _options.EmbeddingModel, stream = false },
            cancellationToken);
        if (!response.IsSuccessStatusCode)
        {
            var body = await response.Content.ReadAsStringAsync(cancellationToken);
            throw new HttpRequestException(
                $"Ollama model pull failed ({(int)response.StatusCode}): {body}");
        }
    }
}
