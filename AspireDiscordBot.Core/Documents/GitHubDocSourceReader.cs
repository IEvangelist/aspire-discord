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
            var paths = await ListPathsAsync(http, repo, cancellationToken);
            logger.LogInformation("GitHub: {Count} candidate files in {Repo}@{Branch}.", paths.Count, repo.Repo, repo.Branch);

            foreach (var path in paths)
            {
                cancellationToken.ThrowIfCancellationRequested();

                var raw = await DownloadRawAsync(http, repo, path, cancellationToken);
                if (raw is not null)
                {
                    yield return new RawDocument(repo.Repo, path, raw, repo.UrlStyle, repo.Branch);
                }
            }
        }
    }

    private async Task<List<string>> ListPathsAsync(HttpClient http, DocRepoOptions repo, CancellationToken cancellationToken)
    {
        var url = $"https://api.github.com/repos/{repo.Repo}/git/trees/{repo.Branch}?recursive=1";
        using var response = await http.GetAsync(url, cancellationToken);
        if (!response.IsSuccessStatusCode)
        {
            var body = await response.Content.ReadAsStringAsync(cancellationToken);
            logger.LogError("GitHub tree request failed ({Status}) for {Repo}: {Body}", (int)response.StatusCode, repo.Repo, body);
            return [];
        }

        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        using var doc = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);

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

        return results;
    }

    private async Task<string?> DownloadRawAsync(HttpClient http, DocRepoOptions repo, string path, CancellationToken cancellationToken)
    {
        var url = $"https://raw.githubusercontent.com/{repo.Repo}/{repo.Branch}/{Uri.EscapeDataString(path).Replace("%2F", "/")}";
        try
        {
            using var response = await http.GetAsync(url, cancellationToken);
            if (!response.IsSuccessStatusCode)
            {
                logger.LogWarning("Failed to download {Url} ({Status}).", url, (int)response.StatusCode);
                return null;
            }

            return await response.Content.ReadAsStringAsync(cancellationToken);
        }
        catch (HttpRequestException ex)
        {
            logger.LogWarning(ex, "Error downloading {Url}.", url);
            return null;
        }
    }
}
