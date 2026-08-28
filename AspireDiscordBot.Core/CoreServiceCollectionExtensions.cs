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

/// <summary>Registers document ingestion, embeddings, and vector-index generation publishing.</summary>
public static class CoreServiceCollectionExtensions
{
    /// <param name="builder">The host application builder.</param>
    /// <param name="qdrantConnectionName">The Aspire connection name for the Qdrant resource.</param>
    public static IHostApplicationBuilder AddAspireDiscordBotCore(
        this IHostApplicationBuilder builder,
        string qdrantConnectionName = "qdrant")
    {
        var services = builder.Services;
        var configuration = builder.Configuration;
        var vectorStoreProvider = configuration[$"{VectorStoreOptions.SectionName}:Provider"]
            ?? "qdrant";

        if (vectorStoreProvider.Equals("qdrant", StringComparison.OrdinalIgnoreCase))
        {
            // Aspire wires the Qdrant connection string, telemetry, and health checks.
            builder.AddQdrantClient(qdrantConnectionName);
        }

        services.AddOptions<AiOptions>()
            .Bind(configuration.GetSection(AiOptions.SectionName))
            .Validate(
                IsValidFoundryConfiguration,
                "Ai:EmbeddingEndpoint must be a valid HTTPS endpoint for Azure AI Foundry.")
            .ValidateOnStart();
        services.Configure<IngestionOptions>(configuration.GetSection(IngestionOptions.SectionName));
        services.Configure<ApiSurfaceOptions>(configuration.GetSection(ApiSurfaceOptions.SectionName));
        services.AddOptions<VectorStoreOptions>()
            .Bind(configuration.GetSection(VectorStoreOptions.SectionName))
            .Validate(
                IsValidVectorStoreConfiguration,
                "VectorStore must select qdrant or provide an HTTPS Azure AI Search endpoint.")
            .ValidateOnStart();

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
        if (vectorStoreProvider.Equals("azuresearch", StringComparison.OrdinalIgnoreCase))
        {
            services.AddSingleton<AzureSearchVectorStore>();
            services.AddSingleton<IVectorStore>(sp =>
                sp.GetRequiredService<AzureSearchVectorStore>());
        }
        else
        {
            services.AddSingleton<QdrantVectorStore>();
            services.AddSingleton<IVectorStore>(sp =>
                sp.GetRequiredService<QdrantVectorStore>());
        }
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

    private static bool IsValidVectorStoreConfiguration(VectorStoreOptions options) =>
        options.Provider.Equals("qdrant", StringComparison.OrdinalIgnoreCase)
        || options.Provider.Equals("azuresearch", StringComparison.OrdinalIgnoreCase)
            && Uri.TryCreate(options.Endpoint, UriKind.Absolute, out var endpoint)
            && endpoint.Scheme == Uri.UriSchemeHttps
            && options.GenerationRetention >= 2;
}
