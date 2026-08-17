using AspireDiscordBot.Core.Documents;

namespace AspireDiscordBot.Tests;

public class AspireDocUrlIndexTests
{
    [Theory]
    [InlineData("AppHost configuration", "apphostconfiguration")]
    [InlineData("Model distributed apps in code.", "modeldistributedappsincode")]
    [InlineData("k3s integration", "k3sintegration")]
    [InlineData("  Spaced   Out  ", "spacedout")]
    [InlineData("", "")]
    public void NormalizeTitle_StripsToLowerAlphanumeric(string input, string expected)
    {
        Assert.Equal(expected, AspireDocUrlIndex.NormalizeTitle(input));
    }

    [Fact]
    public void NormalizeTitle_MatchesAcrossPunctuationDifferences()
    {
        // A CLI title and a repo frontmatter title that differ only in punctuation/case must match.
        Assert.Equal(
            AspireDocUrlIndex.NormalizeTitle("Deploy with Aspire!"),
            AspireDocUrlIndex.NormalizeTitle("deploy with aspire"));
    }
}
