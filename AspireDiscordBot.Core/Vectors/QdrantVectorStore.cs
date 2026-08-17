using AspireDiscordBot.Core.Configuration;
using AspireDiscordBot.Core.Documents;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Qdrant.Client;
using Qdrant.Client.Grpc;

namespace AspireDiscordBot.Core.Vectors;

/// <summary>Stores and searches embedded documentation chunks in Qdrant.</summary>
public sealed class QdrantVectorStore(
    QdrantClient client,
    IOptions<IngestionOptions> ingestionOptions,
    IOptions<AiOptions> aiOptions,
    ILogger<QdrantVectorStore> logger)
{
    private readonly IngestionOptions _ingestion = ingestionOptions.Value;
    private readonly AiOptions _ai = aiOptions.Value;

    private string Collection => _ingestion.CollectionName;

    /// <summary>Ensures the collection exists. When <paramref name="recreate"/> is true it is dropped first.</summary>
    public async Task EnsureCollectionAsync(bool recreate, CancellationToken cancellationToken = default)
    {
        var exists = await client.CollectionExistsAsync(Collection, cancellationToken);

        if (exists && recreate)
        {
            logger.LogInformation("Recreating Qdrant collection '{Collection}'.", Collection);
            await client.DeleteCollectionAsync(Collection, cancellationToken: cancellationToken);
            exists = false;
        }

        if (!exists)
        {
            await client.CreateCollectionAsync(
                Collection,
                new VectorParams { Size = (ulong)_ai.EmbeddingDimensions, Distance = Distance.Cosine },
                cancellationToken: cancellationToken);
            logger.LogInformation(
                "Created Qdrant collection '{Collection}' ({Dimensions} dims, cosine).",
                Collection, _ai.EmbeddingDimensions);
        }
    }

    /// <summary>Number of points currently stored.</summary>
    public async Task<ulong> CountAsync(CancellationToken cancellationToken = default)
    {
        if (!await client.CollectionExistsAsync(Collection, cancellationToken))
        {
            return 0;
        }

        return await client.CountAsync(Collection, cancellationToken: cancellationToken);
    }

    /// <summary>Upserts a batch of chunks with their aligned embedding vectors.</summary>
    public async Task UpsertAsync(
        IReadOnlyList<DocChunk> chunks,
        IReadOnlyList<float[]> embeddings,
        CancellationToken cancellationToken = default)
    {
        if (chunks.Count != embeddings.Count)
        {
            throw new ArgumentException("Chunk and embedding counts must match.");
        }

        if (chunks.Count == 0)
        {
            return;
        }

        var points = new List<PointStruct>(chunks.Count);
        for (var i = 0; i < chunks.Count; i++)
        {
            var chunk = chunks[i];
            var point = new PointStruct
            {
                Id = Guid.Parse(chunk.Id),
                Vectors = embeddings[i],
            };

            point.Payload.Add("content", chunk.Content);
            point.Payload.Add("heading", chunk.Heading ?? string.Empty);
            point.Payload.Add("title", chunk.Source.Title);
            point.Payload.Add("url", chunk.Source.Url);
            point.Payload.Add("repo", chunk.Source.Repo);
            point.Payload.Add("path", chunk.Source.Path);

            points.Add(point);
        }

        await client.UpsertAsync(Collection, points, cancellationToken: cancellationToken);
    }

    /// <summary>Returns the most similar chunks to the query vector, ordered by score descending.</summary>
    public async Task<IReadOnlyList<VectorSearchResult>> SearchAsync(
        float[] queryVector,
        int topK,
        CancellationToken cancellationToken = default)
    {
#pragma warning disable CS0618 // SearchAsync is stable across Qdrant.Client versions.
        var points = await client.SearchAsync(
            Collection,
            queryVector,
            limit: (ulong)Math.Max(1, topK),
            payloadSelector: true,
            cancellationToken: cancellationToken);
#pragma warning restore CS0618

        return points
            .Select(p => new VectorSearchResult(
                Score: p.Score,
                Content: Payload(p, "content"),
                Title: Payload(p, "title"),
                Url: Payload(p, "url"),
                Repo: Payload(p, "repo"),
                Path: Payload(p, "path"),
                Heading: Payload(p, "heading") is { Length: > 0 } h ? h : null))
            .ToList();
    }

    private static string Payload(ScoredPoint point, string key) =>
        point.Payload.TryGetValue(key, out var value) ? value.StringValue : string.Empty;
}
