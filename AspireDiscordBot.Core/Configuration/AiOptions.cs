namespace AspireDiscordBot.Core.Configuration;

/// <summary>
/// Configuration for the OpenAI-compatible chat + embedding provider.
/// Works with Azure OpenAI (default), Azure AI Foundry, and OpenAI by switching <see cref="Provider"/>.
/// </summary>
public sealed class AiOptions
{
    public const string SectionName = "Ai";

    /// <summary>One of: <c>azureopenai</c>, <c>azureaifoundry</c>, <c>openai</c>.</summary>
    public string Provider { get; set; } = "azureopenai";

    /// <summary>
    /// Base endpoint. For Azure OpenAI: <c>https://{resource}.openai.azure.com</c>.
    /// For Azure AI Foundry: the models inference endpoint. For OpenAI: <c>https://api.openai.com</c>.
    /// </summary>
    public string Endpoint { get; set; } = "";

    /// <summary>API key (Azure OpenAI/Foundry key, or OpenAI API key). Supplied via user-secrets / Aspire parameters.</summary>
    public string ApiKey { get; set; } = "";

    /// <summary>Chat model. For Azure OpenAI this is the <b>deployment name</b>; otherwise the model id.</summary>
    public string ChatModel { get; set; } = "gpt-4o-mini";

    /// <summary>Embedding model. For Azure OpenAI this is the <b>deployment name</b>; otherwise the model id.</summary>
    public string EmbeddingModel { get; set; } = "text-embedding-3-small";

    /// <summary>Dimensionality of the embedding vectors (text-embedding-3-small = 1536).</summary>
    public int EmbeddingDimensions { get; set; } = 1536;

    /// <summary>API version query string used by Azure providers.</summary>
    public string ApiVersion { get; set; } = "2024-10-21";

    /// <summary>Low temperature keeps answers grounded and deterministic.</summary>
    public double Temperature { get; set; } = 0.1;

    /// <summary>Maximum tokens for the generated answer.</summary>
    public int MaxOutputTokens { get; set; } = 800;
}
