using Azure.Core;
using Azure.Identity;
using AspireDiscordBot.Core.Ai;
using AspireDiscordBot.Core.Configuration;
using AspireDiscordBot.Core.Documents;
using AspireDiscordBot.Core.Vectors;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Options;

namespace AspireDiscordBot.Core;

/// <summary>Registers document ingestion, embeddings, and Qdrant generation publishing.</summary>
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

        services.AddOptions<AiOptions>()
            .Bind(configuration.GetSection(AiOptions.SectionName))
            .Validate(
                IsValidFoundryConfiguration,
                "Ai:EmbeddingEndpoint must be a valid HTTPS endpoint for Azure AI Foundry.")
            .ValidateOnStart();
        services.Configure<IngestionOptions>(configuration.GetSection(IngestionOptions.SectionName));
        services.Configure<ApiSurfaceOptions>(configuration.GetSection(ApiSurfaceOptions.SectionName));

        // Default the ingestion sources to the catalog when none are configured.
        services.PostConfigure<IngestionOptions>(options =>
        {
            if (options.Sources.Count == 0)
            {
                options.Sources = DocSourceCatalog.Default();
            }
        });

        // Named clients avoid captive handlers in singleton ingestion services.
        services.AddHttpClient("ai");
        services.AddHttpClient("ollama-bootstrap", http =>
        {
            http.Timeout = TimeSpan.FromMinutes(30);
        });
        services.AddSingleton<TokenCredential>(_ => new DefaultAzureCredential());
        services.AddSingleton<EmbeddingModelReadiness>();
        services.AddSingleton<OpenAiCompatibleClient>();
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
        services.AddSingleton<GitSourceSnapshotProvider>();
        services.AddSingleton<ApiSurfaceIngestor>();
        services.AddSingleton<IngestionRunner>();

        return builder;
    }

    private static bool IsValidFoundryConfiguration(AiOptions options)
    {
        var provider = string.IsNullOrWhiteSpace(options.EmbeddingProvider)
            ? options.Provider
            : options.EmbeddingProvider;
        return !provider.Equals("azureaifoundry", StringComparison.OrdinalIgnoreCase)
            || Uri.TryCreate(options.EmbeddingEndpoint, UriKind.Absolute, out var endpoint)
                && endpoint.Scheme == Uri.UriSchemeHttps;
    }
}
