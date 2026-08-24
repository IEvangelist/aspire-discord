using System.ComponentModel;
using AspireDiscordBot.Core.Ai;
using AspireDiscordBot.Core.Configuration;
using AspireDiscordBot.Core.Documents;
using AspireDiscordBot.Core.Vectors;
using Microsoft.Extensions.AI;
using Microsoft.Extensions.Options;

namespace AspireDiscordBot.Core.Rag;

/// <summary>Provides the indexed documentation and public-API search tools.</summary>
public sealed class GroundingToolProvider(
    IEmbeddingModel embeddingModel,
    QdrantVectorStore vectorStore,
    ApiSurfaceIngestor apiSurface,
    IOptions<AgentOptions> options) : IAgentToolProvider
{
    public const string SearchDocsName = "search_docs";
    public const string SearchApiName = "search_api";

    private readonly AgentOptions _options = options.Value;

    public ValueTask<IReadOnlyList<AIFunction>> CreateToolsAsync(
        AgentToolContext context,
        CancellationToken cancellationToken = default)
    {
        var tools = new List<AIFunction>
        {
            AIFunctionFactory.Create(
                async ([Description("A focused, specific search query about Aspire.")] string query, CancellationToken ct) =>
                    await SearchAsync(query, collection: null, context.Citations, ct),
                new AIFunctionFactoryOptions
                {
                    Name = SearchDocsName,
                    Description =
                        "Search the official Aspire documentation for passages relevant to a focused query. "
                        + "Call this multiple times with specific queries to cover multi-part questions. "
                        + "Returns numbered passages and canonical source URLs.",
                }),
        };

        if (apiSurface.IsEnabled)
        {
            tools.Add(AIFunctionFactory.Create(
                async ([Description("A type name, member name, signature, or API capability.")] string query, CancellationToken ct) =>
                    await SearchAsync(query, apiSurface.CollectionName, context.Citations, ct),
                new AIFunctionFactoryOptions
                {
                    Name = SearchApiName,
                    Description =
                        "Search the microsoft/aspire public C# API surface extracted from a pinned source snapshot. "
                        + "Use this for exact types, members, signatures, XML documentation, and whether an API exists. "
                        + "Returns numbered entries with commit-pinned source URLs.",
                }));
        }

        return ValueTask.FromResult<IReadOnlyList<AIFunction>>(tools);
    }

    private async Task<AgentToolResult> SearchAsync(
        string query,
        string? collection,
        CitationRegistry citations,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(query))
        {
            return new AgentToolResult("The 'query' argument was missing or empty.");
        }

        var vector = await embeddingModel.EmbedAsync(query, cancellationToken);
        var results = await vectorStore.SearchAsync(
            vector,
            _options.SearchResultsPerCall,
            cancellationToken,
            collection);
        return new AgentToolResult(citations.FormatResults(results), results.Count);
    }
}
