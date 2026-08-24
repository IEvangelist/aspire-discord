namespace AspireDiscordBot.Core.Configuration;

/// <summary>
/// Configuration for chat and embeddings. The <c>copilot</c> chat provider is implemented by the
/// official GitHub Copilot SDK; documented OpenAI-compatible endpoints provide embeddings and the
/// other chat providers.
/// </summary>
public sealed class AiOptions
{
    public const string SectionName = "Ai";

    /// <summary>One of: <c>copilot</c>, <c>azureopenai</c>, <c>azureaifoundry</c>, <c>openai</c>, <c>ollama</c>.</summary>
    public string Provider { get; set; } = "copilot";

    /// <summary>
    /// Optional separate provider for embeddings. This is required when chat uses <c>copilot</c>
    /// because the Copilot SDK does not expose embeddings. Supported values are
    /// <c>azureopenai</c>, <c>azureaifoundry</c>, <c>openai</c>, and <c>ollama</c>.
    /// </summary>
    public string? EmbeddingProvider { get; set; }

    /// <summary>Optional endpoint used only for embeddings; falls back to <see cref="Endpoint"/>.</summary>
    public string? EmbeddingEndpoint { get; set; }

    /// <summary>Optional key used only for embeddings; falls back to <see cref="ApiKey"/>.</summary>
    public string? EmbeddingApiKey { get; set; }

    /// <summary>Optional Azure API version used only for embeddings.</summary>
    public string? EmbeddingApiVersion { get; set; }

    /// <summary>
    /// Base endpoint. For Azure OpenAI: <c>https://{resource}.openai.azure.com</c>.
    /// For Azure AI Foundry: the models inference endpoint. For OpenAI: <c>https://api.openai.com</c>.
    /// For Ollama: the server base URL (e.g. <c>http://localhost:11434</c>).
    /// Ignored for the <c>copilot</c> chat provider.
    /// </summary>
    public string Endpoint { get; set; } = "";

    /// <summary>API key (Azure OpenAI/Foundry key, or OpenAI API key). Supplied via user-secrets / Aspire parameters.</summary>
    public string ApiKey { get; set; } = "";

    /// <summary>Chat model. For Azure OpenAI this is the <b>deployment name</b>; otherwise the model id.</summary>
    public string ChatModel { get; set; } = "gpt-5.6-sol";

    /// <summary>Embedding model. For Azure OpenAI this is the <b>deployment name</b>; otherwise the model id.</summary>
    public string EmbeddingModel { get; set; } = "text-embedding-3-small";

    /// <summary>
    /// Dimensionality of the embedding vectors. Must match the embedding model:
    /// text-embedding-3-small = 1536; Ollama's nomic-embed-text = 768; mxbai-embed-large = 1024.
    /// Changing this requires rebuilding the Qdrant collection (use the Force rebuild command).
    /// </summary>
    public int EmbeddingDimensions { get; set; } = 1536;

    /// <summary>API version query string used by Azure providers for the embeddings endpoint.</summary>
    public string ApiVersion { get; set; } = "2024-10-21";

    /// <summary>
    /// Sampling temperature for the <c>ollama</c> chat/completions path only. Ignored on the
    /// Responses API path (GPT-5-class reasoning models accept only the default temperature).
    /// </summary>
    public double Temperature { get; set; } = 0.1;

    /// <summary>
    /// Reasoning effort for GPT-5-class models on the Responses API: <c>low</c>, <c>medium</c>, or
    /// <c>high</c>. <c>low</c> keeps a docs Q&amp;A bot fast and cheap. Leave empty for non-reasoning
    /// models (e.g. <c>gpt-4o</c>), which reject the reasoning parameter.
    /// </summary>
    public string ReasoningEffort { get; set; } = "low";

    /// <summary>
    /// Maximum tokens for the generated answer. On the Responses API this budget also covers the
    /// model's internal reasoning tokens, so keep it generous to avoid truncated answers.
    /// </summary>
    public int MaxOutputTokens { get; set; } = 2000;

    /// <summary>
    /// Opt-in: capture prompt/completion message content on GenAI telemetry spans
    /// (<c>gen_ai.input.messages</c>/<c>output.messages</c>/<c>system_instructions</c>) so the Aspire
    /// dashboard's Input/Output panels render the conversation. Off by default because these contain
    /// the full question, retrieved context, and model output (large and potentially sensitive).
    /// </summary>
    public bool CaptureMessageContent { get; set; }

    /// <summary>Settings for the <c>copilot</c> provider (inherits your GitHub Copilot access).</summary>
    public CopilotOptions Copilot { get; set; } = new();
}

/// <summary>
/// Settings for the official GitHub Copilot SDK runtime.
/// </summary>
public sealed class CopilotOptions
{
    /// <summary>
    /// Optional user token passed to the official Copilot SDK. Prefer the
    /// <c>COPILOT_GITHUB_TOKEN</c> environment variable or the SDK's logged-in user.
    /// </summary>
    public string? GitHubToken { get; set; }

    /// <summary>Whether the SDK may use credentials from an existing Copilot or GitHub CLI login.</summary>
    public bool UseLoggedInUser { get; set; } = true;

    /// <summary>Directory for isolated Copilot SDK runtime and session state.</summary>
    public string? RuntimeBasePath { get; set; }

    /// <summary>Server-wide idle cleanup timeout for SDK sessions.</summary>
    public int SessionIdleTimeoutSeconds { get; set; } = 300;

}
