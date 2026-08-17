using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using AspireDiscordBot.Core.Configuration;
using Microsoft.Extensions.Options;

namespace AspireDiscordBot.Core.Documents;

/// <summary>
/// Splits a cleaned document into overlapping, heading-aware chunks. Sections are cut at
/// Markdown headings first; oversized sections are then windowed by character length at
/// paragraph boundaries so no chunk exceeds the configured size.
/// </summary>
public sealed partial class DocumentChunker(IOptions<IngestionOptions> options)
{
    private readonly int _maxChars = Math.Max(200, options.Value.MaxChunkChars);
    private readonly int _overlap = Math.Max(0, options.Value.ChunkOverlapChars);

    public IReadOnlyList<DocChunk> Chunk(DocSource source, string cleanedBody)
    {
        var chunks = new List<DocChunk>();
        var index = 0;

        foreach (var (heading, text) in SplitByHeadings(cleanedBody))
        {
            foreach (var window in SplitByLength(text))
            {
                var content = window.Trim();
                if (content.Length < 20)
                {
                    continue;
                }

                // Prefix the heading trail so each chunk is self-describing for retrieval.
                var body = string.IsNullOrWhiteSpace(heading) ? content : $"{heading}\n\n{content}";

                chunks.Add(new DocChunk
                {
                    Id = DeterministicGuid(source.Repo, source.Path, index).ToString(),
                    Source = source,
                    Content = body,
                    Heading = string.IsNullOrWhiteSpace(heading) ? null : heading,
                    Index = index,
                });
                index++;
            }
        }

        return chunks;
    }

    private static IEnumerable<(string Heading, string Text)> SplitByHeadings(string body)
    {
        var lines = body.Split('\n');
        var headingTrail = "";
        var current = new StringBuilder();

        foreach (var line in lines)
        {
            var m = HeadingRegex().Match(line);
            if (m.Success)
            {
                if (current.Length > 0)
                {
                    yield return (headingTrail, current.ToString());
                    current.Clear();
                }

                headingTrail = m.Groups["text"].Value.Trim();
            }
            else
            {
                current.Append(line).Append('\n');
            }
        }

        if (current.Length > 0)
        {
            yield return (headingTrail, current.ToString());
        }
    }

    private IEnumerable<string> SplitByLength(string text)
    {
        text = text.Trim();
        if (text.Length <= _maxChars)
        {
            if (text.Length > 0)
            {
                yield return text;
            }

            yield break;
        }

        var paragraphs = text.Split("\n\n", StringSplitOptions.RemoveEmptyEntries);
        var current = new StringBuilder();

        foreach (var para in paragraphs)
        {
            if (current.Length > 0 && current.Length + para.Length + 2 > _maxChars)
            {
                var chunk = current.ToString().Trim();
                yield return chunk;

                // Start the next window with a trailing overlap for context continuity.
                var tail = chunk.Length > _overlap ? chunk[^_overlap..] : chunk;
                current.Clear();
                current.Append(tail).Append("\n\n");
            }

            // A single paragraph larger than the window is hard-split.
            if (para.Length > _maxChars)
            {
                foreach (var piece in HardSplit(para))
                {
                    yield return piece;
                }

                continue;
            }

            current.Append(para).Append("\n\n");
        }

        if (current.ToString().Trim().Length > 0)
        {
            yield return current.ToString().Trim();
        }
    }

    private IEnumerable<string> HardSplit(string text)
    {
        for (var start = 0; start < text.Length; start += _maxChars - _overlap)
        {
            var length = Math.Min(_maxChars, text.Length - start);
            yield return text.Substring(start, length).Trim();
            if (start + length >= text.Length)
            {
                yield break;
            }
        }
    }

    private static Guid DeterministicGuid(string repo, string path, int index)
    {
        var bytes = MD5.HashData(Encoding.UTF8.GetBytes($"{repo}::{path}::{index}"));
        return new Guid(bytes);
    }

    [GeneratedRegex(@"^\s{0,3}#{1,6}\s+(?<text>.+?)\s*#*\s*$")]
    private static partial Regex HeadingRegex();
}
