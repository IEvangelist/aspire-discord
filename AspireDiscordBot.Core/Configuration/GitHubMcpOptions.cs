namespace AspireDiscordBot.Core.Configuration;

/// <summary>Configuration for the official GitHub MCP server used by live research tools.</summary>
public sealed class GitHubMcpOptions
{
    public const string SectionName = "GitHubMcp";

    public bool Enabled { get; set; } = true;

    public string Endpoint { get; set; } = "https://api.githubcopilot.com/mcp/";

    /// <summary>
    /// Optional GitHub access token. Prefer <c>GITHUB_MCP_TOKEN</c>, <c>GH_TOKEN</c>, or
    /// <c>GITHUB_TOKEN</c> rather than configuration files.
    /// </summary>
    public string? AccessToken { get; set; }

    public bool ReadOnly { get; set; } = true;

    public bool Lockdown { get; set; } = true;

    public int ConnectionTimeoutSeconds { get; set; } = 20;

    public int RetryCooldownSeconds { get; set; } = 300;

    public int MaxOutputChars { get; set; } = 12_000;

    public int ResultCacheSeconds { get; set; } = 120;

    public int MaxCacheEntries { get; set; } = 256;

    public List<string> Tools { get; set; } =
    [
        "search_code",
        "get_file_contents",
        "get_repository_tree",
        "get_commit",
        "search_issues",
        "issue_read",
        "search_pull_requests",
        "pull_request_read",
        "get_latest_release",
        "list_releases",
    ];

    public List<string> AllowedRepositories { get; set; } =
    [
        "microsoft/aspire",
        "microsoft/aspire.dev",
    ];
}
