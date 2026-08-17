using AspireDiscordBot.Core.Configuration;
using AspireDiscordBot.Core.Documents;
using Microsoft.Extensions.Options;

namespace AspireDiscordBot.Tests;

public class DocumentChunkerTests
{
    private static DocumentChunker CreateChunker(int maxChars = 200, int overlap = 40)
    {
        var options = Options.Create(new IngestionOptions
        {
            MaxChunkChars = maxChars,
            ChunkOverlapChars = overlap,
        });
        return new DocumentChunker(options);
    }

    private static DocSource Source() => new()
    {
        Repo = "microsoft/aspire.dev",
        Path = "src/frontend/src/content/docs/dashboard/overview.mdx",
        Title = "Dashboard overview",
        Url = "https://aspire.dev/dashboard/overview/",
    };

    [Fact]
    public void Chunk_ProducesHeadingAwareChunks()
    {
        const string body = """
            Intro paragraph about the dashboard.

            # Metrics

            The metrics view shows counters and gauges.

            # Traces

            The traces view shows distributed traces.
            """;

        var chunks = CreateChunker(maxChars: 1000).Chunk(Source(), body);

        Assert.NotEmpty(chunks);
        Assert.Contains(chunks, c => c.Heading == "Metrics" && c.Content.Contains("counters and gauges"));
        Assert.Contains(chunks, c => c.Heading == "Traces" && c.Content.Contains("distributed traces"));
    }

    [Fact]
    public void Chunk_SplitsLongSections_WithinMaxChars()
    {
        var longBody = string.Join("\n\n", Enumerable.Range(0, 20).Select(i => $"Paragraph number {i} with some filler text to add length."));

        var chunks = CreateChunker(maxChars: 200, overlap: 40).Chunk(Source(), longBody);

        Assert.True(chunks.Count > 1);
        // Each chunk (minus an optional heading prefix) should respect the size budget with headroom.
        Assert.All(chunks, c => Assert.True(c.Content.Length <= 320, $"Chunk too large: {c.Content.Length}"));
    }

    [Fact]
    public void Chunk_ProducesDeterministicIds()
    {
        const string body = "# A\n\nSome content here that is long enough to keep.";

        var first = CreateChunker(maxChars: 1000).Chunk(Source(), body);
        var second = CreateChunker(maxChars: 1000).Chunk(Source(), body);

        Assert.Equal(first.Select(c => c.Id), second.Select(c => c.Id));
    }
}
