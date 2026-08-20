using AspireDiscordBot.Core.Rag;
using AspireDiscordBot.Core.Vectors;

namespace AspireDiscordBot.Tests;

public class CitationRegistryTests
{
    private static VectorSearchResult Result(string title, string url, string content = "body") =>
        new(0.9f, content, title, url, "microsoft/aspire.dev", "path.md", null);

    [Fact]
    public void Register_AssignsStableIncrementingNumbers()
    {
        var reg = new CitationRegistry();
        Assert.Equal(1, reg.Register("A", "https://a", "repo"));
        Assert.Equal(2, reg.Register("B", "https://b", "repo"));
        // Same URL keeps its number.
        Assert.Equal(1, reg.Register("A again", "https://a", "repo"));
        Assert.Equal(2, reg.All.Count);
    }

    [Fact]
    public void FormatResults_NumbersAcrossMultipleCalls_WithoutDuplicating()
    {
        var reg = new CitationRegistry();
        var first = reg.FormatResults([Result("Doc A", "https://a"), Result("Doc B", "https://b")]);
        Assert.Contains("[1] Doc A", first);
        Assert.Contains("[2] Doc B", first);

        // A later search returns A again plus a new C — A stays [1], C becomes [3].
        var second = reg.FormatResults([Result("Doc A", "https://a"), Result("Doc C", "https://c")]);
        Assert.Contains("[1] Doc A", second);
        Assert.Contains("[3] Doc C", second);
        Assert.Equal(3, reg.All.Count);
    }

    [Fact]
    public void FormatResults_ReportsNoMatchesOnEmpty()
    {
        var reg = new CitationRegistry();
        Assert.Contains("No matching", reg.FormatResults([]));
    }

    [Fact]
    public void CitedBy_ReturnsOnlyReferencedSources_Renumbered()
    {
        var reg = new CitationRegistry();
        reg.FormatResults([Result("Doc A", "https://a"), Result("Doc B", "https://b"), Result("Doc C", "https://c")]);

        // Answer references only [1] and [3].
        var cited = reg.CitedBy("First point [1]. Third point [3].");
        Assert.Equal(2, cited.Count);
        Assert.Equal("Doc A", cited[0].Title);
        Assert.Equal("Doc C", cited[1].Title);
    }

    [Fact]
    public void CitedBy_FallsBackToAll_WhenNoMarkers()
    {
        var reg = new CitationRegistry();
        reg.FormatResults([Result("Doc A", "https://a"), Result("Doc B", "https://b")]);
        var cited = reg.CitedBy("An answer with no bracketed citations.");
        Assert.Equal(2, cited.Count);
    }
}
