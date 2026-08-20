namespace AspireDiscordBot.Core.Configuration;

/// <summary>
/// Live GitHub search over microsoft/aspire: code search (real source, latest branch) and
/// issue/PR search (maintainer + community guidance that never makes it into the docs). Exposed to
/// the agent via the <c>search_code</c> and <c>search_issues</c> tools. Requires a GitHub token for
/// meaningful rate limits (the Search API rejects unauthenticated requests).
/// </summary>
public sealed class LiveSearchOptions
{
    public const string SectionName = "LiveSearch";

    /// <summary>Master switch. When false, the live GitHub tools aren't offered.</summary>
    public bool Enabled { get; set; } = true;

    /// <summary>
    /// GitHub token used for search. Falls back to the <c>GITHUB_TOKEN</c> environment variable.
    /// When neither is set, live search is disabled (unauthenticated search is rejected/throttled).
    /// </summary>
    public string? GitHubToken { get; set; }

    /// <summary>Repository searched (owner/name).</summary>
    public string Repo { get; set; } = "microsoft/aspire";

    /// <summary>Max results returned per search call.</summary>
    public int MaxResults { get; set; } = 5;

    /// <summary>
    /// For each returned issue/PR, include up to this many comments authored by maintainers
    /// (OWNER/MEMBER/COLLABORATOR) so their guidance surfaces directly. 0 disables comment fetching.
    /// </summary>
    public int MaintainerCommentsPerIssue { get; set; } = 2;
}
