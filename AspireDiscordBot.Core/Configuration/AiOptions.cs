namespace AspireDiscordBot.Core.Configuration;

/// <summary>Configuration for ingestion-time embeddings.</summary>
public sealed class AiOptions
{
    public const string SectionName = "Ai";

    /// <summary>Legacy fallback when <see cref="EmbeddingProvider"/> is omitted.</summary>
    public string Provider { get; set; } = "azureaifoundry";

    /// <summary>One of <c>azureopenai</c>, <c>azureaifoundry</c>, <c>openai</c>, or <c>ollama</c>.</summary>
    public string? EmbeddingProvider { get; set; } = "azureaifoundry";

    /// <summary>Embedding endpoint; falls back to <see cref="Endpoint"/> for compatible configurations.</summary>
    public string? EmbeddingEndpoint { get; set; }

    /// <summary>Embedding credential; falls back to <see cref="ApiKey"/> only for the same provider.</summary>
    public string? EmbeddingApiKey { get; set; }

    public string? EmbeddingApiVersion { get; set; }

    public string Endpoint { get; set; } = "";

    public string ApiKey { get; set; } = "";

    public string EmbeddingModel { get; set; } = "text-embedding-3-small";

    public int EmbeddingDimensions { get; set; } = 1536;

    public string ApiVersion { get; set; } = "2024-10-21";
}
