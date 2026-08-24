using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using AspireDiscordBot.Core.Configuration;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace AspireDiscordBot.Core.Documents;

/// <summary>A single live GitHub search result, formatted for the agent.</summary>
public sealed record LiveSearchResult(string Title, string Url, string Repo, string Content);

/// <summary>
/// Live search over the microsoft/aspire GitHub repository: code search (authoritative source on the
/// default branch) and issue/PR search (maintainer + community guidance). Issue results optionally
/// include maintainer comments so answers that live only in issue threads surface directly.
/// </summary>
public sealed class GitHubLiveSearch(
    IHttpClientFactory httpFactory,
    IOptions<LiveSearchOptions> options,
    ILogger<GitHubLiveSearch> logger)
{
    private const string ApiBase = "https://api.github.com";
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private readonly LiveSearchOptions _options = options.Value;

    private string? Token =>
        !string.IsNullOrWhiteSpace(_options.GitHubToken)
            ? _options.GitHubToken
            : Environment.GetEnvironmentVariable("GITHUB_MCP_TOKEN")
                ?? Environment.GetEnvironmentVariable("GH_TOKEN")
                ?? Environment.GetEnvironmentVariable("GITHUB_TOKEN");

    /// <summary>Whether live search is configured (enabled and a token is available).</summary>
    public bool IsEnabled => _options.Enabled && !string.IsNullOrWhiteSpace(Token);

    /// <summary>Searches the repository's source code. Returns file paths + code fragments.</summary>
    public async Task<IReadOnlyList<LiveSearchResult>> SearchCodeAsync(string query, CancellationToken cancellationToken)
    {
        var q = Uri.EscapeDataString($"{query} repo:{_options.Repo}");
        var url = $"{ApiBase}/search/code?q={q}&per_page={_options.MaxResults}";

        using var doc = await GetAsync(url, "application/vnd.github.text-match+json", cancellationToken);
        if (doc is null || !doc.RootElement.TryGetProperty("items", out var items))
        {
            return [];
        }

        var results = new List<LiveSearchResult>();
        foreach (var item in items.EnumerateArray())
        {
            var path = item.GetProperty("path").GetString() ?? "";
            var htmlUrl = item.GetProperty("html_url").GetString() ?? "";
            var fragment = ExtractTextMatches(item);
            var content = string.IsNullOrEmpty(fragment) ? $"Source file: {path}" : $"Matched code in {path}:\n{fragment}";
            results.Add(new LiveSearchResult($"{path} (source)", htmlUrl, _options.Repo, content));
        }

        return results;
    }

    /// <summary>Searches issues + PRs. Includes maintainer comments for the top results when enabled.</summary>
    public async Task<IReadOnlyList<LiveSearchResult>> SearchIssuesAsync(string query, CancellationToken cancellationToken)
    {
        var q = Uri.EscapeDataString($"repo:{_options.Repo} {query}");
        var url = $"{ApiBase}/search/issues?q={q}&per_page={_options.MaxResults}&sort=reactions&order=desc";

        using var doc = await GetAsync(url, "application/vnd.github+json", cancellationToken);
        if (doc is null || !doc.RootElement.TryGetProperty("items", out var items))
        {
            return [];
        }

        var results = new List<LiveSearchResult>();
        foreach (var item in items.EnumerateArray())
        {
            var number = item.GetProperty("number").GetInt32();
            var title = item.GetProperty("title").GetString() ?? "";
            var state = item.TryGetProperty("state", out var st) ? st.GetString() : "";
            var htmlUrl = item.GetProperty("html_url").GetString() ?? "";
            var isPr = item.TryGetProperty("pull_request", out _);
            var association = item.TryGetProperty("author_association", out var aa) ? aa.GetString() : "";
            var body = item.TryGetProperty("body", out var b) ? b.GetString() ?? "" : "";

            var sb = new StringBuilder();
            sb.AppendLine($"{(isPr ? "PR" : "Issue")} #{number} [{state}] by {association}: {title}");
            if (!string.IsNullOrWhiteSpace(body))
            {
                sb.AppendLine(Truncate(body, 500));
            }

            if (_options.MaintainerCommentsPerIssue > 0 && item.TryGetProperty("comments", out var cc) && cc.GetInt32() > 0)
            {
                var comments = await FetchMaintainerCommentsAsync(number, cancellationToken);
                foreach (var c in comments)
                {
                    sb.AppendLine($"↳ maintainer ({c.Association}): {Truncate(c.Body, 500)}");
                }
            }

            results.Add(new LiveSearchResult($"#{number}: {Truncate(title, 80)} ({(isPr ? "PR" : "issue")})", htmlUrl, _options.Repo, sb.ToString().TrimEnd()));
        }

        return results;
    }

    private async Task<IReadOnlyList<(string Association, string Body)>> FetchMaintainerCommentsAsync(
        int issueNumber, CancellationToken cancellationToken)
    {
        try
        {
            var url = $"{ApiBase}/repos/{_options.Repo}/issues/{issueNumber}/comments?per_page=30";
            using var doc = await GetAsync(url, "application/vnd.github+json", cancellationToken);
            if (doc is null)
            {
                return [];
            }

            var maintainer = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "OWNER", "MEMBER", "COLLABORATOR" };
            var comments = new List<(string, string)>();
            foreach (var c in doc.RootElement.EnumerateArray())
            {
                var assoc = c.TryGetProperty("author_association", out var a) ? a.GetString() ?? "" : "";
                if (!maintainer.Contains(assoc))
                {
                    continue;
                }

                var body = c.TryGetProperty("body", out var b) ? b.GetString() ?? "" : "";
                if (!string.IsNullOrWhiteSpace(body))
                {
                    comments.Add((assoc, body));
                }

                if (comments.Count >= _options.MaintainerCommentsPerIssue)
                {
                    break;
                }
            }

            return comments;
        }
        catch (Exception ex)
        {
            logger.LogDebug(ex, "Failed to fetch comments for issue #{Number}.", issueNumber);
            return [];
        }
    }

    private async Task<JsonDocument?> GetAsync(string url, string accept, CancellationToken cancellationToken)
    {
        var http = httpFactory.CreateClient("github-search");
        using var request = new HttpRequestMessage(HttpMethod.Get, url);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", Token);
        request.Headers.Accept.Clear();
        request.Headers.Accept.ParseAdd(accept);

        using var response = await http.SendAsync(request, cancellationToken);
        if (!response.IsSuccessStatusCode)
        {
            var body = await response.Content.ReadAsStringAsync(cancellationToken);
            logger.LogWarning("GitHub search {Status} for {Url}: {Body}", (int)response.StatusCode, url, Truncate(body, 200));
            return null;
        }

        var json = await response.Content.ReadAsStringAsync(cancellationToken);
        return JsonDocument.Parse(json);
    }

    private static string ExtractTextMatches(JsonElement item)
    {
        if (!item.TryGetProperty("text_matches", out var matches))
        {
            return string.Empty;
        }

        var sb = new StringBuilder();
        foreach (var m in matches.EnumerateArray())
        {
            if (m.TryGetProperty("fragment", out var frag))
            {
                sb.AppendLine(Truncate(frag.GetString() ?? "", 400));
            }
        }

        return sb.ToString().Trim();
    }

    private static string Truncate(string text, int max)
    {
        text = text.Replace("\r", " ").Trim();
        return text.Length <= max ? text : text[..max] + "…";
    }
}
