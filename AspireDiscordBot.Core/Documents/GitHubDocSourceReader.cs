using System.Runtime.CompilerServices;
using System.Text.Json;
using AspireDiscordBot.Core.Configuration;
using Microsoft.Extensions.Logging;

namespace AspireDiscordBot.Core.Documents;

/// <summary>
/// Reads documentation directly from GitHub (the source of truth). It lists files via the
/// git-trees API and downloads raw content from the raw.githubusercontent CDN. An optional
/// token raises API rate limits.
/// </summary>
public sealed class GitHubDocSourceReader(IHttpClientFactory httpFactory, ILogger<GitHubDocSourceReader> logger)
    : IDocSourceReader
{
    public string ModeName => "github";

    public async IAsyncEnumerable<RawDocument> ReadAllAsync(
        IReadOnlyList<DocRepoOptions> sources,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        var http = httpFactory.CreateClient("github");

        foreach (var repo in sources)
        {
            var snapshot = await ListPathsAsync(http, repo, cancellationToken);
            logger.LogInformation(
                "GitHub: {Count} candidate files in {Repo}@{Revision}.",
                snapshot.Paths.Count,
                repo.Repo,
                snapshot.Revision);

            foreach (var path in snapshot.Paths)
            {
                cancellationToken.ThrowIfCancellationRequested();

                var raw = await DownloadRawAsync(http, repo, snapshot.Revision, path, cancellationToken);
                if (raw is not null)
                {
                    yield return new RawDocument(repo.Repo, path, raw, repo.UrlStyle, snapshot.Revision);
                }
            }
        }
    }

    private async Task<GitTreeSnapshot> ListPathsAsync(
        HttpClient http,
        DocRepoOptions repo,
        CancellationToken cancellationToken)
    {
        var url = $"https://api.github.com/repos/{repo.Repo}/git/trees/{repo.Branch}?recursive=1";
        using var response = await http.GetAsync(url, cancellationToken);
        if (!response.IsSuccessStatusCode)
        {
            var body = await response.Content.ReadAsStringAsync(cancellationToken);
            throw new HttpRequestException(
                $"GitHub tree request failed ({(int)response.StatusCode}) for {repo.Repo}: {body}");
        }

        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        using var doc = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);

        if (doc.RootElement.TryGetProperty("truncated", out var truncated)
            && truncated.ValueKind is JsonValueKind.True)
        {
            throw new InvalidOperationException(
                $"GitHub returned a truncated recursive tree for {repo.Repo}@{repo.Branch}; "
                + "refusing to publish a partial index. Use the managed/local Git source mode.");
        }

        var revision = doc.RootElement.TryGetProperty("sha", out var sha)
            ? sha.GetString()
            : null;
        if (string.IsNullOrWhiteSpace(revision))
        {
            throw new InvalidOperationException(
                $"GitHub tree response for {repo.Repo}@{repo.Branch} did not include a revision.");
        }

        var results = new List<string>();
        if (doc.RootElement.TryGetProperty("tree", out var tree))
        {
            foreach (var node in tree.EnumerateArray())
            {
                if (node.TryGetProperty("type", out var type) && type.GetString() == "blob"
                    && node.TryGetProperty("path", out var pathProp)
                    && pathProp.GetString() is { } path
                    && DocSourceCatalog.ShouldInclude(repo, path))
                {
                    results.Add(path);
                }
            }
        }

        return new GitTreeSnapshot(revision, results);
    }

    private async Task<string?> DownloadRawAsync(
        HttpClient http,
        DocRepoOptions repo,
        string revision,
        string path,
        CancellationToken cancellationToken)
    {
        var url = $"https://raw.githubusercontent.com/{repo.Repo}/{revision}/{Uri.EscapeDataString(path).Replace("%2F", "/")}";
        using var response = await http.GetAsync(url, cancellationToken);
        if (!response.IsSuccessStatusCode)
        {
            throw new HttpRequestException(
                $"GitHub raw-content request failed ({(int)response.StatusCode}) for {url}.");
        }

        return await response.Content.ReadAsStringAsync(cancellationToken);
    }

    private sealed record GitTreeSnapshot(string Revision, IReadOnlyList<string> Paths);
}
