using AspireDiscordBot.Core.Ai;
using AspireDiscordBot.Core.Configuration;
using AspireDiscordBot.Core.Vectors;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace AspireDiscordBot.Core.Documents;

/// <summary>Summary statistics for an ingestion run.</summary>
public sealed record IngestionResult(int Files, int Chunks, string Mode);

/// <summary>A completed physical index awaiting publication.</summary>
public sealed record IngestionBuildResult(IngestionResult Result, VectorIndexBuild Build);

/// <summary>
/// End-to-end ingestion pipeline: read raw docs from the configured source, clean them,
/// chunk them, embed the chunks in batches, and upsert them into Qdrant.
/// </summary>
public sealed class DocumentIngestor(
    IDocSourceReader reader,
    DocumentChunker chunker,
    IEmbeddingModel embeddingModel,
    QdrantVectorStore vectorStore,
    IOptions<IngestionOptions> options,
    ILogger<DocumentIngestor> logger)
{
    private const int EmbeddingBatchSize = 16;
    private readonly IngestionOptions _options = options.Value;

    public Task<IngestionResult> IngestAsync(CancellationToken cancellationToken = default)
        => IngestAsync(_options.ForceReindex, cancellationToken);

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

    /// <summary>Builds a complete physical generation without publishing its logical alias.</summary>
    public async Task<IngestionBuildResult> BuildAsync(
        bool forceReindex,
        CancellationToken cancellationToken = default)
    {
        var sources = _options.Sources.Count > 0 ? _options.Sources : DocSourceCatalog.Default();

        var build = await vectorStore.BeginBuildAsync(_options.CollectionName, cancellationToken);
        var fileCount = 0;
        var chunkCount = 0;
        var buffer = new List<DocChunk>(EmbeddingBatchSize);
        try
        {
            await foreach (var raw in reader.ReadAllAsync(sources, cancellationToken))
            {
                fileCount++;

                var cleaned = MarkdownCleaner.Clean(raw.Raw);
                if (string.IsNullOrWhiteSpace(cleaned.Body))
                {
                    continue;
                }

                var title = !string.IsNullOrWhiteSpace(raw.Title)
                    ? raw.Title
                    : !string.IsNullOrWhiteSpace(cleaned.Title)
                        ? cleaned.Title
                        : DocSourceCatalog.TitleFromPath(raw.Path);

                var url = !string.IsNullOrWhiteSpace(raw.ResolvedUrl)
                    ? raw.ResolvedUrl
                    : DocSourceCatalog.BuildUrl(raw.Repo, raw.Branch, raw.Path, raw.UrlStyle);

                var source = new DocSource
                {
                    Repo = raw.Repo,
                    Path = raw.Path,
                    Title = title,
                    Url = url,
                    Revision = raw.Branch,
                };

                foreach (var chunk in chunker.Chunk(source, cleaned.Body))
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

            if (buffer.Count > 0)
            {
                await FlushAsync(buffer, build, cancellationToken);
            }

            if (fileCount == 0 || chunkCount == 0)
            {
                throw new InvalidOperationException(
                    $"The '{reader.ModeName}' source produced no indexable documentation; the current index was preserved.");
            }

            logger.LogInformation(
                "Documentation generation built: {Files} files, {Chunks} chunks via '{Mode}' mode.",
                fileCount, chunkCount, reader.ModeName);
            return new IngestionBuildResult(
                new IngestionResult(fileCount, chunkCount, reader.ModeName),
                build);
        }
        catch
        {
            await vectorStore.AbortBuildAsync(build, CancellationToken.None);
            throw;
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
        logger.LogDebug("Upserted batch of {Count} chunks.", chunks.Count);
    }
}
