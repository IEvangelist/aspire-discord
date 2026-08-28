using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Azure;
using Azure.Core;
using Azure.Search.Documents;
using Azure.Search.Documents.Indexes;
using Azure.Search.Documents.Indexes.Models;
using Azure.Search.Documents.Models;
using AspireDiscordBot.Core.Configuration;
using AspireDiscordBot.Core.Documents;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace AspireDiscordBot.Core.Vectors;

/// <summary>Stores versioned vector generations in Azure AI Search behind logical aliases.</summary>
public sealed class AzureSearchVectorStore : IVectorStore
{
    private const string VectorFieldName = "contentVector";
    private const string VectorAlgorithmName = "hnsw";
    private const string VectorProfileName = "vector-profile";
    private const string ExtractorVersion = "2";

    private readonly AiOptions _ai;
    private readonly IngestionOptions _ingestion;
    private readonly VectorStoreOptions _options;
    private readonly TokenCredential _credential;
    private readonly SearchIndexClient _indexes;
    private readonly ILogger<AzureSearchVectorStore> _logger;

    public AzureSearchVectorStore(
        TokenCredential credential,
        IOptions<AiOptions> aiOptions,
        IOptions<IngestionOptions> ingestionOptions,
        IOptions<VectorStoreOptions> options,
        ILogger<AzureSearchVectorStore> logger)
    {
        _credential = credential;
        _ai = aiOptions.Value;
        _ingestion = ingestionOptions.Value;
        _options = options.Value;
        _logger = logger;
        _indexes = new SearchIndexClient(Endpoint, credential);
    }

    private Uri Endpoint =>
        Uri.TryCreate(_options.Endpoint, UriKind.Absolute, out var endpoint)
            ? endpoint
            : throw new InvalidOperationException(
                "Azure AI Search requires VectorStore:Endpoint.");

    public async Task<VectorIndexBuild> BeginBuildAsync(
        string? collectionName = null,
        CancellationToken cancellationToken = default,
        string? publicationGroup = null)
    {
        var logical = NormalizeName(collectionName ?? _ingestion.CollectionName);
        var generation = Guid.NewGuid().ToString("N");
        var physical = PhysicalName(logical, generation);
        await _indexes.CreateIndexAsync(CreateIndex(physical), cancellationToken);
        _logger.LogInformation(
            "Created Azure AI Search staging index '{Physical}' for logical index '{Logical}'.",
            physical,
            logical);
        return new VectorIndexBuild(
            logical,
            physical,
            generation,
            DateTimeOffset.UtcNow,
            publicationGroup ?? generation);
    }

    public Task CommitBuildAsync(
        VectorIndexBuild build,
        CancellationToken cancellationToken = default) =>
        CommitBuildsAsync([build], cancellationToken);

    public async Task CommitBuildsAsync(
        IReadOnlyList<VectorIndexBuild> builds,
        CancellationToken cancellationToken = default)
    {
        if (builds.Count == 0)
        {
            return;
        }

        var counts = new Dictionary<string, ulong>(StringComparer.Ordinal);
        var previous = new Dictionary<string, AliasState>(StringComparer.Ordinal);
        foreach (var build in builds)
        {
            var count = await CountAsync(cancellationToken, build.PhysicalCollection);
            if (count == 0)
            {
                throw new InvalidOperationException(
                    $"Refusing to publish empty Azure AI Search index '{build.PhysicalCollection}'.");
            }

            counts[build.PhysicalCollection] = count;
            previous[build.LogicalCollection] = await GetAliasStateAsync(
                build.LogicalCollection,
                cancellationToken);
        }

        var published = new List<VectorIndexBuild>();
        try
        {
            foreach (var build in builds)
            {
                cancellationToken.ThrowIfCancellationRequested();
                try
                {
                    await PublishAliasAsync(build, previous[build.LogicalCollection]);
                }
                catch (Exception ex)
                {
                    var actual = await GetAliasStateAsync(
                        build.LogicalCollection,
                        CancellationToken.None);
                    if (!string.Equals(
                        actual.Index,
                        build.PhysicalCollection,
                        StringComparison.Ordinal))
                    {
                        throw;
                    }
                    _logger.LogWarning(
                        ex,
                        "Azure AI Search committed alias '{Alias}', but its response was lost; reconciled service state.",
                        build.LogicalCollection);
                }
                build.IsPublished = true;
                build.RetainOnAbort = true;
                published.Add(build);
            }
        }
        catch
        {
            await RollbackAliasesAsync(published, previous);
            throw;
        }

        foreach (var build in builds)
        {
            _logger.LogInformation(
                "Published Azure AI Search generation '{Physical}' as '{Logical}' ({Count} documents).",
                build.PhysicalCollection,
                build.LogicalCollection,
                counts[build.PhysicalCollection]);
        }

        await PruneOldGenerationsAsync(builds, previous, CancellationToken.None);
    }

