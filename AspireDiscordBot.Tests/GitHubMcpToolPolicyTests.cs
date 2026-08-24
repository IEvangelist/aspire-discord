using System.Text.Json;
using AspireDiscordBot.Core.Configuration;
using AspireDiscordBot.Core.Documents;
using Microsoft.Extensions.AI;
using Microsoft.Extensions.Options;

namespace AspireDiscordBot.Tests;

public sealed class GitHubMcpToolPolicyTests
{
    private static readonly GitHubMcpToolPolicy Policy = new(Options.Create(new GitHubMcpOptions
    {
        AllowedRepositories = ["microsoft/aspire"],
    }));

    [Fact]
    public void SearchQuery_WithoutScope_IsConstrainedToDefaultRepository()
    {
        var arguments = new AIFunctionArguments
        {
            ["query"] = "DistributedApplicationBuilder",
        };

        var constrained = Policy.Constrain(
            "search_code",
            arguments,
            Schema("""{"type":"object","properties":{"query":{"type":"string"}}}"""));

        Assert.Equal(
            "DistributedApplicationBuilder repo:microsoft/aspire",
            constrained["query"]);
    }

    [Fact]
    public void SearchQuery_WithDisallowedRepository_IsRejected()
    {
        var arguments = new AIFunctionArguments
        {
            ["query"] = "password repo:someone/private",
        };

        var error = Assert.Throws<InvalidOperationException>(() =>
            Policy.Constrain(
                "search_code",
                arguments,
                Schema("""{"type":"object","properties":{"query":{"type":"string"}}}""")));

        Assert.Contains("not allowed", error.Message);
    }

    [Theory]
    [InlineData("term repo:microsoft/aspire OR org:private")]
    [InlineData("term repo:microsoft/aspire | repo:private/repo")]
    [InlineData("term user:someone")]
    public void SearchQuery_CannotBroadenScopeWithBooleanOrOwnerQualifiers(string query)
    {
        var error = Assert.Throws<InvalidOperationException>(() =>
            Policy.Constrain(
                "search_code",
                new AIFunctionArguments { ["query"] = query },
                Schema("""{"type":"object","properties":{"query":{"type":"string"}}}""")));

        Assert.Contains("may not contain", error.Message);
    }

    [Fact]
    public void RepoScopedTool_ReceivesAllowedDefaults()
    {
        var constrained = Policy.Constrain(
            "get_file_contents",
            new AIFunctionArguments { ["path"] = "src/Test.cs" },
            Schema(
                """{"type":"object","properties":{"owner":{"type":"string"},"repo":{"type":"string"},"path":{"type":"string"}}}"""));

        Assert.Equal("microsoft", constrained["owner"]);
        Assert.Equal("aspire", constrained["repo"]);
    }

    [Theory]
    [InlineData("https://github.com/microsoft/aspire/issues/1", true)]
    [InlineData("https://api.github.com/repos/microsoft/aspire/issues/1", true)]
    [InlineData("https://github.com/other/repo/issues/1", false)]
    [InlineData("https://example.com", false)]
    public void UrlPolicy_IsRepositoryScoped(string url, bool expected) =>
        Assert.Equal(expected, Policy.IsAllowedUrl(url));

    private static JsonElement Schema(string json)
    {
        using var document = JsonDocument.Parse(json);
        return document.RootElement.Clone();
    }
}
