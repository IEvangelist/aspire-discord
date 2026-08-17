using System.Text;
using System.Text.RegularExpressions;

namespace AspireDiscordBot.Core.Documents;

/// <summary>
/// Turns raw Markdown / MDX into clean prose suitable for embedding. It removes YAML
/// frontmatter, MDX <c>import</c>/<c>export</c> statements and JSX component tags, converts
/// links/images to their text, and normalizes whitespace — while preserving fenced code
/// blocks verbatim (code is often the most useful part of an Aspire answer).
/// </summary>
public static partial class MarkdownCleaner
{
    public static CleanedDocument Clean(string raw)
    {
        string? title = null;
        var body = raw.Replace("\r\n", "\n").Replace("\r", "\n");

        // 1. Extract + strip YAML frontmatter delimited by leading '---'.
        var fm = FrontmatterRegex().Match(body);
        if (fm.Success)
        {
            title = ExtractFrontmatterTitle(fm.Groups["fm"].Value);
            body = body[fm.Length..];
        }

        var sb = new StringBuilder(body.Length);
        var inFence = false;
        string? fenceMarker = null;

        foreach (var rawLine in body.Split('\n'))
        {
            var line = rawLine;
            var trimmed = line.TrimStart();

            // Toggle fenced code blocks (``` or ~~~). Keep everything inside verbatim.
            if (trimmed.StartsWith("```") || trimmed.StartsWith("~~~"))
            {
                var marker = trimmed[..3];
                if (!inFence)
                {
                    inFence = true;
                    fenceMarker = marker;
                }
                else if (fenceMarker is not null && trimmed.StartsWith(fenceMarker))
                {
                    inFence = false;
                    fenceMarker = null;
                }

                sb.Append(line).Append('\n');
                continue;
            }

            if (inFence)
            {
                sb.Append(line).Append('\n');
                continue;
            }

            // Drop MDX import/export lines.
            if (trimmed.StartsWith("import ") || trimmed.StartsWith("export "))
            {
                continue;
            }

            // Capture the first Markdown heading as a fallback title.
            var headingMatch = HeadingRegex().Match(line);
            if (headingMatch.Success && title is null)
            {
                title = headingMatch.Groups["text"].Value.Trim();
            }

            line = ImageRegex().Replace(line, string.Empty);          // ![alt](url) -> ""
            line = LinkRegex().Replace(line, "${text}");               // [text](url) -> text
            line = JsxTagRegex().Replace(line, string.Empty);         // <Component .../> and </Tabs> -> ""
            line = HtmlCommentRegex().Replace(line, string.Empty);    // {/* ... */} and <!-- -->

            sb.Append(line).Append('\n');
        }

        var cleaned = MultiBlankLineRegex().Replace(sb.ToString(), "\n\n").Trim();
        return new CleanedDocument(title, cleaned);
    }

    private static string? ExtractFrontmatterTitle(string frontmatter)
    {
        foreach (var line in frontmatter.Split('\n'))
        {
            var m = FrontmatterTitleRegex().Match(line);
            if (m.Success)
            {
                return m.Groups["title"].Value.Trim().Trim('"', '\'');
            }
        }

        return null;
    }

    [GeneratedRegex(@"\A---\n(?<fm>.*?)\n---\n", RegexOptions.Singleline)]
    private static partial Regex FrontmatterRegex();

    [GeneratedRegex(@"^\s*title\s*:\s*(?<title>.+?)\s*$")]
    private static partial Regex FrontmatterTitleRegex();

    [GeneratedRegex(@"^\s{0,3}#{1,6}\s+(?<text>.+?)\s*#*\s*$")]
    private static partial Regex HeadingRegex();

    [GeneratedRegex(@"!\[[^\]]*\]\([^)]*\)")]
    private static partial Regex ImageRegex();

    [GeneratedRegex(@"\[(?<text>[^\]]+)\]\([^)]*\)")]
    private static partial Regex LinkRegex();

    [GeneratedRegex(@"</?[A-Za-z][A-Za-z0-9.]*(\s[^<>]*?)?/?>")]
    private static partial Regex JsxTagRegex();

    [GeneratedRegex(@"\{/\*.*?\*/\}|<!--.*?-->", RegexOptions.Singleline)]
    private static partial Regex HtmlCommentRegex();

    [GeneratedRegex(@"\n{3,}")]
    private static partial Regex MultiBlankLineRegex();
}
