using Aspire.Hosting.ApplicationModel;
using AspireDiscordBot.AppHost;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

var builder = DistributedApplication.CreateBuilder(args);

var fullOllamaMode = builder.Configuration.GetValue<bool>("Ollama:Enabled");
var configuredChatProvider = builder.Configuration["Parameters:AiProvider"] ?? "copilot";
var chatProvider = fullOllamaMode ? "ollama" : configuredChatProvider;
var embeddingProvider = fullOllamaMode
    ? "ollama"
    : builder.Configuration["Parameters:AiEmbeddingProvider"]
        ?? (string.Equals(chatProvider, "copilot", StringComparison.OrdinalIgnoreCase)
            ? "ollama"
            : chatProvider);

var ollamaChatModel = builder.Configuration["Ollama:ChatModel"] ?? "llama3.1";
var ollamaEmbeddingModel = builder.Configuration["Ollama:EmbeddingModel"] ?? "nomic-embed-text";
var ollamaEmbeddingDimensions = builder.Configuration.GetValue("Ollama:EmbeddingDimensions", 768);
var needsOllama =
    string.Equals(chatProvider, "ollama", StringComparison.OrdinalIgnoreCase)
    || string.Equals(embeddingProvider, "ollama", StringComparison.OrdinalIgnoreCase);

// The Discord bot token remains the one always-required secret.
var discordToken = builder.AddParameter("DiscordToken", secret: true);

var qdrant = builder.AddQdrant("qdrant")
    .WithDataVolume()
    .WithLifetime(ContainerLifetime.Persistent);

IResourceBuilder<ContainerResource>? ollama = null;
if (needsOllama)
{
    ollama = builder.AddContainer("ollama", "ollama/ollama")
        .WithHttpEndpoint(targetPort: 11434, name: "http")
        .WithVolume("aspire-discord-ollama", "/root/.ollama")
        .WithLifetime(ContainerLifetime.Persistent);

    var models = new List<string>();
    if (string.Equals(chatProvider, "ollama", StringComparison.OrdinalIgnoreCase))
    {
        models.Add(ollamaChatModel);
    }

    if (string.Equals(embeddingProvider, "ollama", StringComparison.OrdinalIgnoreCase))
    {
        models.Add(ollamaEmbeddingModel);
    }

    builder.Eventing.Subscribe<ResourceReadyEvent>(ollama.Resource, async (evt, ct) =>
    {
        var logger = evt.Services.GetRequiredService<ILoggerFactory>().CreateLogger("Ollama");
        var baseUrl = ollama.GetEndpoint("http").Url;
        await OllamaModelPuller.PullAsync(
            baseUrl,
            models.Distinct().ToArray(),
            logger,
            ct);
    });
}

var configuredEndpoint = builder.Configuration["Parameters:AiEndpoint"] ?? "";
var configuredApiKey = builder.Configuration["Parameters:AiApiKey"] ?? "";
var providersMatch = string.Equals(
    chatProvider,
    embeddingProvider,
    StringComparison.OrdinalIgnoreCase);
var configuredEmbeddingEndpoint =
    builder.Configuration["Parameters:AiEmbeddingEndpoint"]
    ?? (providersMatch ? configuredEndpoint : "");
var configuredEmbeddingApiKey =
    builder.Configuration["Parameters:AiEmbeddingApiKey"]
    ?? (providersMatch ? configuredApiKey : "");
var configuredEmbeddingModel =
    builder.Configuration["Parameters:AiEmbeddingModel"]
    ?? (string.Equals(embeddingProvider, "ollama", StringComparison.OrdinalIgnoreCase)
        ? ollamaEmbeddingModel
        : "text-embedding-3-small");
var configuredEmbeddingDimensions =
    builder.Configuration["Parameters:AiEmbeddingDimensions"]
    ?? (string.Equals(embeddingProvider, "ollama", StringComparison.OrdinalIgnoreCase)
        ? ollamaEmbeddingDimensions.ToString()
        : "1536");
var legacyGitHubToken = builder.Configuration["Parameters:GitHubToken"];

var ai = new AiConfiguration
{
    Provider = chatProvider,
    ChatModel = string.Equals(chatProvider, "ollama", StringComparison.OrdinalIgnoreCase)
        ? ollamaChatModel
        : builder.Configuration["Parameters:AiChatModel"] ?? "gpt-5.6-sol",
    Endpoint = configuredEndpoint,
    ApiKey = configuredApiKey,
    ChatEndpointReference = string.Equals(chatProvider, "ollama", StringComparison.OrdinalIgnoreCase)
        ? ollama!.GetEndpoint("http")
        : null,
    EmbeddingProvider = embeddingProvider,
    EmbeddingModel = configuredEmbeddingModel,
    EmbeddingDimensions = configuredEmbeddingDimensions,
    EmbeddingEndpoint = configuredEmbeddingEndpoint,
    EmbeddingApiKey = configuredEmbeddingApiKey,
    EmbeddingApiVersion = builder.Configuration["Parameters:AiEmbeddingApiVersion"]
        ?? builder.Configuration["Parameters:AiApiVersion"]
        ?? "2024-10-21",
    EmbeddingEndpointReference =
        string.Equals(embeddingProvider, "ollama", StringComparison.OrdinalIgnoreCase)
            ? ollama!.GetEndpoint("http")
            : null,
    CopilotGitHubToken =
        builder.Configuration["Parameters:CopilotGitHubToken"] ?? legacyGitHubToken,
    GitHubMcpToken =
        builder.Configuration["Parameters:GitHubMcpToken"] ?? legacyGitHubToken,
};

var ingestion = builder.AddProject<Projects.AspireDiscordBot_Ingestion>("ingestion")
    .WithHttpEndpoint()
    .WithHttpHealthCheck("/ready")
    .WithReference(qdrant)
    .WaitFor(qdrant)
    .WithHttpCommand(
        "/admin/reingest",
        "Refresh index",
        endpointName: "http",
        commandOptions: new HttpCommandOptions
        {
            Method = HttpMethod.Post,
            Description = "Build and atomically publish fresh documentation and API index generations.",
            IconName = "ArrowSync",
        })
    .WithHttpCommand(
        "/admin/rebuild",
        "Force rebuild index",
        endpointName: "http",
        commandOptions: new HttpCommandOptions
        {
            Method = HttpMethod.Post,
            Description = "Resolve fresh source snapshots and atomically replace all index generations.",
            IconName = "DatabaseArrowUp",
            ConfirmationMessage = "This re-embeds every page and API entry. Continue?",
            IsHighlighted = false,
        })
    .WithUrlForEndpoint("http", _ => new ResourceUrlAnnotation
    {
        Url = "/scalar",
        DisplayText = "API Reference (Scalar)",
    })
    .WithAiEnvironment(ai);

var bot = builder.AddProject<Projects.AspireDiscordBot_Bot>("bot")
    .WithHttpEndpoint()
    .WithReference(qdrant)
    .WaitFor(qdrant)
    .WaitFor(ingestion)
    .WithEnvironment("Discord__Token", discordToken)
    .WithUrlForEndpoint("http", _ => new ResourceUrlAnnotation
    {
        Url = "/scalar",
        DisplayText = "API Reference (Scalar)",
    })
    .WithAiEnvironment(ai);

if (ollama is not null)
{
    ingestion.WaitFor(ollama);
    bot.WaitFor(ollama);
}

builder.Build().Run();
