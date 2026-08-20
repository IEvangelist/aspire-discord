using AspireDiscordBot.Core.Configuration;
using AspireDiscordBot.Core.Vectors;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace AspireDiscordBot.Core.Documents;

/// <summary>The outcome of a requested ingestion run.</summary>
public enum RunStatus
{
    /// <summary>The run completed successfully.</summary>
    Completed,

    /// <summary>A run was already in progress, so this request was ignored.</summary>
    Busy,

    /// <summary>The startup run was skipped because the index was already populated.</summary>
    SkippedAlreadyPopulated,

    /// <summary>The run failed. See the accompanying message.</summary>
    Failed,
}

/// <summary>The result of a run request plus a snapshot of runner state, returned to callers/UI.</summary>
public sealed record RunOutcome(
    RunStatus Status,
    string Message,
    int Files,
    int Chunks,
    bool Forced,
    DateTimeOffset? StartedUtc,
    DateTimeOffset? FinishedUtc);

/// <summary>
/// Coordinates documentation ingestion runs. Only one run executes at a time (a non-blocking
/// gate rejects overlapping requests), and the latest state is tracked so the startup worker,
/// the scheduled refresh, and the dashboard command all share one safe entry point.
/// </summary>
public sealed class IngestionRunner(
    DocumentIngestor ingestor,
    ApiSurfaceIngestor apiIngestor,
    QdrantVectorStore vectorStore,
    IOptions<IngestionOptions> options,
    ILogger<IngestionRunner> logger)
{
    private readonly IngestionOptions _options = options.Value;
    private readonly SemaphoreSlim _gate = new(1, 1);

    private volatile bool _isRunning;
    private DateTimeOffset? _lastStartedUtc;
    private DateTimeOffset? _lastFinishedUtc;
    private RunOutcome? _lastOutcome;

    public bool IsRunning => _isRunning;

    public RunOutcome? LastOutcome => _lastOutcome;

    /// <summary>
    /// Runs the startup ingest, honoring <see cref="IngestionOptions.SkipStartupIngestWhenPopulated"/>
    /// so restarts don't needlessly re-embed an index that the persistent volume already holds. The
    /// docs and API-surface collections are considered independently: if the docs are already
    /// populated but the API collection isn't, only the API surface is ingested.
    /// </summary>
    public async Task<RunOutcome> RunStartupAsync(CancellationToken cancellationToken = default)
    {
        var force = _options.ForceReindex;
        var includeDocs = true;

        if (!force && _options.SkipStartupIngestWhenPopulated)
        {
            await vectorStore.EnsureCollectionAsync(recreate: false, cancellationToken);
            includeDocs = await vectorStore.CountAsync(cancellationToken) == 0;
        }

        var includeApi = apiIngestor.IsEnabled &&
            (force || !await vectorStore.IsPopulatedAsync(apiIngestor.CollectionName, cancellationToken));

        if (!includeDocs && !includeApi)
        {
            var count = await vectorStore.CountAsync(cancellationToken);
            var message = $"Startup ingest skipped: index already populated ({count} chunks). " +
                          "Use the dashboard command or the scheduled refresh to update it.";
            logger.LogInformation("{Message}", message);
            var outcome = new RunOutcome(RunStatus.SkippedAlreadyPopulated, message, 0, 0, false, null, null);
            _lastOutcome = outcome;
            return outcome;
        }

        return await RunInternalAsync(force, "startup", includeDocs, includeApi, cancellationToken);
    }

    /// <summary>Runs an ingestion pass unless one is already in progress.</summary>
    /// <param name="force">When true, the collection is rebuilt from scratch (prunes stale/deleted pages).</param>
    /// <param name="trigger">Human-readable trigger label for logs (startup/scheduled/http).</param>
    public Task<RunOutcome> RunAsync(bool force, string trigger, CancellationToken cancellationToken = default) =>
        RunInternalAsync(force, trigger, includeDocs: true, includeApi: apiIngestor.IsEnabled, cancellationToken);

    private async Task<RunOutcome> RunInternalAsync(
        bool force, string trigger, bool includeDocs, bool includeApi, CancellationToken cancellationToken)
    {
        // Non-blocking: if a run is active, reject rather than queue.
        if (!await _gate.WaitAsync(0, cancellationToken))
        {
            var busy = new RunOutcome(
                RunStatus.Busy,
                "An ingestion run is already in progress.",
                0, 0, force, _lastStartedUtc, _lastFinishedUtc);
            logger.LogInformation("Ingestion request ({Trigger}) ignored: already running.", trigger);
            return busy;
        }

        try
        {
            _isRunning = true;
            _lastStartedUtc = DateTimeOffset.UtcNow;
            logger.LogInformation(
                "Ingestion started (trigger: {Trigger}, force: {Force}, docs: {Docs}, api: {Api}).",
                trigger, force, includeDocs, includeApi);

            var files = 0;
            var chunks = 0;
            var parts = new List<string>();

            if (includeDocs)
            {
                var docs = await ingestor.IngestAsync(force, cancellationToken);
                files += docs.Files;
                chunks += docs.Chunks;
                parts.Add($"{docs.Files} pages ({docs.Chunks} chunks) via '{docs.Mode}'");
            }

            if (includeApi)
            {
                var api = await apiIngestor.IngestAsync(force, cancellationToken);
                files += api.Files;
                chunks += api.Chunks;
                parts.Add($"{api.Files} API types ({api.Chunks} chunks)");
            }

            _lastFinishedUtc = DateTimeOffset.UtcNow;
            var outcome = new RunOutcome(
                RunStatus.Completed,
                $"Ingested {string.Join("; ", parts)}.",
                files, chunks, force, _lastStartedUtc, _lastFinishedUtc);
            _lastOutcome = outcome;
            logger.LogInformation("Ingestion complete (trigger: {Trigger}): {Message}", trigger, outcome.Message);
            return outcome;
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            _lastFinishedUtc = DateTimeOffset.UtcNow;
            var outcome = new RunOutcome(
                RunStatus.Failed, $"Ingestion failed: {ex.Message}", 0, 0, force, _lastStartedUtc, _lastFinishedUtc);
            _lastOutcome = outcome;
            logger.LogError(ex, "Ingestion failed (trigger: {Trigger}).", trigger);
            return outcome;
        }
        finally
        {
            _isRunning = false;
            _gate.Release();
        }
    }
}