    public async Task AbortBuildAsync(
        VectorIndexBuild build,
        CancellationToken cancellationToken = default)
    {
        if (build.IsPublished || build.RetainOnAbort)
        {
            _logger.LogWarning(
                "Retaining Azure AI Search generation '{Physical}' because it is published.",
                build.PhysicalCollection);
            return;
        }

        if (await IndexExistsAsync(build.PhysicalCollection, cancellationToken))
        {
            await _indexes.DeleteIndexAsync(build.PhysicalCollection, cancellationToken);
        }
    }

    public async Task DeleteLogicalIndexAsync(
        string? collectionName = null,
        CancellationToken cancellationToken = default)
    {
        var logical = NormalizeName(collectionName ?? _ingestion.CollectionName);
        var aliasState = await GetAliasStateAsync(logical, cancellationToken);
        var physical = aliasState.Index;
        if (physical is null)
        {
            if (await IndexExistsAsync(logical, cancellationToken))
            {
                await _indexes.DeleteIndexAsync(logical, cancellationToken);
            }
        }
        else
        {
            await _indexes.DeleteAliasAsync(
                aliasState.Alias!,
                onlyIfUnchanged: true,
                cancellationToken);
        }

        var prefix = $"{logical}-";
        var indexesToDelete = new List<string>();
        await foreach (var name in _indexes.GetIndexNamesAsync(cancellationToken))
        {
            if (string.Equals(name, physical, StringComparison.Ordinal)
                || name.StartsWith(prefix, StringComparison.Ordinal))
            {
                indexesToDelete.Add(name);
            }
        }
        foreach (var name in indexesToDelete)
        {
            await _indexes.DeleteIndexAsync(name, cancellationToken);
        }
    }

    public async Task<ulong> CountAsync(
        CancellationToken cancellationToken = default,
        string? collectionName = null)
    {
        var name = NormalizeName(collectionName ?? _ingestion.CollectionName);
        try
        {
            var count = await Client(name).GetDocumentCountAsync(cancellationToken);
            return checked((ulong)count.Value);
        }
        catch (RequestFailedException ex) when (ex.Status == 404)
        {
            return 0;
        }
    }

    public async Task<bool> IsCompatibleAsync(
        string? collectionName = null,
        CancellationToken cancellationToken = default)
    {
        var name = NormalizeName(collectionName ?? _ingestion.CollectionName);
        SearchIndex index;
        try
        {
            index = (await _indexes.GetIndexAsync(name, cancellationToken)).Value;
        }
        catch (RequestFailedException ex) when (ex.Status == 404)
        {
            return false;
        }

        var vector = index.Fields.FirstOrDefault(field =>
            string.Equals(field.Name, VectorFieldName, StringComparison.Ordinal));
        if (vector?.VectorSearchDimensions != _ai.EmbeddingDimensions)
        {
            return false;
        }

        if (!TryReadMetadata(index.Description, out var metadata)
            || !string.Equals(
                metadata.EmbeddingProvider,
                EffectiveEmbeddingProvider,
                StringComparison.OrdinalIgnoreCase)
            || !string.Equals(metadata.EmbeddingModel, _ai.EmbeddingModel, StringComparison.Ordinal)
            || metadata.EmbeddingDimensions != _ai.EmbeddingDimensions
            || metadata.ExtractorVersion != ExtractorVersion)
        {
            return false;
        }

        return await CountAsync(cancellationToken, name) > 0;
    }

    public async Task<string?> GetPublicationGroupAsync(
        string collectionName,
        CancellationToken cancellationToken = default)
    {
        var options = new SearchOptions { Size = 1 };
        options.Select.Add("publicationGroup");
        try
        {
            var response = await Client(collectionName).SearchAsync<SearchDocument>(
                options,
                cancellationToken);
            await foreach (var result in response.Value.GetResultsAsync())
            {
                return Value(result.Document, "publicationGroup");
            }
            return null;
        }
        catch (RequestFailedException ex) when (ex.Status == 404)
        {
            return null;
        }
    }

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

