namespace AspireDiscordBot.Core.Configuration;

/// <summary>Controls where documentation is ingested from and how it is chunked.</summary>
public sealed class IngestionOptions
{
    public const string SectionName = "Ingestion";

    /// <summary>Source mode: <c>cli</c> (Aspire CLI docs — default), <c>github</c>, or <c>local</c> (on-disk clones).</summary>
    public string SourceMode { get; set; } = "cli";

    /// <summary>Optional GitHub token to raise API rate limits (used in <c>github</c> mode).</summary>
    public string? GitHubToken { get; set; }

    /// <summary>Settings for the <c>cli</c> source mode.</summary>
    public AspireCliOptions Cli { get; set; } = new();

    /// <summary>Qdrant collection that stores the embedded chunks.</summary>
    public string CollectionName { get; set; } = "aspire_docs";

    /// <summary>Target chunk size in characters.</summary>
    public int MaxChunkChars { get; set; } = 1200;

    /// <summary>Overlap between consecutive chunks in characters.</summary>
    public int ChunkOverlapChars { get; set; } = 150;

    /// <summary>Re-embed and upsert everything on startup even if the collection already exists.</summary>
    public bool ForceReindex { get; set; }

    /// <summary>
    /// When true, the startup ingest is skipped if the Qdrant collection is already populated
    /// (fast restarts). Refreshes then happen on the schedule or via the dashboard command.
    /// Ignored when <see cref="ForceReindex"/> is true.
    /// </summary>
    public bool SkipStartupIngestWhenPopulated { get; set; } = true;

    /// <summary>
    /// Interval, in hours, for the automatic background refresh. Set to 0 to disable the
    /// scheduled refresh (manual re-ingest via the dashboard command still works).
    /// </summary>
    public double RefreshIntervalHours { get; set; }

    /// <summary>The documentation sources to ingest. Defaults are provided in <c>DocSourceCatalog</c>.</summary>
    public List<DocRepoOptions> Sources { get; set; } = [];
}

/// <summary>Describes a single repository (and the subset of it) to ingest.</summary>
public sealed class DocRepoOptions
{
    /// <summary>e.g. <c>microsoft/aspire.dev</c>.</summary>
    public required string Repo { get; set; }

    public string Branch { get; set; } = "main";

    /// <summary>Local clone root used when <c>SourceMode = local</c>.</summary>
    public string? LocalPath { get; set; }

    /// <summary>Repo-relative path prefixes to include (e.g. <c>src/frontend/src/content/docs/</c>).</summary>
    public List<string> IncludePrefixes { get; set; } = [];

    /// <summary>File extensions to include.</summary>
    public List<string> Extensions { get; set; } = [".md", ".mdx"];

    /// <summary>How to turn a repo-relative path into a citation URL: <c>aspiredev</c> or <c>github</c>.</summary>
    public string UrlStyle { get; set; } = "github";
}

/// <summary>
/// Settings for the <c>cli</c> source mode, which ingests the published Aspire documentation
/// via the <c>aspire docs</c> CLI (the authoritative source of truth) instead of scraping repo
/// files. Deep-link citation URLs are resolved by matching each page's title to the aspire.dev
/// repo's documentation files (the CLI itself exposes no page URL).
/// </summary>
public sealed class AspireCliOptions
{
    /// <summary>The Aspire CLI executable (on PATH by default).</summary>
    public string Executable { get; set; } = "aspire";

    /// <summary>How many <c>aspire docs get</c> calls to run concurrently.</summary>
    public int MaxConcurrency { get; set; } = 6;

    /// <summary>Per-invocation timeout for a CLI call, in seconds.</summary>
    public int CommandTimeoutSeconds { get; set; } = 60;

    /// <summary>
    /// When true, build a title → canonical-URL index from the aspire.dev repo so citations link
    /// to the exact page. When false, citations use a site-search fallback link.
    /// </summary>
    public bool ResolveDeepLinks { get; set; } = true;

    /// <summary>The aspire.dev docs repository used to resolve deep-link URLs.</summary>
    public string AspireDevRepo { get; set; } = "microsoft/aspire.dev";

    /// <summary>Branch of the aspire.dev repo used for deep-link resolution.</summary>
    public string AspireDevBranch { get; set; } = "main";

    /// <summary>
    /// Optional local clone of the aspire.dev repo. When set, deep-link resolution reads titles
    /// from disk (instant) instead of GitHub. Falls back to GitHub when null.
    /// </summary>
    public string? AspireDevLocalPath { get; set; }

    /// <summary>Base site URL, used to build a fallback citation URL when a page can't be resolved.</summary>
    public string SiteBaseUrl { get; set; } = "https://aspire.dev";

    /// <summary>Repository label attributed to CLI-sourced docs (for citations).</summary>
    public string RepoLabel { get; set; } = "microsoft/aspire.dev";
}
