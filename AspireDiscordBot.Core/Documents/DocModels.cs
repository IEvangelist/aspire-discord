namespace AspireDiscordBot.Core.Documents;

/// <summary>Identifies a documentation file and how to cite it.</summary>
public sealed record DocSource
{
    /// <summary>e.g. <c>microsoft/aspire.dev</c>.</summary>
    public required string Repo { get; init; }

    /// <summary>Repo-relative path of the file.</summary>
    public required string Path { get; init; }

    /// <summary>Human-friendly title for citations.</summary>
    public required string Title { get; init; }

    /// <summary>Canonical URL used when citing this document.</summary>
    public required string Url { get; init; }

    /// <summary>Immutable source revision when available.</summary>
    public string? Revision { get; init; }
}

/// <summary>A retrievable slice of a documentation file.</summary>
public sealed record DocChunk
{
    /// <summary>Deterministic id (GUID string) derived from repo + path + index.</summary>
    public required string Id { get; init; }

    public required DocSource Source { get; init; }

    /// <summary>The chunk text (cleaned of markdown/MDX noise).</summary>
    public required string Content { get; init; }

    /// <summary>The nearest heading trail, if any (used to sharpen retrieval + citations).</summary>
    public string? Heading { get; init; }

    /// <summary>Zero-based position of this chunk within its file.</summary>
    public int Index { get; init; }
}

/// <summary>A cleaned document ready for chunking.</summary>
/// <param name="Title">Title extracted from frontmatter or the first heading.</param>
/// <param name="Body">Cleaned markdown body.</param>
public readonly record struct CleanedDocument(string? Title, string Body);
