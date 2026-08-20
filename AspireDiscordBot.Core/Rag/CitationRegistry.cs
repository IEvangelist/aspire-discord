using System.Text;
using AspireDiscordBot.Core.Vectors;

namespace AspireDiscordBot.Core.Rag;

/// <summary>
/// Assigns stable, incrementing citation numbers to unique sources across an agent's whole research
/// session (which may call the search tools several times). A source keeps the same [n] no matter
/// how many times it's returned, so the model's inline [n] markers map cleanly to the final
/// citation list.
/// </summary>
public sealed partial class CitationRegistry
{
    private readonly Dictionary<string, Citation> _byUrl = new(StringComparer.OrdinalIgnoreCase);
    private readonly List<Citation> _ordered = [];

    /// <summary>Registers a source (if new) and returns its stable citation number.</summary>
    public int Register(string title, string url, string repo)
    {
        if (_byUrl.TryGetValue(url, out var existing))
        {
            return existing.Number;
        }

        var citation = new Citation(_ordered.Count + 1, title, url, repo);
        _byUrl[url] = citation;
        _ordered.Add(citation);
        return citation.Number;
    }

    /// <summary>Formats a batch of search results as a numbered, grounded context block for the model.</summary>
    public string FormatResults(IReadOnlyList<VectorSearchResult> results, int maxCharsPerResult = 1200)
    {
        if (results.Count == 0)
        {
            return "No matching documentation was found for that query.";
        }

        var sb = new StringBuilder();
        foreach (var r in results)
        {
            var number = Register(r.Title, r.Url, r.Repo);
            var heading = string.IsNullOrEmpty(r.Heading) ? "" : $" — {r.Heading}";
            var content = r.Content.Length > maxCharsPerResult ? r.Content[..maxCharsPerResult] + "…" : r.Content;
            sb.AppendLine($"[{number}] {r.Title}{heading} ({r.Url})");
            sb.AppendLine(content);
            sb.AppendLine();
        }

        return sb.ToString().TrimEnd();
    }

    /// <summary>All sources registered so far, in citation order.</summary>
    public IReadOnlyList<Citation> All => _ordered;

    /// <summary>
    /// Registers a single external source (e.g. a GitHub code/issue result) and returns a numbered,
    /// grounded block for the model, matching the shape of <see cref="FormatResults"/>.
    /// </summary>
    public string FormatEntry(string title, string url, string repo, string content, int maxChars = 1200)
    {
        var number = Register(title, url, repo);
        var body = content.Length > maxChars ? content[..maxChars] + "…" : content;
        return $"[{number}] {title} ({url})\n{body}";
    }

    /// <summary>
    /// The subset of sources actually referenced by <paramref name="answer"/> via [n] markers,
    /// renumbered 1..k in first-appearance order. Falls back to all sources when none are cited.
    /// </summary>
    public IReadOnlyList<Citation> CitedBy(string answer)
    {
        var referenced = new List<Citation>();
        var seen = new HashSet<int>();
        foreach (System.Text.RegularExpressions.Match m in CitationMarker().Matches(answer))
        {
            if (int.TryParse(m.Groups[1].Value, out var n)
                && n >= 1 && n <= _ordered.Count && seen.Add(n))
            {
                referenced.Add(_ordered[n - 1]);
            }
        }

        return referenced.Count > 0 ? referenced : _ordered;
    }

    [System.Text.RegularExpressions.GeneratedRegex(@"\[(\d+)\]")]
    private static partial System.Text.RegularExpressions.Regex CitationMarker();
}
