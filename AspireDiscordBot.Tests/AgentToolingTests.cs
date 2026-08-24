using AspireDiscordBot.Core.Ai;
using AspireDiscordBot.Core.Rag;
using Microsoft.Extensions.AI;
using Microsoft.Extensions.Logging.Abstractions;

namespace AspireDiscordBot.Tests;

public sealed class AgentToolingTests
{
    [Fact]
    public async Task Catalog_AppliesSharedBudget_AndSkipPermissionMetadata()
    {
        var calls = 0;
        var catalog = new AgentToolCatalog(
            [new FakeProvider(() => calls++)],
            NullLoggerFactory.Instance);
        var tools = await catalog.CreateAsync(new CitationRegistry(), maximumCalls: 1);

        var first = await tools.InvokeAsync(new ToolCall("1", "lookup", """{"query":"one"}"""));
        var second = await tools.InvokeAsync(new ToolCall("2", "lookup", """{"query":"two"}"""));

        Assert.Equal(1, calls);
        Assert.Contains("one", first.Output);
        Assert.Contains("budget exhausted", second.Output, StringComparison.OrdinalIgnoreCase);
        Assert.True((bool)tools.Functions.Single().AdditionalProperties["skip_permission"]!);
    }

    [Fact]
    public async Task Catalog_RejectsDuplicateToolNames()
    {
        var catalog = new AgentToolCatalog(
            [new FakeProvider(() => { }), new FakeProvider(() => { })],
            NullLoggerFactory.Instance);

        var error = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            catalog.CreateAsync(new CitationRegistry(), maximumCalls: 2));

        Assert.Contains("lookup", error.Message);
    }

    [Fact]
    public async Task ToolSet_ReturnsRecoverableError_ForMalformedArguments()
    {
        var catalog = new AgentToolCatalog(
            [new FakeProvider(() => { })],
            NullLoggerFactory.Instance);
        var tools = await catalog.CreateAsync(new CitationRegistry(), maximumCalls: 1);

        var result = await tools.InvokeAsync(new ToolCall("1", "lookup", "{not-json"));

        Assert.Contains("invalid JSON arguments", result.Output);
        Assert.Equal(1, tools.Budget.Remaining);
    }

    private sealed class FakeProvider(Action onCall) : IAgentToolProvider
    {
        public ValueTask<IReadOnlyList<AIFunction>> CreateToolsAsync(
            AgentToolContext context,
            CancellationToken cancellationToken = default)
        {
            IReadOnlyList<AIFunction> tools =
            [
                AIFunctionFactory.Create(
                    (string query) =>
                    {
                        onCall();
                        return new AgentToolResult($"result: {query}", 1);
                    },
                    new AIFunctionFactoryOptions
                    {
                        Name = "lookup",
                        Description = "Test lookup.",
                    }),
            ];
            return ValueTask.FromResult(tools);
        }
    }
}
