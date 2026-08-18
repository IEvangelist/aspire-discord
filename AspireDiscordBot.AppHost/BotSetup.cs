using Aspire.Hosting;
using Aspire.Hosting.ApplicationModel;
using Microsoft.Extensions.Configuration;

#pragma warning disable ASPIREINTERACTION001 // InteractionInput / PromptInputsAsync are experimental.

namespace AspireDiscordBot.AppHost;

/// <summary>The resolved settings applied to the bot + ingestion services as environment variables.</summary>
internal sealed record BotSettings(
    string DiscordToken,
    string AiProvider,
    string AiEndpoint,
    string AiApiKey,
    string ChatModel,
    string EmbeddingModel,
    int EmbeddingDimensions);

/// <summary>
/// Collects the bot's runtime configuration through a single Aspire dashboard dialog on first run
/// (Discord token, AI provider, and any provider credentials), then applies the values to the
/// services as environment variables. Values already supplied via configuration / user-secrets
/// (keys under <c>Parameters:</c>) are used as-is and suppress the prompt. The prompt runs at most
/// once — the first service to resolve its environment triggers it; the others await the result.
/// </summary>
internal sealed class BotSetup(IConfiguration configuration, bool ollamaForced)
{
    private const string DefaultProvider = "copilot";
    private const string DefaultChatModel = "gpt-5.6-sol";
    private const string DefaultEmbeddingModel = "text-embedding-3-small";
    private const int DefaultEmbeddingDimensions = 1536;

    private static readonly IReadOnlyList<KeyValuePair<string, string>> ProviderChoices =
    [
        new("copilot", "GitHub Copilot (inherit your access; no keys)"),
        new("azureopenai", "Azure OpenAI"),
        new("azureaifoundry", "Azure AI Foundry"),
        new("openai", "OpenAI"),
        new("ollama", "Ollama (local)"),
    ];

    private readonly SemaphoreSlim _gate = new(1, 1);
    private BotSettings? _resolved;

    /// <summary>Set from the built application before <c>Run()</c> so env callbacks can prompt.</summary>
    public IInteractionService? Interaction { get; set; }

    /// <summary>
    /// The resolved settings for env callbacks. Returns the prompted values once
    /// <see cref="ResolveAsync"/> has run; otherwise falls back to configuration/defaults
    /// (e.g. in publish mode, where there is no dialog).
    /// </summary>
    public BotSettings Current => _resolved ?? ReadFromConfig();

    /// <summary>Resolves the settings once, prompting via the dashboard when needed.</summary>
    public async Task<BotSettings> ResolveAsync(CancellationToken cancellationToken)
    {
        if (_resolved is not null)
        {
            return _resolved;
        }

        await _gate.WaitAsync(cancellationToken);
        try
        {
            _resolved ??= await BuildAsync(cancellationToken);
            return _resolved;
        }
        finally
        {
            _gate.Release();
        }
    }

    private BotSettings ReadFromConfig() => new(
        configuration["Parameters:DiscordToken"] ?? "",
        Nonempty(configuration["Parameters:AiProvider"], DefaultProvider),
        configuration["Parameters:AiEndpoint"] ?? "",
        configuration["Parameters:AiApiKey"] ?? "",
        Nonempty(configuration["Parameters:AiChatModel"], DefaultChatModel),
        Nonempty(configuration["Parameters:AiEmbeddingModel"], DefaultEmbeddingModel),
        ParseInt(configuration["Parameters:AiEmbeddingDimensions"], DefaultEmbeddingDimensions));

    private async Task<BotSettings> BuildAsync(CancellationToken cancellationToken)
    {
        var fromConfig = ReadFromConfig();

        var haveToken = !string.IsNullOrWhiteSpace(fromConfig.DiscordToken);
        var canPrompt = Interaction is { IsAvailable: true };

        // If the Discord token is already configured, or we can't prompt, use config/defaults as-is.
        if (haveToken || !canPrompt)
        {
            return fromConfig;
        }

        var prompted = await PromptAsync(fromConfig, cancellationToken);
        return prompted ?? fromConfig;
    }

