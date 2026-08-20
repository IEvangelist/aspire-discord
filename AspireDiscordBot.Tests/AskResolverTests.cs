using AspireDiscordBot.Bot;

namespace AspireDiscordBot.Tests;

public class AskResolverTests
{
    [Fact]
    public void UsesOpQuestion_WhenNoQuestionTyped()
    {
        Assert.Equal("How do I add Redis?", AskResolver.Resolve("", "How do I add Redis?"));
        Assert.Equal("How do I add Redis?", AskResolver.Resolve(null, "How do I add Redis?"));
        Assert.Equal("How do I add Redis?", AskResolver.Resolve("   ", "How do I add Redis?"));
    }

    [Fact]
    public void UsesOpQuestion_WhenTypedTextIsAThreadReference()
    {
        // The exact phrasing from the reported scenario.
        Assert.Equal(
            "OP's real question",
            AskResolver.Resolve("Please help answer the OPs question above.", "OP's real question"));

        Assert.Equal("OP's real question", AskResolver.Resolve("answer the op", "OP's real question"));
        Assert.Equal("OP's real question", AskResolver.Resolve("can you help with the question above?", "OP's real question"));
        Assert.Equal("OP's real question", AskResolver.Resolve("this thread", "OP's real question"));
    }

    [Fact]
    public void UsesTypedQuestion_WhenItIsSubstantive()
    {
        Assert.Equal(
            "How do I configure health checks?",
            AskResolver.Resolve("How do I configure health checks?", "unrelated OP question"));
    }

    [Fact]
    public void UsesTypedQuestion_WhenNoOpAvailable()
    {
        Assert.Equal("How do I add Postgres?", AskResolver.Resolve("How do I add Postgres?", null));
    }

    [Fact]
    public void ReturnsNull_WhenNothingToAnswer()
    {
        Assert.Null(AskResolver.Resolve("", null));
        Assert.Null(AskResolver.Resolve(null, null));
        Assert.Null(AskResolver.Resolve("   ", "   "));
    }

    [Theory]
    [InlineData("answer the op above", true)]
    [InlineData("help answer this", true)]
    [InlineData("what's the question above?", true)]
    [InlineData("this post", true)]
    [InlineData("original poster's issue", true)]
    [InlineData("How do I add a Redis resource?", false)]
    [InlineData("What is service discovery in Aspire?", false)]
    [InlineData("how do resource lifetimes work", false)]
    public void ReferencesThread_DetectsMetaReferences(string text, bool expected)
    {
        Assert.Equal(expected, AskResolver.ReferencesThread(text));
    }
}
