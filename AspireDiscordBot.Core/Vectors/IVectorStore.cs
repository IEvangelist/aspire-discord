using AspireDiscordBot.Core.Documents;

namespace AspireDiscordBot.Core.Vectors;

/// <summary>A physical generation being built behind a logical vector index.</summary>
public sealed class VectorIndexBuild(
    string logicalCollection,
    string physicalCollection,
    string generation,
    DateTimeOffset startedUtc,
    string publicationGroup)
{
    public string LogicalCollection { get; } = logicalCollection;
    public string PhysicalCollection { get; } = physicalCollection;
    public string Generation { get; } = generation;
    public DateTimeOffset StartedUtc { get; } = startedUtc;
    public string PublicationGroup { get; } = publicationGroup;
    internal bool IsPublished { get; set; }
    internal bool RetainOnAbort { get; set; }
}

/// <summary>Stores versioned vector indexes and atomically publishes logical aliases.</summary>
public interface IVectorStore
{
    Task<VectorIndexBuild> BeginBuildAsync(
        string? collectionName = null,
        CancellationToken cancellationToken = default,
        string? publicationGroup = null);

    Task CommitBuildAsync(
        VectorIndexBuild build,
        CancellationToken cancellationToken = default);

    Task CommitBuildsAsync(
        IReadOnlyList<VectorIndexBuild> builds,
        CancellationToken cancellationToken = default);

    Task AbortBuildAsync(
        VectorIndexBuild build,
        CancellationToken cancellationToken = default);

    Task DeleteLogicalIndexAsync(
        string? collectionName = null,
        CancellationToken cancellationToken = default);

    Task<ulong> CountAsync(
        CancellationToken cancellationToken = default,
        string? collectionName = null);

    Task<bool> IsCompatibleAsync(
        string? collectionName = null,
        CancellationToken cancellationToken = default);

    Task<string?> GetPublicationGroupAsync(
        string collectionName,
        CancellationToken cancellationToken = default);

    Task UpsertAsync(
        IReadOnlyList<DocChunk> chunks,
        IReadOnlyList<float[]> embeddings,
        CancellationToken cancellationToken = default,
        string? collectionName = null,
        VectorIndexBuild? build = null);
}
