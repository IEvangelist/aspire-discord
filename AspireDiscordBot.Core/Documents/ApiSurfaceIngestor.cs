using AspireDiscordBot.Core.Ai;
using AspireDiscordBot.Core.Configuration;
using AspireDiscordBot.Core.Vectors;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace AspireDiscordBot.Core.Documents;

/// <summary>
/// Ingests the microsoft/aspire public API surface from a local source clone into its own Qdrant
/// collection. It walks the configured <c>src</c> subtrees, extracts public types + XML docs with
/// <see cref="ApiSurfaceExtractor"/>, chunks and embeds them, and upserts to the API collection so
/// the agent's <c>search_api</c> tool can retrieve real type/method-level knowledge.
/// </summary>
public sealed class ApiSurfaceIngestor(
    DocumentChunker chunker,
    IEmbeddingModel embeddingModel,
    QdrantVectorStore vectorStore,
    IOptions<ApiSurfaceOptions> options,
    ILogger<ApiSurfaceIngestor> logger)
{
    private const int EmbeddingBatchSize = 16;
    private readonly ApiSurfaceOptions _options = options.Value;

    /// <summary>Whether API surface ingestion is configured (a local src path is set and exists).</summary>
    public bool IsEnabled =>
        !string.IsNullOrWhiteSpace(_options.LocalSrcPath) && Directory.Exists(_options.LocalSrcPath);

    /// <summary>The Qdrant collection storing the API surface.</summary>
    public string CollectionName => _options.CollectionName;

    /// <param name="forceReindex">When true, the API collection is dropped and rebuilt.</param>
    public async Task<IngestionResult> IngestAsync(bool forceReindex, CancellationToken cancellationToken = default)
    {
        if (!IsEnabled)
        {
            logger.LogInformation("API surface ingestion is disabled (ApiSurface:LocalSrcPath not set).");
            return new IngestionResult(0, 0, "api");
        }

        await vectorStore.EnsureCollectionAsync(forceReindex, cancellationToken, _options.CollectionName);

        var files = EnumerateSourceFiles(_options.LocalSrcPath!).ToList();
        logger.LogInformation("API surface: scanning {Count} source files under {Path}.", files.Count, _options.LocalSrcPath);

        var typeCount = 0;
        var chunkCount = 0;
        var buffer = new List<DocChunk>(EmbeddingBatchSize);

        foreach (var file in files)
        {
            cancellationToken.ThrowIfCancellationRequested();

            string text;
            try
            {
                text = await File.ReadAllTextAsync(file, cancellationToken);
            }
            catch (Exception ex)
            {
                logger.LogDebug(ex, "Skipping unreadable file {File}.", file);
                continue;
            }

            var relativePath = Path.GetRelativePath(_options.LocalSrcPath!, file).Replace('\\', '/');

            foreach (var api in ApiSurfaceExtractor.Extract(text, relativePath))
            {
                typeCount++;
                var source = new DocSource
                {
                    Repo = _options.CitationRepo,
                    Path = $"src/{relativePath}",
                    Title = $"{api.TypeName} ({api.Namespace})",
                    Url = $"https://github.com/{_options.CitationRepo}/blob/{_options.CitationBranch}/src/{relativePath}",
                };

                foreach (var chunk in chunker.Chunk(source, api.Body))
                {
                    buffer.Add(chunk);
                    chunkCount++;
                    if (buffer.Count >= EmbeddingBatchSize)
                    {
                        await FlushAsync(buffer, cancellationToken);
                        buffer.Clear();
                    }
                }
            }
        }

        if (buffer.Count > 0)
        {
            await FlushAsync(buffer, cancellationToken);
        }

        logger.LogInformation(
            "API surface ingestion complete: {Types} public types, {Chunks} chunks into '{Collection}'.",
            typeCount, chunkCount, _options.CollectionName);

        return new IngestionResult(typeCount, chunkCount, "api");
    }

    private IEnumerable<string> EnumerateSourceFiles(string srcRoot)
    {
        var prefixes = _options.IncludeProjectPrefixes;
        foreach (var file in Directory.EnumerateFiles(srcRoot, "*.cs", SearchOption.AllDirectories))
        {
            var relative = Path.GetRelativePath(srcRoot, file).Replace('\\', '/');

            // Skip generated, test, and obj/bin artifacts.
            if (relative.Contains("/obj/", StringComparison.OrdinalIgnoreCase)
                || relative.Contains("/bin/", StringComparison.OrdinalIgnoreCase)
                || relative.EndsWith(".g.cs", StringComparison.OrdinalIgnoreCase)
                || relative.EndsWith(".Designer.cs", StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            if (prefixes.Count > 0)
            {
                var project = relative.Split('/', 2)[0];
                if (!prefixes.Any(p => project.StartsWith(p, StringComparison.OrdinalIgnoreCase)))
                {
                    continue;
                }
            }

            yield return file;
        }
    }

    private async Task FlushAsync(List<DocChunk> chunks, CancellationToken cancellationToken)
    {
        var inputs = chunks.Select(c => c.Content).ToList();
        var embeddings = await embeddingModel.EmbedAsync(inputs, cancellationToken);
        await vectorStore.UpsertAsync(chunks, embeddings, cancellationToken, _options.CollectionName);
    }
}
