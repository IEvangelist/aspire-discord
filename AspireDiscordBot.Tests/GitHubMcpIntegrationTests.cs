using AspireDiscordBot.Core.Ai;
using AspireDiscordBot.Core.Configuration;
using AspireDiscordBot.Core.Documents;
using AspireDiscordBot.Core.Rag;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;

namespace AspireDiscordBot.Tests;

public sealed class GitHubMcpIntegrationTests
{
    [SkippableFact]
    public async Task RemoteServer_Authenticates_AndListsConfiguredTool()
    {
        var token = Environment.GetEnvironmentVariable("GITHUB_MCP_TEST_TOKEN");
        Skip.If(string.IsNullOrWhiteSpace(token), "GITHUB_MCP_TEST_TOKEN not set.");

        var services = new ServiceCollection();
        services.AddLogging();
        services.AddHttpClient("github-mcp", http => http.Timeout = Timeout.InfiniteTimeSpan);
        services.AddSingleton(Options.Create(new GitHubMcpOptions
        {
            AccessToken = token,
            Tools = ["search_code"],
            AllowedRepositories = ["microsoft/aspire"],
        }));
        services.AddSingleton(Options.Create(new LiveSearchOptions { Enabled = false }));
        services.AddSingleton<GitHubMcpToolPolicy>();
        services.AddSingleton<GitHubMcpResultFormatter>();
        services.AddSingleton<GitHubMcpToolProvider>();
        await using var provider = services.BuildServiceProvider();

        var tools = await provider.GetRequiredService<GitHubMcpToolProvider>()
            .CreateToolsAsync(
                new AgentToolContext(new CitationRegistry(), new AgentToolBudget(1)));

        Assert.Contains(tools, tool => tool.Name == "search_code");
    }
}