        var documents = new List<SearchDocument>(chunks.Count);
        for (var i = 0; i < chunks.Count; i++)
        {
            if (embeddings[i].Length != _ai.EmbeddingDimensions)
            {
                throw new InvalidOperationException(
                    $"Embedding vector has {embeddings[i].Length} dimensions; expected {_ai.EmbeddingDimensions}.");
            }

            var chunk = chunks[i];
            documents.Add(new SearchDocument
            {
                ["id"] = chunk.Id,
                ["content"] = chunk.Content,
                ["heading"] = chunk.Heading ?? string.Empty,
                ["title"] = chunk.Source.Title,
                ["url"] = chunk.Source.Url,
                ["repo"] = chunk.Source.Repo,
                ["path"] = chunk.Source.Path,
                ["revision"] = chunk.Source.Revision ?? string.Empty,
                ["chunkIndex"] = chunk.Index,
                ["contentHash"] = ContentHash(chunk.Content),
                ["extractorVersion"] = ExtractorVersion,
                ["embeddingProvider"] = EffectiveEmbeddingProvider,
                ["embeddingModel"] = _ai.EmbeddingModel,
                ["embeddingDimensions"] = _ai.EmbeddingDimensions,
                ["generation"] = build?.Generation ?? string.Empty,
                ["publicationGroup"] = build?.PublicationGroup ?? string.Empty,
                ["ingestedAt"] = build?.StartedUtc ?? DateTimeOffset.UtcNow,
                [VectorFieldName] = embeddings[i],
            });
        }

