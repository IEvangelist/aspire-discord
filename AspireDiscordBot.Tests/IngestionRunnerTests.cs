using AspireDiscordBot.Core.Ai;
using AspireDiscordBot.Core.Configuration;
using AspireDiscordBot.Core.Documents;
using AspireDiscordBot.Core.Vectors;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Qdrant.Client;

namespace AspireDiscordBot.Tests;

/// <summary>
/// Verifies the ingestion coordinator: gating (no overlapping runs), startup skip-when-populated,
/// and force rebuild. Uses a fake reader + fake embeddings against a real Qdrant instance, so it
/// runs only when QDRANT_TEST_ENDPOINT is set.
/// </summary>
public sealed class IngestionRunnerTests
{
    private static string? Endpoint => Environment.GetEnvironmentVariable("QDRANT_TEST_ENDPOINT");
    private const int Dims = 8;

    [SkippableFact]
    public async Task RunAsync_PopulatesIndex_AndStartupSkipsWhenPopulated()
    {
        Skip.If(string.IsNullOrWhiteSpace(Endpoint), "QDRANT_TEST_ENDPOINT not set.");
        await using var ctx = await Harness.CreateAsync(pageCount: 3);

        var first = await ctx.Runner.RunAsync(force: false, "test");
        Assert.Equal(RunStatus.Completed, first.Status);
        Assert.Equal(3, first.Files);
        Assert.True(await ctx.Store.CountAsync() > 0);

        // With the index populated, the startup pass should skip re-embedding.
        var startup = await ctx.Runner.RunStartupAsync();
        Assert.Equal(RunStatus.SkippedAlreadyPopulated, startup.Status);
        Assert.Equal(1, ctx.Reader.CallCount); // reader not invoked a second time
    }

    [SkippableFact]
    public async Task RunAsync_RejectsOverlappingRuns()
    {
        Skip.If(string.IsNullOrWhiteSpace(Endpoint), "QDRANT_TEST_ENDPOINT not set.");
        await using var ctx = await Harness.CreateAsync(pageCount: 2, embedDelay: TimeSpan.FromMilliseconds(400));

        var firstTask = ctx.Runner.RunAsync(force: false, "first");
        // Give the first run time to acquire the gate before the second request arrives.
        await Task.Delay(100);
        var second = await ctx.Runner.RunAsync(force: false, "second");

        Assert.Equal(RunStatus.Busy, second.Status);
        Assert.Equal(RunStatus.Completed, (await firstTask).Status);
    }

    [SkippableFact]
    public async Task RunStartupAsync_ForceReindex_AlwaysRuns()
    {
        Skip.If(string.IsNullOrWhiteSpace(Endpoint), "QDRANT_TEST_ENDPOINT not set.");
        await using var ctx = await Harness.CreateAsync(pageCount: 2, forceReindex: true);

        await ctx.Runner.RunAsync(force: false, "seed");
        var startup = await ctx.Runner.RunStartupAsync();

        // ForceReindex bypasses the skip-when-populated shortcut.
        Assert.Equal(RunStatus.Completed, startup.Status);
    }

    private sealed class Harness : IAsyncDisposable
    {
        private readonly QdrantClient _client;
        private readonly string _collection;
        public QdrantVectorStore Store { get; }
        public FakeReader Reader { get; }
        public IngestionRunner Runner { get; }

        private Harness(QdrantClient client, string collection, QdrantVectorStore store, FakeReader reader, IngestionRunner runner)
        {
            _client = client;
            _collection = collection;
            Store = store;
            Reader = reader;
            Runner = runner;
        }

        public static async Task<Harness> CreateAsync(int pageCount, bool forceReindex = false, TimeSpan embedDelay = default)
        {
            var client = new QdrantClient(new Uri(Endpoint!));
            var collection = "run_" + Guid.NewGuid().ToString("N")[..8];

            var ingestionOptions = Options.Create(new IngestionOptions
            {
                CollectionName = collection,
                ForceReindex = forceReindex,
                SkipStartupIngestWhenPopulated = true,
                MaxChunkChars = 1000,
            });
            var aiOptions = Options.Create(new AiOptions { EmbeddingDimensions = Dims });

            var store = new QdrantVectorStore(client, ingestionOptions, aiOptions, NullLogger<QdrantVectorStore>.Instance);
            var reader = new FakeReader(pageCount);
            var chunker = new DocumentChunker(ingestionOptions);
            var embedding = new FakeEmbedding(Dims, embedDelay);
            var ingestor = new DocumentIngestor(reader, chunker, embedding, store, ingestionOptions, NullLogger<DocumentIngestor>.Instance);
            var runner = new IngestionRunner(ingestor, store, ingestionOptions, NullLogger<IngestionRunner>.Instance);

            return new Harness(client, collection, store, reader, runner);
        }

        public async ValueTask DisposeAsync()
        {
            try { await _client.DeleteCollectionAsync(_collection); } catch { /* ignore */ }
            _client.Dispose();
        }
    }

    private sealed class FakeReader(int pageCount) : IDocSourceReader
    {
        public int CallCount { get; private set; }
        public string ModeName => "fake";

        public async IAsyncEnumerable<RawDocument> ReadAllAsync(
            IReadOnlyList<DocRepoOptions> sources,
            [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken cancellationToken = default)
        {
            CallCount++;
            for (var i = 0; i < pageCount; i++)
            {
                await Task.Yield();
                yield return new RawDocument("microsoft/aspire.dev", $"docs/page-{i}.mdx",
                    $"# Page {i}\n\nContent about Aspire feature number {i} with enough text to chunk.", "resolved", "main")
                {
                    Title = $"Page {i}",
                    ResolvedUrl = $"https://aspire.dev/page-{i}/",
                };
            }
        }
    }

    private sealed class FakeEmbedding(int dims, TimeSpan delay) : IEmbeddingModel
    {
        public async Task<IReadOnlyList<float[]>> EmbedAsync(IReadOnlyList<string> inputs, CancellationToken cancellationToken = default)
        {
            if (delay > TimeSpan.Zero)
            {
                await Task.Delay(delay, cancellationToken);
            }

            var rng = new Random(inputs.Count);
            return inputs.Select(_ =>
            {
                var v = new float[dims];
                for (var i = 0; i < dims; i++)
                {
                    v[i] = (float)rng.NextDouble();
                }
                return v;
            }).ToList();
        }
    }
}
