using Azure.Core;
using Azure.Identity;
using AspireDiscordBot.Core.Configuration;
using AspireDiscordBot.Core.Documents;
using AspireDiscordBot.Core.Vectors;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

namespace AspireDiscordBot.Tests;

public sealed class AzureSearchVectorStoreIntegrationTests
{
    private static string? Endpoint => Environment.GetEnvironmentVariable("AZURE_SEARCH_TEST_ENDPOINT");

    [SkippableFact]
    public async Task GenerationRoundTrip_PublishesAliasAndPreservesCosineScores()
    {
        Skip.If(string.IsNullOrWhiteSpace(Endpoint), "AZURE_SEARCH_TEST_ENDPOINT not set.");

        const int dimensions = 8;
        var logical = $"test-{Guid.NewGuid():N}"[..20];
        var ingestion = Options.Create(new IngestionOptions { CollectionName = logical });
        var ai = Options.Create(new AiOptions
        {
            EmbeddingDimensions = dimensions,
            EmbeddingModel = "integration-test",
            EmbeddingProvider = "azureaifoundry",
        });
        var options = Options.Create(new VectorStoreOptions
        {
            Endpoint = Endpoint,
            GenerationRetention = 2,
            Provider = "azuresearch",
        });
        TokenCredential credential = new DefaultAzureCredential();
        var store = new AzureSearchVectorStore(
            credential,
            ai,
            ingestion,
            options,
            NullLogger<AzureSearchVectorStore>.Instance);

        try
        {
            var first = await store.BeginBuildAsync();
            await store.UpsertAsync(
                [
                    MakeChunk("redis", "Use AddRedis to add a Redis cache resource.", 0),
                    MakeChunk("postgres", "Use AddPostgres to add PostgreSQL.", 1),
                ],
                [OneHot(dimensions, 0), OneHot(dimensions, 4)],
                collectionName: first.PhysicalCollection,
                build: first);
            Assert.Equal<ulong>(2, await store.CountAsync(collectionName: first.PhysicalCollection));

            await store.CommitBuildAsync(first);
            await WaitForAliasAsync(store, logical, expectedCount: 2);
            Assert.True(await store.IsCompatibleAsync());
            var results = await store.SearchAsync(OneHot(dimensions, 0), topK: 1);
            Assert.Single(results);
            Assert.Contains("AddRedis", results[0].Content);
            Assert.True(results[0].Score > 0.9f);

            var replacement = await store.BeginBuildAsync();
            await store.UpsertAsync(
                [MakeChunk("new", "Replacement generation.", 0)],
                [OneHot(dimensions, 2)],
                collectionName: replacement.PhysicalCollection,
                build: replacement);
            await store.CommitBuildAsync(replacement);
            await WaitForAliasAsync(store, logical, expectedCount: 1);
        }
        finally
        {
            await store.DeleteLogicalIndexAsync(logical);
        }
    }

    private static async Task WaitForAliasAsync(
        AzureSearchVectorStore store,
        string logical,
        ulong expectedCount)
    {
        for (var attempt = 0; attempt < 20; attempt++)
        {
            if (await store.CountAsync(collectionName: logical) == expectedCount)
            {
                return;
            }
            await Task.Delay(500);
        }
        Assert.Fail($"Alias '{logical}' did not expose {expectedCount} documents.");
    }

    private static DocChunk MakeChunk(string slug, string content, int index) => new()
    {
        Id = Guid.NewGuid().ToString(),
        Source = new DocSource
        {
            Repo = "microsoft/aspire.dev",
            Path = $"docs/{slug}.md",
            Title = slug,
            Url = $"https://aspire.dev/{slug}/",
            Revision = "test",
        },
        Content = content,
        Index = index,
    };

    private static float[] OneHot(int dimensions, int hot)
    {
        var vector = new float[dimensions];
        vector[hot] = 1;
        return vector;
    }
}
