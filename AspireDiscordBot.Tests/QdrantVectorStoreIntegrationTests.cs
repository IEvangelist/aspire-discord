using AspireDiscordBot.Core.Configuration;
using AspireDiscordBot.Core.Documents;
using AspireDiscordBot.Core.Vectors;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Qdrant.Client;

namespace AspireDiscordBot.Tests;

/// <summary>
/// Round-trips the real Qdrant vector API (create collection, upsert, search). Runs only
/// when QDRANT_TEST_ENDPOINT is set (e.g. http://localhost:16334), so CI without a container
/// simply skips it. Verifies the Qdrant.Client method usage in <see cref="QdrantVectorStore"/>.
/// </summary>
public class QdrantVectorStoreIntegrationTests
{
    private static string? Endpoint => Environment.GetEnvironmentVariable("QDRANT_TEST_ENDPOINT");

    [SkippableFact]
    public async Task Upsert_Then_Search_ReturnsNearestChunk()
    {
        Skip.If(string.IsNullOrWhiteSpace(Endpoint), "QDRANT_TEST_ENDPOINT not set.");

        const int dims = 8;
        var client = new QdrantClient(new Uri(Endpoint));
        var collection = "test_" + Guid.NewGuid().ToString("N")[..8];

        var store = new QdrantVectorStore(
            client,
            Options.Create(new IngestionOptions { CollectionName = collection }),
            Options.Create(new AiOptions { EmbeddingDimensions = dims }),
            NullLogger<QdrantVectorStore>.Instance);

        await store.EnsureCollectionAsync(recreate: true);

        var redisChunk = MakeChunk("redis", "Use AddRedis to add a Redis cache resource.", index: 0);
        var postgresChunk = MakeChunk("postgres", "Use AddPostgres to add a PostgreSQL resource.", index: 1);

        // Two clearly-separated unit vectors so nearest-neighbour is unambiguous.
        var redisVec = OneHot(dims, 0);
        var postgresVec = OneHot(dims, 4);

        await store.UpsertAsync([redisChunk, postgresChunk], [redisVec, postgresVec]);

        Assert.Equal(2ul, await store.CountAsync());

        var results = await store.SearchAsync(redisVec, topK: 1);

        Assert.Single(results);
        Assert.Contains("AddRedis", results[0].Content);
        Assert.Equal("https://aspire.dev/caching/redis/", results[0].Url);
        Assert.True(results[0].Score > 0.9f, $"Expected high similarity, got {results[0].Score}");

        await client.DeleteCollectionAsync(collection);
    }

    private static DocChunk MakeChunk(string slug, string content, int index) => new()
    {
        Id = Guid.NewGuid().ToString(),
        Source = new DocSource
        {
            Repo = "microsoft/aspire.dev",
            Path = $"src/frontend/src/content/docs/caching/{slug}.mdx",
            Title = $"{slug} caching",
            Url = $"https://aspire.dev/caching/{slug}/",
        },
        Content = content,
        Heading = null,
        Index = index,
    };

    private static float[] OneHot(int dims, int hot)
    {
        var v = new float[dims];
        v[hot] = 1f;
        return v;
    }
}
