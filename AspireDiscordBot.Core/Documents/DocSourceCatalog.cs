using System.Text.RegularExpressions;
using AspireDiscordBot.Core.Configuration;

namespace AspireDiscordBot.Core.Documents;

/// <summary>A raw, unprocessed documentation file read from a source.</summary>
/// <param name="Repo">Owning repository, e.g. <c>microsoft/aspire.dev</c>.</param>
/// <param name="Path">Repo-relative path, or a slug for CLI-sourced docs.</param>
/// <param name="Raw">Raw file contents.</param>
/// <param name="UrlStyle">How to build the citation URL (<c>aspiredev</c>, <c>github</c>, or <c>resolved</c>).</param>
/// <param name="Branch">Branch used for GitHub URLs.</param>
public readonly record struct RawDocument(string Repo, string Path, string Raw, string UrlStyle, string Branch)
{
    /// <summary>Authoritative title when the source already knows it (e.g. the Aspire CLI). Optional.</summary>
    public string? Title { get; init; }

    /// <summary>Pre-resolved canonical citation URL. When set, it is used verbatim. Optional.</summary>
    public string? ResolvedUrl { get; init; }
}

/// <summary>
/// Default set of documentation sources (the source of truth) and helpers for path
/// filtering + citation URL construction. These defaults ground every answer on
/// <c>microsoft/aspire.dev</c> user docs and <c>microsoft/aspire</c> engineering docs.
/// </summary>
public static partial class DocSourceCatalog
{
    private const string AspireDevDocsPrefix = "src/frontend/src/content/docs/";

    // Locale directories under the docs root are translations; only English (unprefixed) is ingested.
    private static readonly HashSet<string> LocaleSegments = new(StringComparer.OrdinalIgnoreCase)
    {
        "ar", "bg", "bn", "cs", "da", "de", "el", "es", "fa", "fi", "fr", "he", "hi", "hu",
        "id", "it", "ja", "ko", "nl", "no", "pl", "pt", "pt-br", "ro", "ru", "sk", "sv",
        "th", "tr", "uk", "vi", "zh", "zh-cn", "zh-tw", "zh-hans", "zh-hant",
    };

    public static List<DocRepoOptions> Default() =>
    [
        new DocRepoOptions
        {
            Repo = "microsoft/aspire.dev",
            Branch = "main",
            LocalPath = null,
            IncludePrefixes = [AspireDevDocsPrefix],
            Extensions = [".md", ".mdx"],
            UrlStyle = "aspiredev",
        },
        new DocRepoOptions
        {
            Repo = "microsoft/aspire",
            Branch = "main",
            LocalPath = null,
            IncludePrefixes = ["docs/"],
            Extensions = [".md"],
            UrlStyle = "github",
        },
    ];

    /// <summary>Whether the given first URL/path segment is a known non-English locale directory.</summary>
    public static bool IsLocaleSegment(string segment) => LocaleSegments.Contains(segment);

    /// <summary>Whether a repo-relative path should be ingested for the given source.</summary>
    public static bool ShouldInclude(DocRepoOptions repo, string path)
    {
        path = path.Replace('\\', '/');

        if (!repo.Extensions.Any(ext => path.EndsWith(ext, StringComparison.OrdinalIgnoreCase)))
        {
            return false;
        }

        if (!repo.IncludePrefixes.Any(prefix => path.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)))
        {
            return false;
        }

        if (string.Equals(repo.UrlStyle, "aspiredev", StringComparison.OrdinalIgnoreCase))
        {
            var slug = path[AspireDevDocsPrefix.Length..];
            var firstSegment = slug.Split('/', 2)[0];

            // Skip translations and the 404 page.
            if (LocaleSegments.Contains(firstSegment) || slug.StartsWith("404", StringComparison.OrdinalIgnoreCase))
            {
                return false;
            }
        }

        return true;
    }

    /// <summary>Builds a citation URL for a document.</summary>
    public static string BuildUrl(string repo, string branch, string path, string urlStyle)
    {
        path = path.Replace('\\', '/');

        if (string.Equals(urlStyle, "aspiredev", StringComparison.OrdinalIgnoreCase)
            && path.StartsWith(AspireDevDocsPrefix, StringComparison.OrdinalIgnoreCase))
        {
            var slug = path[AspireDevDocsPrefix.Length..];
            slug = ExtensionRegex().Replace(slug, string.Empty);
            if (slug.EndsWith("/index", StringComparison.OrdinalIgnoreCase))
            {
                slug = slug[..^"/index".Length];
            }
            else if (string.Equals(slug, "index", StringComparison.OrdinalIgnoreCase))
            {
                slug = string.Empty;
            }

            return string.IsNullOrEmpty(slug) ? "https://aspire.dev/" : $"https://aspire.dev/{slug}/";
        }

        return $"https://github.com/{repo}/blob/{branch}/{path}";
    }

    /// <summary>Derives a readable title from the path when no better title is available.</summary>
    public static string TitleFromPath(string path)
    {
        var name = ExtensionRegex().Replace(Path.GetFileName(path.Replace('\\', '/')), string.Empty);
        if (string.Equals(name, "index", StringComparison.OrdinalIgnoreCase))
        {
            var parts = path.Replace('\\', '/').TrimEnd('/').Split('/');
            name = parts.Length >= 2 ? parts[^2] : name;
        }

        name = name.Replace('-', ' ').Replace('_', ' ').Trim();
        return name.Length == 0 ? path : char.ToUpperInvariant(name[0]) + name[1..];
    }

    [GeneratedRegex(@"\.(md|mdx)$", RegexOptions.IgnoreCase)]
    private static partial Regex ExtensionRegex();
}
