using AspireDiscordBot.Core.Configuration;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace AspireDiscordBot.Core.Documents;

/// <summary>
/// Builds a page-title → canonical-URL index from the aspire.dev documentation repository so
/// that CLI-sourced pages (which expose no URL) can be cited with exact deep links. Pages are
/// matched by normalized title; unresolved pages fall back to a site-search link.
/// </summary>
public sealed class AspireDocUrlIndex(
    GitHubDocSourceReader gitHubReader,
    LocalDocSourceReader localReader,
    IOptions<IngestionOptions> options,
    ILogger<AspireDocUrlIndex> logger)
{
    private readonly AspireCliOptions _cli = options.Value.Cli;
    private Dictionary<string, string> _titleToUrl = new(StringComparer.Ordinal);

    /// <summary>Normalizes a title for tolerant matching (lowercase, alphanumeric only).</summary>
    public static string NormalizeTitle(string? title)
    {
        if (string.IsNullOrWhiteSpace(title))
        {
            return string.Empty;
        }

        Span<char> buffer = title.Length <= 256 ? stackalloc char[title.Length] : new char[title.Length];
        var length = 0;
        foreach (var ch in title)
        {
            if (char.IsLetterOrDigit(ch))
            {
                buffer[length++] = char.ToLowerInvariant(ch);
            }
        }

        return new string(buffer[..length]);
    }

    /// <summary>Loads the index by reading the aspire.dev docs (from a local clone if configured, else GitHub).</summary>
    public async Task LoadAsync(CancellationToken cancellationToken = default)
    {
        var map = new Dictionary<string, string>(StringComparer.Ordinal);

        try
        {
            var repo = DocSourceCatalog.Default().First(r => string.Equals(r.UrlStyle, "aspiredev", StringComparison.OrdinalIgnoreCase));
            repo.Repo = _cli.AspireDevRepo;
            repo.Branch = _cli.AspireDevBranch;

            IDocSourceReader reader;
            if (!string.IsNullOrWhiteSpace(_cli.AspireDevLocalPath) && Directory.Exists(_cli.AspireDevLocalPath))
            {
                repo.LocalPath = _cli.AspireDevLocalPath;
                reader = localReader;
            }
            else
            {
                reader = gitHubReader;
            }

            await foreach (var raw in reader.ReadAllAsync([repo], cancellationToken))
            {
                var cleaned = MarkdownCleaner.Clean(raw.Raw);
                var title = !string.IsNullOrWhiteSpace(cleaned.Title)
                    ? cleaned.Title
                    : DocSourceCatalog.TitleFromPath(raw.Path);

                var key = NormalizeTitle(title);
                if (key.Length == 0)
                {
                    continue;
                }

                var url = DocSourceCatalog.BuildUrl(raw.Repo, raw.Branch, raw.Path, raw.UrlStyle);
                // Prefer the shortest URL when two pages share a normalized title.
                if (!map.TryGetValue(key, out var existing) || url.Length < existing.Length)
                {
                    map[key] = url;
                }
            }

            logger.LogInformation("Deep-link index built: {Count} aspire.dev page titles mapped to URLs.", map.Count);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Failed to build the aspire.dev deep-link index; citations will use fallback URLs.");
        }

        _titleToUrl = map;
    }

    /// <summary>Resolves a page title to its canonical URL, or a site-search fallback when unknown.</summary>
    public string Resolve(string title)
    {
        var key = NormalizeTitle(title);
        if (key.Length > 0 && _titleToUrl.TryGetValue(key, out var url))
        {
            return url;
        }

        return $"{_cli.SiteBaseUrl.TrimEnd('/')}/?q={Uri.EscapeDataString(title)}";
    }
}
