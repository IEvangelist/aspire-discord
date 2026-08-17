using AspireDiscordBot.Core.Configuration;
using AspireDiscordBot.Core.Documents;

namespace AspireDiscordBot.Tests;

public class DocSourceCatalogTests
{
    private static readonly DocRepoOptions AspireDev = new()
    {
        Repo = "microsoft/aspire.dev",
        Branch = "main",
        IncludePrefixes = ["src/frontend/src/content/docs/"],
        Extensions = [".md", ".mdx"],
        UrlStyle = "aspiredev",
    };

    private static readonly DocRepoOptions Aspire = new()
    {
        Repo = "microsoft/aspire",
        Branch = "main",
        IncludePrefixes = ["docs/"],
        Extensions = [".md"],
        UrlStyle = "github",
    };

    [Theory]
    [InlineData("src/frontend/src/content/docs/dashboard/overview.mdx", true)]
    [InlineData("src/frontend/src/content/docs/app-host/configuration.mdx", true)]
    [InlineData("src/frontend/src/content/docs/de/index.mdx", false)]      // German translation
    [InlineData("src/frontend/src/content/docs/404.mdx", false)]           // 404 page
    [InlineData("src/frontend/src/components/HeroSection.astro", false)]   // not docs
    [InlineData("src/frontend/src/content/docs/readme.txt", false)]        // wrong extension
    public void ShouldInclude_AspireDev(string path, bool expected)
    {
        Assert.Equal(expected, DocSourceCatalog.ShouldInclude(AspireDev, path));
    }

    [Theory]
    [InlineData("docs/specs/appmodel.md", true)]
    [InlineData("docs/area-owners.md", true)]
    [InlineData("src/Aspire.Hosting/README.md", false)]  // outside docs/ prefix
    public void ShouldInclude_Aspire(string path, bool expected)
    {
        Assert.Equal(expected, DocSourceCatalog.ShouldInclude(Aspire, path));
    }

    [Theory]
    [InlineData("src/frontend/src/content/docs/dashboard/overview.mdx", "https://aspire.dev/dashboard/overview/")]
    [InlineData("src/frontend/src/content/docs/deployment/azure/index.mdx", "https://aspire.dev/deployment/azure/")]
    [InlineData("src/frontend/src/content/docs/index.mdx", "https://aspire.dev/")]
    public void BuildUrl_AspireDev_MapsToSiteUrl(string path, string expected)
    {
        var url = DocSourceCatalog.BuildUrl("microsoft/aspire.dev", "main", path, "aspiredev");
        Assert.Equal(expected, url);
    }

    [Fact]
    public void BuildUrl_Github_LinksToBlob()
    {
        var url = DocSourceCatalog.BuildUrl("microsoft/aspire", "main", "docs/specs/appmodel.md", "github");
        Assert.Equal("https://github.com/microsoft/aspire/blob/main/docs/specs/appmodel.md", url);
    }

    [Theory]
    [InlineData("src/frontend/src/content/docs/dashboard/overview.mdx", "Overview")]
    [InlineData("src/frontend/src/content/docs/deployment/azure/index.mdx", "Azure")]
    public void TitleFromPath_IsReadable(string path, string expected)
    {
        Assert.Equal(expected, DocSourceCatalog.TitleFromPath(path));
    }

    [Fact]
    public void Default_IncludesBothSourcesOfTruth()
    {
        var sources = DocSourceCatalog.Default();
        Assert.Contains(sources, s => s.Repo == "microsoft/aspire.dev");
        Assert.Contains(sources, s => s.Repo == "microsoft/aspire");
    }
}
