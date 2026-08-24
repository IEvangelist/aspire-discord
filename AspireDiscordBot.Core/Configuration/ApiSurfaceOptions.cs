namespace AspireDiscordBot.Core.Configuration;

/// <summary>
/// Optional ingestion of the microsoft/aspire public API surface (types + XML docs) parsed from an
/// immutable managed Git snapshot or explicit local checkout. Stored in a separate Qdrant index and exposed to the agent via the
/// <c>search_api</c> tool, so questions about real APIs (types, method signatures) can be answered
/// from the code itself, not just prose docs.
/// </summary>
public sealed class ApiSurfaceOptions
{
    public const string SectionName = "ApiSurface";

    /// <summary>Enables API-surface ingestion and retrieval.</summary>
    public bool Enabled { get; set; }

    /// <summary>
    /// Optional path to a local microsoft/aspire checkout or <c>src</c> directory. When omitted,
    /// enabled ingestion uses the managed repository snapshot.
    /// </summary>
    public string? LocalSrcPath { get; set; }

    /// <summary>Repository cloned into the managed snapshot cache when no local path is supplied.</summary>
    public string RepositoryUrl { get; set; } = "https://github.com/microsoft/aspire.git";

    /// <summary>Branch, tag, or commit resolved and pinned for each ingestion run.</summary>
    public string SourceRef { get; set; } = "main";

    /// <summary>Optional managed Git cache root.</summary>
    public string? CachePath { get; set; }

    public string GitExecutable { get; set; } = "git";

    public int GitCommandTimeoutSeconds { get; set; } = 300;

    /// <summary>Number of immutable exported snapshots retained locally.</summary>
    public int SnapshotRetention { get; set; } = 3;

    /// <summary>Qdrant collection storing the embedded API surface chunks.</summary>
    public string CollectionName { get; set; } = "aspire_api";

    /// <summary>
    /// Directory-name prefixes (under <c>src</c>) to include. Defaults to the hosting + core surface
    /// most questions target. Empty means include everything under <c>src</c>.
    /// </summary>
    public List<string> IncludeProjectPrefixes { get; set; } = ["Aspire.Hosting"];

    /// <summary>Canonical repo used for citation links (not the local clone's fork remote).</summary>
    public string CitationRepo { get; set; } = "microsoft/aspire";

    /// <summary>Fallback citation ref when an explicit local directory is not a Git checkout.</summary>
    public string CitationBranch { get; set; } = "main";
}
