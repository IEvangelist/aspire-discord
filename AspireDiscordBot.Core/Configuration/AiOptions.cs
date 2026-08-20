namespace AspireDiscordBot.Core.Configuration;

/// <summary>
/// Configuration for the OpenAI-compatible chat + embedding provider.
/// Works with Azure OpenAI (default), Azure AI Foundry, and OpenAI by switching <see cref="Provider"/>.
/// </summary>
public sealed class AiOptions
{
    public const string SectionName = "Ai";

    /// <summary>One of: <c>copilot</c>, <c>azureopenai</c>, <c>azureaifoundry</c>, <c>openai</c>, <c>ollama</c>.</summary>
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
    /// For Ollama: the server base URL (e.g. <c>http://localhost:11434</c>).
    /// Ignored for the <c>copilot</c> provider (it targets the GitHub Copilot API).
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

    /// <summary>
    /// When true (default), a service performs the interactive GitHub device-flow sign-in itself
    /// if no cached token exists. When false, the service does NOT prompt — it waits for the
    /// shared cached token to appear (written by the AppHost, which surfaces the sign-in prompt
    /// in the Aspire dashboard via the interaction service). See <see cref="SignInWaitSeconds"/>.
    /// </summary>
    public bool InteractiveSignIn { get; set; } = true;

    /// <summary>
    /// How long a service waits for the shared cached token when <see cref="InteractiveSignIn"/>
    /// is false, before failing. Gives the operator time to complete the dashboard sign-in.
    /// </summary>
    public int SignInWaitSeconds { get; set; } = 600;
}
