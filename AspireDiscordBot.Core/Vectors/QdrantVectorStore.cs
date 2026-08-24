using AspireDiscordBot.Core.Configuration;
using AspireDiscordBot.Core.Documents;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Qdrant.Client;
using Qdrant.Client.Grpc;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace AspireDiscordBot.Core.Vectors;

/// <summary>A physical generation being built behind a logical collection alias.</summary>
public sealed class VectorIndexBuild(
    string logicalCollection,
    string physicalCollection,
    string generation,
    DateTimeOffset startedUtc)
{
    public string LogicalCollection { get; } = logicalCollection;
    public string PhysicalCollection { get; } = physicalCollection;
    public string Generation { get; } = generation;
    public DateTimeOffset StartedUtc { get; } = startedUtc;
    internal bool IsPublished { get; set; }
    internal bool RetainOnAbort { get; set; }
}

/// <summary>Stores and searches embedded documentation chunks in Qdrant.</summary>
public sealed partial class QdrantVectorStore(
    QdrantClient client,
    IOptions<IngestionOptions> ingestionOptions,
    IOptions<AiOptions> aiOptions,
    ILogger<QdrantVectorStore> logger)
{
    private readonly IngestionOptions _ingestion = ingestionOptions.Value;
    private readonly AiOptions _ai = aiOptions.Value;

    private string Collection => _ingestion.CollectionName;

    /// <summary>Creates an isolated physical collection for a complete new logical-index generation.</summary>
    public async Task<VectorIndexBuild> BeginBuildAsync(
        string? collectionName = null,
        CancellationToken cancellationToken = default)
    {
        var logical = collectionName ?? Collection;
        var generation = Guid.NewGuid().ToString("N");
        var safeLogical = CollectionNameRegex().Replace(logical, "_");
        var physical = $"{safeLogical}__{DateTimeOffset.UtcNow:yyyyMMddHHmmss}_{generation[..8]}";
        await client.CreateCollectionAsync(
            physical,
            new VectorParams { Size = (ulong)_ai.EmbeddingDimensions, Distance = Distance.Cosine },
            cancellationToken: cancellationToken);
        logger.LogInformation(
            "Created staging collection '{Physical}' for logical index '{Logical}'.",
            physical,
            logical);
        return new VectorIndexBuild(logical, physical, generation, DateTimeOffset.UtcNow);
    }

    /// <summary>
    /// Atomically moves the logical alias to a completed generation, then removes the old physical
    /// collection. A legacy physical collection is migrated after the replacement is fully built.
    /// </summary>
    public async Task CommitBuildAsync(
        VectorIndexBuild build,
        CancellationToken cancellationToken = default) =>
        await CommitBuildsAsync([build], cancellationToken);

    /// <summary>Publishes one or more logical indexes in a single alias transaction.</summary>
    public async Task CommitBuildsAsync(
        IReadOnlyList<VectorIndexBuild> builds,
        CancellationToken cancellationToken = default)
    {
        if (builds.Count == 0)
        {
            return;
        }

        var counts = new Dictionary<string, ulong>(StringComparer.Ordinal);
        foreach (var build in builds)
        {
            var count = await CountAsync(cancellationToken, build.PhysicalCollection);
            if (count == 0)
            {
                throw new InvalidOperationException(
                    $"Refusing to publish empty vector index generation '{build.PhysicalCollection}'.");
            }

            counts[build.PhysicalCollection] = count;
        }

        var aliases = await client.ListAliasesAsync(cancellationToken);
        var operations = new List<AliasOperations>();
        var operationBuilds = new List<VectorIndexBuild>();
        var previousCollections = new HashSet<string>(StringComparer.Ordinal);
        foreach (var build in builds)
        {
            var current = aliases.FirstOrDefault(alias =>
                string.Equals(alias.AliasName, build.LogicalCollection, StringComparison.Ordinal));
            if (current is not null)
            {
                previousCollections.Add(current.CollectionName);
                operations.Add(new AliasOperations
                {
                    DeleteAlias = new DeleteAlias { AliasName = build.LogicalCollection },
                });
                operations.Add(CreateAliasOperation(build));
                operationBuilds.Add(build);
            }
            else if (await client.CollectionExistsAsync(build.LogicalCollection, cancellationToken))
            {
                cancellationToken.ThrowIfCancellationRequested();
                await MigrateLegacyBuildAsync(build);
            }
            else
            {
                operations.Add(CreateAliasOperation(build));
                operationBuilds.Add(build);
            }
        }

        cancellationToken.ThrowIfCancellationRequested();
        if (operations.Count > 0)
        {
            try
            {
                // Alias publication is the commit point. Once started it must finish even if the
                // incoming request is cancelled.
                await client.UpdateAliasesAsync(
                    operations,
                    cancellationToken: CancellationToken.None);
            }
            catch (Exception ex)
            {
                if (!await AliasesPointToBuildsAsync(operationBuilds))
                {
                    throw;
                }

                logger.LogWarning(
                    ex,
                    "Qdrant committed the alias transaction but its response was lost; reconciled server state.");
            }

            foreach (var build in operationBuilds)
            {
                build.IsPublished = true;
                build.RetainOnAbort = true;
            }
        }

        foreach (var previous in previousCollections)
        {
            if (builds.Any(build =>
                    string.Equals(build.PhysicalCollection, previous, StringComparison.Ordinal)))
            {
                continue;
            }

            try
            {
                if (await client.CollectionExistsAsync(previous, CancellationToken.None))
                {
                    await client.DeleteCollectionAsync(previous, cancellationToken: CancellationToken.None);
                }
            }
            catch (Exception ex)
            {
                logger.LogWarning(
                    ex,
                    "Published new indexes but could not delete previous collection '{Collection}'.",
                    previous);
            }
        }

        foreach (var build in builds)
        {
            logger.LogInformation(
                "Published vector index generation '{Physical}' as '{Logical}' ({Count} points).",
                build.PhysicalCollection,
                build.LogicalCollection,
                counts[build.PhysicalCollection]);
        }
    }

    /// <summary>Deletes an unpublished staging generation.</summary>
    public async Task AbortBuildAsync(
        VectorIndexBuild build,
        CancellationToken cancellationToken = default)
    {
        if (build.IsPublished || build.RetainOnAbort)
        {
            logger.LogWarning(
                "Retaining vector generation '{Physical}' because it is published or required for migration recovery.",
                build.PhysicalCollection);
            return;
        }

        if (await client.CollectionExistsAsync(build.PhysicalCollection, cancellationToken))
        {
            await client.DeleteCollectionAsync(
                build.PhysicalCollection,
                cancellationToken: cancellationToken);
        }
    }

    /// <summary>Deletes a logical alias and its current physical collection, or a legacy collection.</summary>
    public async Task DeleteLogicalIndexAsync(
        string? collectionName = null,
        CancellationToken cancellationToken = default)
    {
        var logical = collectionName ?? Collection;
        var aliases = await client.ListAliasesAsync(cancellationToken);
        var alias = aliases.FirstOrDefault(item =>
            string.Equals(item.AliasName, logical, StringComparison.Ordinal));
        if (alias is not null)
        {
            await client.DeleteAliasAsync(logical, cancellationToken: cancellationToken);
            if (await client.CollectionExistsAsync(alias.CollectionName, cancellationToken))
            {
                await client.DeleteCollectionAsync(alias.CollectionName, cancellationToken: cancellationToken);
            }

            return;
        }

        if (await client.CollectionExistsAsync(logical, cancellationToken))
        {
            await client.DeleteCollectionAsync(logical, cancellationToken: cancellationToken);
        }
    }

    /// <summary>Ensures the collection exists. When <paramref name="recreate"/> is true it is dropped first.</summary>
    public async Task EnsureCollectionAsync(bool recreate, CancellationToken cancellationToken = default, string? collectionName = null)
    {
        var collection = collectionName ?? Collection;
        var exists = await client.CollectionExistsAsync(collection, cancellationToken);

        if (exists && recreate)
        {
            logger.LogInformation("Recreating Qdrant collection '{Collection}'.", collection);
            await client.DeleteCollectionAsync(collection, cancellationToken: cancellationToken);
            exists = false;
        }

        if (!exists)
        {
            await client.CreateCollectionAsync(
                collection,
                new VectorParams { Size = (ulong)_ai.EmbeddingDimensions, Distance = Distance.Cosine },
                cancellationToken: cancellationToken);
            logger.LogInformation(
                "Created Qdrant collection '{Collection}' ({Dimensions} dims, cosine).",
                collection, _ai.EmbeddingDimensions);
        }
    }

    /// <summary>Number of points currently stored.</summary>
    public async Task<ulong> CountAsync(CancellationToken cancellationToken = default, string? collectionName = null)
    {
        var collection = collectionName ?? Collection;
        if (!await IndexExistsAsync(collection, cancellationToken))
        {
            return 0;
        }

        return await client.CountAsync(collection, cancellationToken: cancellationToken);
    }

    /// <summary>Whether the given collection exists and has at least one point.</summary>
    public async Task<bool> IsPopulatedAsync(string collectionName, CancellationToken cancellationToken = default) =>
        await CountAsync(cancellationToken, collectionName) > 0;

    /// <summary>Whether a populated logical index matches the configured embedding contract.</summary>
    public async Task<bool> IsCompatibleAsync(
        string? collectionName = null,
        CancellationToken cancellationToken = default)
    {
        var collection = collectionName ?? Collection;
        if (!await IndexExistsAsync(collection, cancellationToken))
        {
            return false;
        }

        var info = await client.GetCollectionInfoAsync(collection, cancellationToken);
        if (info.Config.Params.VectorsConfig.Params.Size != (ulong)_ai.EmbeddingDimensions)
        {
            return false;
        }

        var page = await client.ScrollAsync(
            collection,
            limit: 1,
            payloadSelector: true,
            cancellationToken: cancellationToken);
        var point = page.Result.FirstOrDefault();
        if (point is null)
        {
            return false;
        }

        return string.Equals(
                   Payload(point, "embedding_provider"),
                   EffectiveEmbeddingProvider,
                   StringComparison.OrdinalIgnoreCase)
               && string.Equals(
                   Payload(point, "embedding_model"),
                   _ai.EmbeddingModel,
                   StringComparison.Ordinal)
               && Payload(point, "extractor_version") == "2";
    }

    /// <summary>Upserts a batch of chunks with their aligned embedding vectors.</summary>
    public async Task UpsertAsync(
        IReadOnlyList<DocChunk> chunks,
        IReadOnlyList<float[]> embeddings,
        CancellationToken cancellationToken = default,
        string? collectionName = null,
        VectorIndexBuild? build = null)
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
            point.Payload.Add("revision", chunk.Source.Revision ?? string.Empty);
            point.Payload.Add("chunk_index", chunk.Index);
            point.Payload.Add("content_hash", ContentHash(chunk.Content));
            point.Payload.Add("extractor_version", "2");
            point.Payload.Add("embedding_provider", EffectiveEmbeddingProvider);
            point.Payload.Add("embedding_model", _ai.EmbeddingModel);
            point.Payload.Add("embedding_dimensions", _ai.EmbeddingDimensions);
            if (build is not null)
            {
                point.Payload.Add("generation", build.Generation);
                point.Payload.Add("ingested_at", build.StartedUtc.ToString("O"));
            }

            points.Add(point);
        }

        await client.UpsertAsync(collectionName ?? Collection, points, cancellationToken: cancellationToken);
    }

    /// <summary>Returns the most similar chunks to the query vector, ordered by score descending.</summary>
    public async Task<IReadOnlyList<VectorSearchResult>> SearchAsync(
        float[] queryVector,
        int topK,
        CancellationToken cancellationToken = default,
        string? collectionName = null)
    {
#pragma warning disable CS0618 // SearchAsync is stable across Qdrant.Client versions.
        var points = await client.SearchAsync(
            collectionName ?? Collection,
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

    private static string Payload(RetrievedPoint point, string key) =>
        point.Payload.TryGetValue(key, out var value) ? value.StringValue : string.Empty;

    private string EffectiveEmbeddingProvider =>
        string.IsNullOrWhiteSpace(_ai.EmbeddingProvider)
            ? _ai.Provider
            : _ai.EmbeddingProvider;

    private async Task<bool> IndexExistsAsync(
        string collection,
        CancellationToken cancellationToken)
    {
        if (await client.CollectionExistsAsync(collection, cancellationToken))
        {
            return true;
        }

        var aliases = await client.ListAliasesAsync(cancellationToken);
        return aliases.Any(alias =>
            string.Equals(alias.AliasName, collection, StringComparison.Ordinal));
    }

    private async Task DeleteCollectionWithRetryAsync(string collection)
    {
        Exception? lastError = null;
        for (var attempt = 1; attempt <= 3; attempt++)
        {
            try
            {
                await client.DeleteCollectionAsync(
                    collection,
                    cancellationToken: CancellationToken.None);
                return;
            }
            catch (Exception ex)
            {
                lastError = ex;
                try
                {
                    if (!await client.CollectionExistsAsync(collection, CancellationToken.None))
                    {
                        return;
                    }
                }
                catch
                {
                    // Retry the original operation; state reconciliation is best-effort here.
                }

                if (attempt < 3)
                {
                    await Task.Delay(TimeSpan.FromMilliseconds(200 * attempt));
                }
            }
        }

        throw new InvalidOperationException(
            $"Unable to remove legacy collection '{collection}' during alias migration.",
            lastError);
    }

    private async Task MigrateLegacyBuildAsync(VectorIndexBuild build)
    {
        await DeleteCollectionWithRetryAsync(build.LogicalCollection);
        // The legacy name is now unavailable, so retain its complete replacement until an alias is
        // confirmed even if later work fails.
        build.RetainOnAbort = true;
        Exception? lastError = null;
        for (var attempt = 1; attempt <= 3; attempt++)
        {
            try
            {
                await client.CreateAliasAsync(
                    build.LogicalCollection,
                    build.PhysicalCollection,
                    cancellationToken: CancellationToken.None);
                build.IsPublished = true;
                return;
            }
            catch (Exception ex)
            {
                lastError = ex;
                if (await AliasPointsToBuildAsync(build))
                {
                    build.IsPublished = true;
                    return;
                }

                if (attempt < 3)
                {
                    await Task.Delay(TimeSpan.FromMilliseconds(200 * attempt));
                }
            }
        }

        throw new InvalidOperationException(
            $"Unable to create logical alias '{build.LogicalCollection}' during legacy migration. "
            + $"Recovery collection retained as '{build.PhysicalCollection}'.",
            lastError);
    }

    private async Task<bool> AliasesPointToBuildsAsync(IReadOnlyList<VectorIndexBuild> builds)
    {
        try
        {
            var aliases = await client.ListAliasesAsync(CancellationToken.None);
            return builds.All(build => aliases.Any(alias =>
                string.Equals(alias.AliasName, build.LogicalCollection, StringComparison.Ordinal)
                && string.Equals(alias.CollectionName, build.PhysicalCollection, StringComparison.Ordinal)));
        }
        catch
        {
            return false;
        }
    }

    private async Task<bool> AliasPointsToBuildAsync(VectorIndexBuild build) =>
        await AliasesPointToBuildsAsync([build]);

    private static AliasOperations CreateAliasOperation(VectorIndexBuild build) =>
        new()
        {
            CreateAlias = new CreateAlias
            {
                AliasName = build.LogicalCollection,
                CollectionName = build.PhysicalCollection,
            },
        };

    private static string ContentHash(string content) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(content))).ToLowerInvariant();

    [GeneratedRegex("[^A-Za-z0-9_-]")]
    private static partial Regex CollectionNameRegex();
}
