using AspireDiscordBot.Core.Ai;
using AspireDiscordBot.Core.Configuration;
using AspireDiscordBot.Core.Vectors;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace AspireDiscordBot.Core.Documents;

/// <summary>
/// Ingests the microsoft/aspire public API surface from a managed or local Git snapshot into its own
/// Qdrant index. It walks the configured <c>src</c> subtrees, extracts public types + XML docs with
/// <see cref="ApiSurfaceExtractor"/>, chunks and embeds them, and upserts to the API collection so
/// the agent's <c>search_api</c> tool can retrieve real type/method-level knowledge.
/// </summary>
public sealed class ApiSurfaceIngestor(
    DocumentChunker chunker,
    IEmbeddingModel embeddingModel,
    QdrantVectorStore vectorStore,
    GitSourceSnapshotProvider snapshots,
    IOptions<ApiSurfaceOptions> options,
    ILogger<ApiSurfaceIngestor> logger)
{
    private const int EmbeddingBatchSize = 16;
    private readonly ApiSurfaceOptions _options = options.Value;

    /// <summary>Whether API surface ingestion and retrieval are configured.</summary>
    public bool IsEnabled =>
        _options.Enabled
        || (!string.IsNullOrWhiteSpace(_options.LocalSrcPath)
            && Directory.Exists(_options.LocalSrcPath));

    /// <summary>The Qdrant collection storing the API surface.</summary>
    public string CollectionName => _options.CollectionName;

    public async Task<IngestionResult> IngestAsync(bool forceReindex, CancellationToken cancellationToken = default)
    {
        var completed = await BuildAsync(forceReindex, cancellationToken);
        try
        {
            await vectorStore.CommitBuildAsync(completed.Build, cancellationToken);
            return completed.Result;
        }
        catch
        {
            await vectorStore.AbortBuildAsync(completed.Build, CancellationToken.None);
            throw;
        }
    }

    /// <summary>Builds a complete API generation without publishing its logical alias.</summary>
    public async Task<IngestionBuildResult> BuildAsync(
        bool forceReindex,
        CancellationToken cancellationToken = default)
    {
        if (!IsEnabled)
        {
            throw new InvalidOperationException("API surface ingestion is disabled.");
        }

        var snapshot = await snapshots.GetAsync(cancellationToken);
        var files = EnumerateSourceFiles(snapshot.SourceRoot).ToList();
        if (files.Count == 0)
        {
            throw new InvalidOperationException(
                $"No API source files were found under '{snapshot.SourceRoot}'.");
        }

        logger.LogInformation(
            "API surface: scanning {Count} source files under {Path} at {Revision}.",
            files.Count,
            snapshot.SourceRoot,
            snapshot.Revision);
        var build = await vectorStore.BeginBuildAsync(_options.CollectionName, cancellationToken);

        var typeCount = 0;
        var chunkCount = 0;
        var buffer = new List<DocChunk>(EmbeddingBatchSize);

        try
        {
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
                    throw new IOException($"Unable to read API source file '{file}'.", ex);
                }

                var relativePath = Path.GetRelativePath(snapshot.SourceRoot, file).Replace('\\', '/');

                foreach (var api in ApiSurfaceExtractor.Extract(text, relativePath))
                {
                    typeCount++;
                    var source = new DocSource
                    {
                        Repo = _options.CitationRepo,
                        Path = $"src/{relativePath}",
                        Title = $"{api.TypeName} ({api.Namespace})",
                        Url = $"https://github.com/{_options.CitationRepo}/blob/{snapshot.Revision}/src/{relativePath}",
                        Revision = snapshot.Revision,
                    };

                    foreach (var chunk in chunker.Chunk(source, api.Body))
                    {
                        buffer.Add(chunk);
                        chunkCount++;
                        if (buffer.Count >= EmbeddingBatchSize)
                        {
                            await FlushAsync(buffer, build, cancellationToken);
                            buffer.Clear();
                        }
                    }
                }
            }

            if (buffer.Count > 0)
            {
                await FlushAsync(buffer, build, cancellationToken);
            }

            if (typeCount == 0 || chunkCount == 0)
            {
                throw new InvalidOperationException(
                    "The API source snapshot produced no public API entries; the current index was preserved.");
            }

            logger.LogInformation(
                "API generation built: {Types} public types, {Chunks} chunks for '{Collection}'.",
                typeCount, chunkCount, _options.CollectionName);
            return new IngestionBuildResult(
                new IngestionResult(typeCount, chunkCount, "api"),
                build);
        }
        catch
        {
            await vectorStore.AbortBuildAsync(build, CancellationToken.None);
            throw;
        }
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

    private async Task FlushAsync(
        List<DocChunk> chunks,
        VectorIndexBuild build,
        CancellationToken cancellationToken)
    {
        var inputs = chunks.Select(c => c.Content).ToList();
        var embeddings = await embeddingModel.EmbedAsync(inputs, cancellationToken);
        await vectorStore.UpsertAsync(
            chunks,
            embeddings,
            cancellationToken,
            build.PhysicalCollection,
            build);
    }
}
