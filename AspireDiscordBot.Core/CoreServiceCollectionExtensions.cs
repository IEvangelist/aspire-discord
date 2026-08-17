using AspireDiscordBot.Core.Ai;
using AspireDiscordBot.Core.Configuration;
using AspireDiscordBot.Core.Documents;
using AspireDiscordBot.Core.Rag;
using AspireDiscordBot.Core.Safety;
using AspireDiscordBot.Core.Vectors;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Options;

namespace AspireDiscordBot.Core;

/// <summary>Registers the shared RAG pipeline (AI client, Qdrant store, retrieval, ingestion).</summary>
public static class CoreServiceCollectionExtensions
{
    /// <param name="builder">The host application builder.</param>
    /// <param name="qdrantConnectionName">The Aspire connection name for the Qdrant resource.</param>
    public static IHostApplicationBuilder AddAspireDiscordBotCore(
        this IHostApplicationBuilder builder,
        string qdrantConnectionName = "qdrant")
    {
        // Qdrant client (Aspire client integration wires connection string + telemetry + health checks).
        builder.AddQdrantClient(qdrantConnectionName);

        var services = builder.Services;
        var configuration = builder.Configuration;

        services.Configure<AiOptions>(configuration.GetSection(AiOptions.SectionName));
        services.Configure<RetrievalOptions>(configuration.GetSection(RetrievalOptions.SectionName));
        services.Configure<IngestionOptions>(configuration.GetSection(IngestionOptions.SectionName));
        services.Configure<SafetyOptions>(configuration.GetSection(SafetyOptions.SectionName));

        // Default the ingestion sources to the catalog when none are configured.
        services.PostConfigure<IngestionOptions>(options =>
        {
            if (options.Sources.Count == 0)
            {
                options.Sources = DocSourceCatalog.Default();
            }
        });

        // OpenAI-compatible AI client shared as both chat + embedding model (named-client factory
        // avoids captive HttpClient handlers when consumed by singleton services).
        services.AddHttpClient("ai");
        // Dedicated client for GitHub Copilot device-flow login + token exchange.
        services.AddHttpClient("github-auth", http =>
        {
            http.Timeout = TimeSpan.FromSeconds(30);
            http.DefaultRequestHeaders.UserAgent.ParseAdd("aspire-discord-bot/1.0");
            http.DefaultRequestHeaders.Accept.ParseAdd("application/json");
        });
        services.AddSingleton<CopilotTokenProvider>();
        services.AddSingleton<OpenAiCompatibleClient>();
        services.AddSingleton<IChatModel>(sp => sp.GetRequiredService<OpenAiCompatibleClient>());
        services.AddSingleton<IEmbeddingModel>(sp => sp.GetRequiredService<OpenAiCompatibleClient>());

        // Document source readers. GitHub reader uses a configured named client; local reader is plain.
        services.AddHttpClient("github", (sp, http) =>
        {
            http.Timeout = TimeSpan.FromSeconds(100);
            http.DefaultRequestHeaders.UserAgent.ParseAdd("aspire-discord-bot/1.0");
            http.DefaultRequestHeaders.Accept.ParseAdd("application/vnd.github+json");

            var ingestion = sp.GetRequiredService<IOptions<IngestionOptions>>().Value;
            var token = ingestion.GitHubToken ?? Environment.GetEnvironmentVariable("GITHUB_TOKEN");
            if (!string.IsNullOrWhiteSpace(token))
            {
                http.DefaultRequestHeaders.Authorization =
                    new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", token);
            }
        });
        services.AddSingleton<GitHubDocSourceReader>();
        services.AddSingleton<LocalDocSourceReader>();
        services.AddSingleton<AspireDocUrlIndex>();
        services.AddSingleton<AspireCliDocSourceReader>();

        // Select the reader implementation based on the configured source mode.
        services.AddSingleton<IDocSourceReader>(sp =>
        {
            var mode = sp.GetRequiredService<IOptions<IngestionOptions>>().Value.SourceMode;
            return mode.ToLowerInvariant() switch
            {
                "local" => sp.GetRequiredService<LocalDocSourceReader>(),
                "github" => sp.GetRequiredService<GitHubDocSourceReader>(),
                _ => sp.GetRequiredService<AspireCliDocSourceReader>(),
            };
        });

        services.AddSingleton<DocumentChunker>();
        services.AddSingleton<QdrantVectorStore>();
        services.AddSingleton<DocumentIngestor>();
        services.AddSingleton<IngestionRunner>();
        services.AddSingleton<QuestionSafetyGuard>();
        services.AddSingleton<GroundedAnswerService>();

        return builder;
    }
}