    private async Task<BotSettings?> PromptAsync(BotSettings current, CancellationToken cancellationToken)
    {
        var tokenInput = new InteractionInput
        {
            Name = "DiscordToken",
            InputType = InputType.SecretText,
            Label = "Discord bot token",
            Description = "From the Discord Developer Portal → your app → Bot → Reset Token.",
            Required = true,
            Value = current.DiscordToken,
        };

        // In Ollama-orchestrated mode the provider + endpoint are fixed to the container, so the
        // dialog only needs the Discord token.
        if (ollamaForced)
        {
            var tokenOnly = await Interaction!.PromptInputsAsync(
                "Configure the Aspire Discord bot",
                "Enter the Discord bot token. AI is served by the orchestrated Ollama container.",
                [tokenInput],
                new InputsDialogInteractionOptions { PrimaryButtonText = "Start bot", ShowDismiss = false },
                cancellationToken);

            return tokenOnly.Canceled
                ? null
                : current with { DiscordToken = tokenOnly.Data["DiscordToken"].Value ?? "", AiProvider = "ollama" };
        }

        var inputs = new List<InteractionInput>
        {
            tokenInput,
            new()
            {
                Name = "AiProvider",
                InputType = InputType.Choice,
                Label = "AI provider",
                Description = "Copilot needs no keys. Azure/OpenAI need an endpoint + key. Ollama runs locally.",
                Required = true,
                Value = current.AiProvider,
                Options = ProviderChoices,
            },
            new()
            {
                Name = "AiEndpoint",
                InputType = InputType.Text,
                Label = "AI endpoint (Azure/OpenAI/Ollama)",
                Placeholder = "https://<resource>.openai.azure.com  •  http://localhost:11434 for Ollama",
                Required = false,
                Value = current.AiEndpoint,
            },
            new()
            {
                Name = "AiApiKey",
                InputType = InputType.SecretText,
                Label = "AI API key (leave blank for Copilot / Ollama)",
                Required = false,
                Value = current.AiApiKey,
            },
            new()
            {
                Name = "ChatModel",
                InputType = InputType.Text,
                Label = "Chat model",
                Required = true,
                Value = current.ChatModel,
            },
            new()
            {
                Name = "EmbeddingModel",
                InputType = InputType.Text,
                Label = "Embedding model",
                Required = true,
                Value = current.EmbeddingModel,
            },
            new()
            {
                Name = "EmbeddingDimensions",
                InputType = InputType.Number,
                Label = "Embedding dimensions",
                Description = "Must match the embedding model (1536 for text-embedding-3-small, 768 for nomic-embed-text).",
                Required = true,
                Value = current.EmbeddingDimensions.ToString(),
            },
        };

        var response = await Interaction!.PromptInputsAsync(
            "Configure the Aspire Discord bot",
            "These settings are applied to the bot and ingestion services for this run.",
            inputs,
            new InputsDialogInteractionOptions { PrimaryButtonText = "Start bot", ShowDismiss = false },
            cancellationToken);

        if (response.Canceled)
        {
            return null;
        }

        var data = response.Data;
        return new BotSettings(
            data["DiscordToken"].Value ?? "",
            Nonempty(data["AiProvider"].Value, DefaultProvider),
            data["AiEndpoint"].Value ?? "",
            data["AiApiKey"].Value ?? "",
            Nonempty(data["ChatModel"].Value, DefaultChatModel),
            Nonempty(data["EmbeddingModel"].Value, DefaultEmbeddingModel),
            ParseInt(data["EmbeddingDimensions"].Value, DefaultEmbeddingDimensions));
    }

    private static string Nonempty(string? value, string fallback) =>
        string.IsNullOrWhiteSpace(value) ? fallback : value!;

    private static int ParseInt(string? value, int fallback) =>
        int.TryParse(value, out var n) && n > 0 ? n : fallback;
}
