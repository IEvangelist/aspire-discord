using Aspire.Hosting.ApplicationModel;
using AspireDiscordBot.AppHost;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

#pragma warning disable ASPIREINTERACTION001 // Interaction service APIs are experimental.

var builder = DistributedApplication.CreateBuilder(args);

// Optionally orchestrate a local Ollama container for fully-local runs (set "Ollama:Enabled": true,
// e.g. via user-secrets or environment). When enabled, AI is served by this container.
var ollamaEnabled = builder.Configuration.GetValue<bool>("Ollama:Enabled");
var ollamaChatModel = builder.Configuration["Ollama:ChatModel"] ?? "llama3.1";
var ollamaEmbeddingModel = builder.Configuration["Ollama:EmbeddingModel"] ?? "nomic-embed-text";
var ollamaEmbeddingDimensions = builder.Configuration.GetValue("Ollama:EmbeddingDimensions", 768);

// The Discord bot token is the one always-required secret. As an unresolved secret parameter,
// Aspire prompts for it once in the dashboard (a single dialog) when it isn't already provided via
// user-secrets, and offers to save it back to user-secrets so later runs don't prompt.
var discordToken = builder.AddParameter("DiscordToken", secret: true);

// --- Qdrant vector database (persisted across runs) ---
var qdrant = builder.AddQdrant("qdrant")
    .WithDataVolume()
    .WithLifetime(ContainerLifetime.Persistent);

// --- Optional local Ollama server ---
IResourceBuilder<ContainerResource>? ollama = null;
if (ollamaEnabled)
{
    ollama = builder.AddContainer("ollama", "ollama/ollama")
        .WithHttpEndpoint(targetPort: 11434, name: "http")
        .WithVolume("aspire-discord-ollama", "/root/.ollama")
        .WithLifetime(ContainerLifetime.Persistent);

    // Pull the configured models once the server is ready (best-effort, in the background).
    builder.Eventing.Subscribe<ResourceReadyEvent>(ollama.Resource, (evt, ct) =>
    {
        var logger = evt.Services.GetRequiredService<ILoggerFactory>().CreateLogger("Ollama");
        var baseUrl = ollama!.GetEndpoint("http").Url;
        _ = Task.Run(() => OllamaModelPuller.PullAsync(baseUrl, [ollamaChatModel, ollamaEmbeddingModel], logger, ct), ct);
        return Task.CompletedTask;
    });
}

// Resolve the AI settings once. In Ollama mode the endpoint is the container; otherwise the
// configured provider/endpoint/key is used (the default Copilot provider needs no endpoint/key).
// When using Copilot with no cached token, the AppHost drives the sign-in (surfaced in the
// dashboard) so the services just wait for the shared token instead of prompting in their logs.
var copilotMode = !ollamaEnabled &&
    string.Equals(builder.Configuration["Parameters:AiProvider"] ?? "copilot", "copilot", StringComparison.OrdinalIgnoreCase);
var appHostDrivenSignIn = builder.ExecutionContext.IsRunMode && copilotMode && !CopilotSignIn.HasCachedToken();

var ai = ollamaEnabled
    ? new AiConfiguration
    {
        Provider = "ollama",
        ChatModel = ollamaChatModel,
        EmbeddingModel = ollamaEmbeddingModel,
        EmbeddingDimensions = ollamaEmbeddingDimensions.ToString(),
        OllamaEndpoint = ollama!.GetEndpoint("http"),
    }
    : new AiConfiguration
    {
        Provider = builder.Configuration["Parameters:AiProvider"] ?? "copilot",
        Endpoint = builder.Configuration["Parameters:AiEndpoint"] ?? "",
        ApiKey = builder.Configuration["Parameters:AiApiKey"] ?? "",
        ChatModel = builder.Configuration["Parameters:AiChatModel"] ?? "gpt-5.6-sol",
        EmbeddingModel = builder.Configuration["Parameters:AiEmbeddingModel"] ?? "text-embedding-3-small",
        EmbeddingDimensions = builder.Configuration["Parameters:AiEmbeddingDimensions"] ?? "1536",
        // Services wait for the AppHost-driven sign-in rather than prompting themselves.
        CopilotInteractiveSignIn = appHostDrivenSignIn ? false : null,
    };

// --- Ingestion worker: pulls Aspire docs (source of truth) -> embeds -> Qdrant ---
// Exposes dashboard commands to refresh the index on demand (backed by its /admin endpoints).
var ingestion = builder.AddProject<Projects.AspireDiscordBot_Ingestion>("ingestion")
    .WithHttpEndpoint()
    .WithReference(qdrant)
    .WaitFor(qdrant)
    .WithHttpCommand(
        "/admin/reingest",
        "Re-ingest docs",
        endpointName: "http",
        commandOptions: new HttpCommandOptions
        {
            Method = HttpMethod.Post,
            Description = "Re-read the Aspire docs and update the index (incremental).",
            IconName = "ArrowSync",
        })
    .WithHttpCommand(
        "/admin/rebuild",
        "Force rebuild index",
        endpointName: "http",
        commandOptions: new HttpCommandOptions
        {
            Method = HttpMethod.Post,
            Description = "Drop and rebuild the whole index from scratch (prunes deleted pages).",
            IconName = "DatabaseArrowUp",
            ConfirmationMessage = "This drops the current index and re-embeds every page. Continue?",
            IsHighlighted = false,
        })
    .WithAiEnvironment(ai);

// --- Discord bot: answers questions grounded in the ingested docs ---
var bot = builder.AddProject<Projects.AspireDiscordBot_Bot>("bot")
    .WithReference(qdrant)
    .WaitFor(qdrant)
    .WithEnvironment("Discord__Token", discordToken)
    .WithAiEnvironment(ai);

if (ollama is not null)
{
    ingestion.WaitFor(ollama);
    bot.WaitFor(ollama);
}

var app = builder.Build();

// Drive the GitHub Copilot device-flow sign-in from the AppHost so the code + link are surfaced
// prominently in the dashboard (via the interaction service) rather than buried in service logs.
// Runs in the background so it never blocks startup; the services wait for the shared cached token.
if (appHostDrivenSignIn)
{
    var interaction = app.Services.GetService<IInteractionService>();
    if (interaction is not null)
    {
        var logger = app.Services.GetRequiredService<ILoggerFactory>().CreateLogger("CopilotSignIn");
        var lifetime = app.Services.GetRequiredService<IHostApplicationLifetime>();

        var http = new HttpClient { Timeout = TimeSpan.FromSeconds(30) };
        http.DefaultRequestHeaders.Accept.ParseAdd("application/json");
        http.DefaultRequestHeaders.UserAgent.ParseAdd("aspire-discord-bot/1.0");

        _ = Task.Run(async () =>
        {
            try
            {
                await CopilotSignIn.RunAsync(interaction, http, logger, lifetime.ApplicationStopping);
            }
            finally
            {
                http.Dispose();
            }
        });
    }
}

app.Run();
