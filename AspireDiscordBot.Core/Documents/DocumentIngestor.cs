using AspireDiscordBot.Core.Ai;
using AspireDiscordBot.Core.Configuration;
using AspireDiscordBot.Core.Vectors;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace AspireDiscordBot.Core.Documents;

/// <summary>Summary statistics for an ingestion run.</summary>
public sealed record IngestionResult(int Files, int Chunks, string Mode);

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

    /// <param name="forceReindex">When true, the collection is dropped and rebuilt from scratch.</param>
    public async Task<IngestionResult> IngestAsync(bool forceReindex, CancellationToken cancellationToken = default)
    {
        var sources = _options.Sources.Count > 0 ? _options.Sources : DocSourceCatalog.Default();

        await vectorStore.EnsureCollectionAsync(recreate: forceReindex, cancellationToken);

        var fileCount = 0;
        var chunkCount = 0;
        var buffer = new List<DocChunk>(EmbeddingBatchSize);

        await foreach (var raw in reader.ReadAllAsync(sources, cancellationToken))
        {
            fileCount++;

            var cleaned = MarkdownCleaner.Clean(raw.Raw);
            if (string.IsNullOrWhiteSpace(cleaned.Body))
            {
                continue;
            }

            var title = !string.IsNullOrWhiteSpace(raw.Title)
                ? raw.Title!
                : !string.IsNullOrWhiteSpace(cleaned.Title)
                    ? cleaned.Title!
                    : DocSourceCatalog.TitleFromPath(raw.Path);

            var url = !string.IsNullOrWhiteSpace(raw.ResolvedUrl)
                ? raw.ResolvedUrl!
                : DocSourceCatalog.BuildUrl(raw.Repo, raw.Branch, raw.Path, raw.UrlStyle);

            var source = new DocSource
            {
                Repo = raw.Repo,
                Path = raw.Path,
                Title = title,
                Url = url,
            };

            foreach (var chunk in chunker.Chunk(source, cleaned.Body))
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

        if (buffer.Count > 0)
        {
            await FlushAsync(buffer, cancellationToken);
        }

        logger.LogInformation(
            "Ingestion complete: {Files} files, {Chunks} chunks via '{Mode}' mode.",
            fileCount, chunkCount, reader.ModeName);

        return new IngestionResult(fileCount, chunkCount, reader.ModeName);
    }

    private async Task FlushAsync(List<DocChunk> chunks, CancellationToken cancellationToken)
    {
        var inputs = chunks.Select(c => c.Content).ToList();
        var embeddings = await embeddingModel.EmbedAsync(inputs, cancellationToken);
        await vectorStore.UpsertAsync(chunks, embeddings, cancellationToken);
        logger.LogDebug("Upserted batch of {Count} chunks.", chunks.Count);
    }
}