        var name = NormalizeName(collectionName ?? _ingestion.CollectionName);
        await Client(name).UploadDocumentsAsync(
            documents,
            new IndexDocumentsOptions { ThrowOnAnyError = true },
            cancellationToken);
    }

    /// <summary>Returns vector-nearest documents with scores normalized back to cosine similarity.</summary>
    public async Task<IReadOnlyList<VectorSearchResult>> SearchAsync(
        float[] queryVector,
        int topK,
        CancellationToken cancellationToken = default,
        string? collectionName = null)
    {
        var name = NormalizeName(collectionName ?? _ingestion.CollectionName);
        var query = new VectorizedQuery(queryVector)
        {
            KNearestNeighborsCount = Math.Max(1, topK),
        };
        query.Fields.Add(VectorFieldName);
        var options = new SearchOptions
        {
            Size = Math.Max(1, topK),
            VectorSearch = new VectorSearchOptions(),
        };
        options.Select.Add("content");
        options.Select.Add("heading");
        options.Select.Add("title");
        options.Select.Add("url");
        options.Select.Add("repo");
        options.Select.Add("path");
        options.VectorSearch.Queries.Add(query);

        var response = await Client(name).SearchAsync<SearchDocument>(
            options,
            cancellationToken);
        var results = new List<VectorSearchResult>();
        await foreach (var result in response.Value.GetResultsAsync())
        {
            results.Add(new VectorSearchResult(
                Score: AzureScoreToCosineSimilarity(result.Score ?? 0),
                Content: Value(result.Document, "content"),
                Title: Value(result.Document, "title"),
                Url: Value(result.Document, "url"),
                Repo: Value(result.Document, "repo"),
                Path: Value(result.Document, "path"),
                Heading: Value(result.Document, "heading") is { Length: > 0 } heading
                    ? heading
                    : null));
        }
        return results;
    }

    private SearchIndex CreateIndex(string name)
    {
        var fields = new SearchField[]
        {
            new SimpleField("id", SearchFieldDataType.String)
            {
                IsKey = true,
                IsFilterable = true,
            },
            new SearchableField("content"),
            new SearchableField("heading"),
            new SearchableField("title"),
            new SimpleField("url", SearchFieldDataType.String),
            new SimpleField("repo", SearchFieldDataType.String) { IsFilterable = true },
            new SimpleField("path", SearchFieldDataType.String) { IsFilterable = true },
            new SimpleField("revision", SearchFieldDataType.String) { IsFilterable = true },
            new SimpleField("chunkIndex", SearchFieldDataType.Int32),
            new SimpleField("contentHash", SearchFieldDataType.String),
            new SimpleField("extractorVersion", SearchFieldDataType.String) { IsFilterable = true },
            new SimpleField("embeddingProvider", SearchFieldDataType.String) { IsFilterable = true },
            new SimpleField("embeddingModel", SearchFieldDataType.String) { IsFilterable = true },
            new SimpleField("embeddingDimensions", SearchFieldDataType.Int32) { IsFilterable = true },
            new SimpleField("generation", SearchFieldDataType.String) { IsFilterable = true },
            new SimpleField("publicationGroup", SearchFieldDataType.String) { IsFilterable = true },
            new SimpleField("ingestedAt", SearchFieldDataType.DateTimeOffset),
            new VectorSearchField(VectorFieldName, _ai.EmbeddingDimensions, VectorProfileName)
            {
                IsHidden = true,
                IsStored = false,
            },
        };
        var algorithm = new HnswAlgorithmConfiguration(VectorAlgorithmName)
        {
            Parameters = new HnswParameters
            {
                Metric = VectorSearchAlgorithmMetric.Cosine,
            },
        };
        var vectorSearch = new VectorSearch();
        vectorSearch.Algorithms.Add(algorithm);
        vectorSearch.Profiles.Add(new VectorSearchProfile(VectorProfileName, VectorAlgorithmName));

        return new SearchIndex(name, fields)
        {
            Description = JsonSerializer.Serialize(new IndexMetadata(
                EffectiveEmbeddingProvider,
                _ai.EmbeddingModel,
                _ai.EmbeddingDimensions,
                ExtractorVersion)),
            VectorSearch = vectorSearch,
        };
    }

    private SearchClient Client(string indexName) =>
        new(Endpoint, NormalizeName(indexName), _credential);

    private async Task<AliasState> GetAliasStateAsync(
        string aliasName,
        CancellationToken cancellationToken)
    {
        try
        {
            var alias = (await _indexes.GetAliasAsync(
                NormalizeName(aliasName),
                cancellationToken)).Value;
            return new AliasState(alias, alias.Indexes.SingleOrDefault());
        }
        catch (RequestFailedException ex) when (ex.Status == 404)
        {
            return new AliasState(null, null);
        }
    }

    private async Task PublishAliasAsync(VectorIndexBuild build, AliasState previous)
    {
        if (previous.Alias is null)
        {
            await _indexes.CreateAliasAsync(
                new SearchAlias(build.LogicalCollection, build.PhysicalCollection),
                CancellationToken.None);
            return;
        }

        previous.Alias.Indexes.Clear();
        previous.Alias.Indexes.Add(build.PhysicalCollection);
        await _indexes.CreateOrUpdateAliasAsync(
            previous.Alias,
            onlyIfUnchanged: true,
            CancellationToken.None);
    }

    private async Task<bool> IndexExistsAsync(
        string indexName,
        CancellationToken cancellationToken)
    {
        try
        {
            await _indexes.GetIndexAsync(NormalizeName(indexName), cancellationToken);
            return true;
        }
        catch (RequestFailedException ex) when (ex.Status == 404)
        {
            return false;
        }
    }

    private async Task RollbackAliasesAsync(
        IReadOnlyList<VectorIndexBuild> published,
        IReadOnlyDictionary<string, AliasState> previous)
    {
        foreach (var build in published.Reverse())
        {
            try
            {
                var current = await GetAliasStateAsync(
                    build.LogicalCollection,
                    CancellationToken.None);
                if (!string.Equals(
                    current.Index,
                    build.PhysicalCollection,
                    StringComparison.Ordinal))
                {
                    _logger.LogWarning(
                        "Not rolling back alias '{Alias}' because another publisher changed it.",
                        build.LogicalCollection);
                    build.RetainOnAbort = true;
                    continue;
                }

                if (previous[build.LogicalCollection].Index is { } previousIndex)
                {
                    current.Alias!.Indexes.Clear();
                    current.Alias.Indexes.Add(previousIndex);
                    await _indexes.CreateOrUpdateAliasAsync(
                        current.Alias,
                        onlyIfUnchanged: true,
                        CancellationToken.None);
                }
                else
                {
                    await _indexes.DeleteAliasAsync(
                        current.Alias!,
                        onlyIfUnchanged: true,
                        CancellationToken.None);
                }
                build.IsPublished = false;
                build.RetainOnAbort = true;
            }
            catch (Exception ex)
            {
                _logger.LogError(
                    ex,
                    "Failed to roll back Azure AI Search alias '{Alias}'.",
                    build.LogicalCollection);
            }
        }
    }

    private async Task PruneOldGenerationsAsync(
        IReadOnlyList<VectorIndexBuild> builds,
        IReadOnlyDictionary<string, AliasState> previous,
        CancellationToken cancellationToken)
    {
        var retention = Math.Max(2, _options.GenerationRetention);
        var allNames = new List<string>();
        await foreach (var name in _indexes.GetIndexNamesAsync(cancellationToken))
        {
            allNames.Add(name);
        }

        foreach (var logical in builds.Select(build => build.LogicalCollection).Distinct())
        {
            var prefix = $"{NormalizeName(logical)}-";
            var protectedIndexes = new HashSet<string>(StringComparer.Ordinal);
            foreach (var current in builds.Where(build =>
                         string.Equals(build.LogicalCollection, logical, StringComparison.Ordinal)))
            {
                protectedIndexes.Add(current.PhysicalCollection);
            }
            if (previous[logical].Index is { } previousIndex)
            {
                protectedIndexes.Add(previousIndex);
            }

            var candidates = allNames
                .Where(name => name.StartsWith(prefix, StringComparison.Ordinal))
                .OrderByDescending(name => name, StringComparer.Ordinal)
                .ToArray();
            var additionalToKeep = Math.Max(0, retention - protectedIndexes.Count);
            foreach (var additional in candidates
                         .Where(name => !protectedIndexes.Contains(name))
                         .Take(additionalToKeep))
            {
                protectedIndexes.Add(additional);
            }
            var obsolete = candidates
                .Where(name => !protectedIndexes.Contains(name))
                .ToArray();
            foreach (var index in obsolete)
            {
                try
                {
                    await _indexes.DeleteIndexAsync(index, cancellationToken);
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(
                        ex,
                        "Could not prune old Azure AI Search index '{Index}'.",
                        index);
                }
            }
        }
    }

    private static float AzureScoreToCosineSimilarity(double score)
    {
        if (!double.IsFinite(score) || score <= 0)
        {
            return -1;
        }
        return (float)Math.Clamp(2 - (1 / score), -1, 1);
    }

    private static string Value(SearchDocument document, string key) =>
        document.TryGetValue(key, out var value)
            ? Convert.ToString(value, System.Globalization.CultureInfo.InvariantCulture) ?? string.Empty
            : string.Empty;

    private string EffectiveEmbeddingProvider =>
        string.IsNullOrWhiteSpace(_ai.EmbeddingProvider)
            ? _ai.Provider
            : _ai.EmbeddingProvider;

    private static bool TryReadMetadata(string? description, out IndexMetadata metadata)
    {
        try
        {
            metadata = JsonSerializer.Deserialize<IndexMetadata>(description ?? string.Empty)
                ?? new IndexMetadata(string.Empty, string.Empty, 0, string.Empty);
            return true;
        }
        catch (JsonException)
        {
            metadata = new IndexMetadata(string.Empty, string.Empty, 0, string.Empty);
            return false;
        }
    }

    private static string PhysicalName(string logical, string generation)
    {
        var timestamp = DateTimeOffset.UtcNow.ToString("yyyyMMddHHmmss");
        return $"{logical}-{timestamp}-{generation[..8]}";
    }

    private static string NormalizeName(string value)
    {
        var normalized = new string(value
            .ToLowerInvariant()
            .Select(character =>
                char.IsAsciiLetterOrDigit(character) || character == '-' ? character : '-')
            .ToArray())
            .Trim('-');
        if (string.IsNullOrEmpty(normalized))
        {
            throw new InvalidOperationException("Azure AI Search index names cannot be empty.");
        }
        return normalized.Length <= 100 ? normalized : normalized[..100].TrimEnd('-');
    }

    private static string ContentHash(string content) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(content))).ToLowerInvariant();

    private sealed record IndexMetadata(
        string EmbeddingProvider,
        string EmbeddingModel,
        int EmbeddingDimensions,
        string ExtractorVersion);

    private sealed record AliasState(SearchAlias? Alias, string? Index);
}
