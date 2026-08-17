using AspireDiscordBot.Core.Documents;

namespace AspireDiscordBot.Tests;

public class MarkdownCleanerTests
{
    [Fact]
    public void Clean_ExtractsFrontmatterTitle_AndStripsFrontmatter()
    {
        var raw = "---\ntitle: Add a Redis resource\nsidebar:\n  order: 3\n---\n\nUse `AddRedis` to add a cache.";

        var result = MarkdownCleaner.Clean(raw);

        Assert.Equal("Add a Redis resource", result.Title);
        Assert.DoesNotContain("sidebar", result.Body);
        Assert.Contains("AddRedis", result.Body);
    }

    [Fact]
    public void Clean_RemovesMdxImportsAndJsxTags()
    {
        var raw = """
            import { Tabs } from '@astro/components';

            # Heading

            <Tabs>
            Real content here.
            </Tabs>
            """;

        var result = MarkdownCleaner.Clean(raw);

        Assert.DoesNotContain("import", result.Body);
        Assert.DoesNotContain("<Tabs>", result.Body);
        Assert.Contains("Real content here.", result.Body);
    }

    [Fact]
    public void Clean_PreservesFencedCodeVerbatim()
    {
        var raw = """
            # Example

            ```csharp
            var builder = DistributedApplication.CreateBuilder(args);
            import_should_not_be_stripped_inside_code();
            ```
            """;

        var result = MarkdownCleaner.Clean(raw);

        Assert.Contains("DistributedApplication.CreateBuilder", result.Body);
        Assert.Contains("import_should_not_be_stripped_inside_code", result.Body);
    }

    [Fact]
    public void Clean_ConvertsLinksToText_AndRemovesImages()
    {
        var raw = "See the [dashboard docs](https://aspire.dev/dashboard) and ![diagram](https://x/y.png) here.";

        var result = MarkdownCleaner.Clean(raw);

        Assert.Contains("dashboard docs", result.Body);
        Assert.DoesNotContain("https://aspire.dev/dashboard", result.Body);
        Assert.DoesNotContain("diagram", result.Body);
    }

    [Fact]
    public void Clean_FallsBackToFirstHeadingForTitle()
    {
        var raw = "# Deployment overview\n\nContent about deployment.";

        var result = MarkdownCleaner.Clean(raw);

        Assert.Equal("Deployment overview", result.Title);
    }
}
