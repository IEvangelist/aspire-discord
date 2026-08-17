namespace AspireDiscordBot.Core.Configuration;

/// <summary>Controls where documentation is ingested from and how it is chunked.</summary>
public sealed class IngestionOptions
{
    public const string SectionName = "Ingestion";

    /// <summary>Source mode: <c>github</c> (source of truth, always fresh) or <c>local</c> (on-disk clones).</summary>
    public string SourceMode { get; set; } = "github";

    /// <summary>Optional GitHub token to raise API rate limits (used in <c>github</c> mode).</summary>
    public string? GitHubToken { get; set; }

    /// <summary>Qdrant collection that stores the embedded chunks.</summary>
    public string CollectionName { get; set; } = "aspire_docs";

    /// <summary>Target chunk size in characters.</summary>
    public int MaxChunkChars { get; set; } = 1200;

    /// <summary>Overlap between consecutive chunks in characters.</summary>
    public int ChunkOverlapChars { get; set; } = 150;

    /// <summary>Re-embed and upsert everything on startup even if the collection already exists.</summary>
    public bool ForceReindex { get; set; }

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
