namespace AspireDiscordBot.Core.Configuration;

/// <summary>
/// Configuration for the OpenAI-compatible chat + embedding provider.
/// Works with Azure OpenAI (default), Azure AI Foundry, and OpenAI by switching <see cref="Provider"/>.
/// </summary>
public sealed class AiOptions
{
    public const string SectionName = "Ai";

    /// <summary>One of: <c>copilot</c>, <c>azureopenai</c>, <c>azureaifoundry</c>, <c>openai</c>.</summary>
    public string Provider { get; set; } = "copilot";

    /// <summary>
    /// Optional separate provider for embeddings. When null, <see cref="Provider"/> is used for
    /// both chat and embeddings. Lets you e.g. use GitHub Copilot for chat and Azure OpenAI for
    /// embeddings if a Copilot embeddings endpoint isn't available to your account.
    /// </summary>
    public string? EmbeddingProvider { get; set; }

    /// <summary>
    /// Base endpoint. For Azure OpenAI: <c>https://{resource}.openai.azure.com</c>.
    /// For Azure AI Foundry: the models inference endpoint. For OpenAI: <c>https://api.openai.com</c>.
    /// Ignored for the <c>copilot</c> provider (it targets the GitHub Copilot API).
    /// </summary>
    public string Endpoint { get; set; } = "";

    /// <summary>API key (Azure OpenAI/Foundry key, or OpenAI API key). Supplied via user-secrets / Aspire parameters.</summary>
    public string ApiKey { get; set; } = "";

    /// <summary>Chat model. For Azure OpenAI this is the <b>deployment name</b>; otherwise the model id.</summary>
    public string ChatModel { get; set; } = "gpt-5.6-sol";

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

    /// <summary>Settings for the <c>copilot</c> provider (inherits your GitHub Copilot access).</summary>
    public CopilotOptions Copilot { get; set; } = new();
}

/// <summary>
/// Settings for using GitHub Copilot as the AI provider. On first use the bot performs a GitHub
/// device-flow login (one time) and caches the OAuth token; it then exchanges that for a
/// short-lived Copilot bearer token and calls the OpenAI-compatible Copilot API.
/// </summary>
public sealed class CopilotOptions
{
    /// <summary>Base URL of the GitHub Copilot OpenAI-compatible API.</summary>
    public string ApiBase { get; set; } = "https://api.githubcopilot.com";

    /// <summary>GitHub OAuth app client id used for the device-flow login (the editor Copilot app).</summary>
    public string ClientId { get; set; } = "Iv1.b507a08c87ecfe98";

    /// <summary>Integration id sent with Copilot requests.</summary>
    public string IntegrationId { get; set; } = "vscode-chat";

    /// <summary>Editor-Version header value sent with Copilot requests.</summary>
    public string EditorVersion { get; set; } = "AspireDiscordBot/1.0";

    /// <summary>Editor-Plugin-Version header value sent with Copilot requests.</summary>
    public string EditorPluginVersion { get; set; } = "AspireDiscordBot/1.0";

    /// <summary>
    /// Path to the cached OAuth token. Defaults to
    /// <c>%USERPROFILE%/.aspire-discord/copilot-oauth.json</c>. Shared by the ingestion worker
    /// and the bot so the device-flow login only happens once.
    /// </summary>
    public string? OAuthTokenPath { get; set; }
}
