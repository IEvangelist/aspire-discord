using AspireDiscordBot.Core.Configuration;
using AspireDiscordBot.Core.Telemetry;
using AspireDiscordBot.Core.Vectors;
using System.Diagnostics;
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
    IVectorStore vectorStore,
    IOptions<IngestionOptions> options,
    ILogger<IngestionRunner> logger)
{
    private readonly IngestionOptions _options = options.Value;
    private readonly SemaphoreSlim _gate = new(1, 1);

    private volatile bool _isRunning;
    private volatile bool _hasPublishedIndex;
    private DateTimeOffset? _lastStartedUtc;
    private DateTimeOffset? _lastFinishedUtc;
    private RunOutcome? _lastOutcome;

    public bool IsRunning => _isRunning;

    public bool HasPublishedIndex => _hasPublishedIndex;

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
            includeDocs = !await vectorStore.IsCompatibleAsync(cancellationToken: cancellationToken);
        }

        var includeApi = apiIngestor.IsEnabled &&
            (force || !await vectorStore.IsCompatibleAsync(apiIngestor.CollectionName, cancellationToken));

        if (!force && !includeDocs && !includeApi && apiIngestor.IsEnabled)
        {
            var docsGroup = await vectorStore.GetPublicationGroupAsync(
                _options.CollectionName,
                cancellationToken);
            var apiGroup = await vectorStore.GetPublicationGroupAsync(
                apiIngestor.CollectionName,
                cancellationToken);
            if (string.IsNullOrWhiteSpace(docsGroup)
                || !string.Equals(docsGroup, apiGroup, StringComparison.Ordinal))
            {
                logger.LogWarning(
                    "Published vector indexes do not share a publication group; rebuilding both aliases.");
                includeDocs = true;
                includeApi = true;
            }
        }

        if (!includeDocs && !includeApi)
        {
            var startedTimestamp = Stopwatch.GetTimestamp();
            using var activity = IngestionTelemetry.StartRun("startup", force);
            try
            {
                var count = await vectorStore.CountAsync(cancellationToken);
                var message = $"Startup ingest skipped: index already populated ({count} chunks). " +
                              "Use the dashboard command or the scheduled refresh to update it.";
                logger.LogInformation("{Message}", message);
                var outcome = new RunOutcome(
                    RunStatus.SkippedAlreadyPopulated,
                    message,
                    0,
                    0,
                    false,
                    null,
                    null);
                _hasPublishedIndex = true;
                _lastOutcome = outcome;
                IngestionTelemetry.CompleteRun(activity, outcome, "startup", startedTimestamp);
                return outcome;
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                IngestionTelemetry.CancelRun(activity, "startup", force, startedTimestamp);
                throw;
            }
            catch (Exception ex)
            {
                IngestionTelemetry.FailRun(activity, "startup", force, startedTimestamp, ex);
                throw;
            }
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
        var startedTimestamp = Stopwatch.GetTimestamp();
        using var activity = IngestionTelemetry.StartRun(trigger, force);
        var gateAcquired = false;
        var pendingBuilds = new List<IngestionBuildResult>();
        try
        {
            // Non-blocking: if a run is active, reject rather than queue.
            gateAcquired = await _gate.WaitAsync(0, cancellationToken);
            if (!gateAcquired)
            {
                var busy = new RunOutcome(
                    RunStatus.Busy,
                    "An ingestion run is already in progress.",
                    0, 0, force, _lastStartedUtc, _lastFinishedUtc);
                logger.LogInformation("Ingestion request ({Trigger}) ignored: already running.", trigger);
                IngestionTelemetry.CompleteRun(activity, busy, trigger, startedTimestamp);
                return busy;
            }

            _isRunning = true;
            _lastStartedUtc = DateTimeOffset.UtcNow;
            logger.LogInformation(
                "Ingestion started (trigger: {Trigger}, force: {Force}, docs: {Docs}, api: {Api}).",
                trigger, force, includeDocs, includeApi);

            var files = 0;
            var chunks = 0;
            var parts = new List<string>();
            var publicationGroup = Guid.NewGuid().ToString("N");

            if (includeDocs)
            {
                var completed = await ingestor.BuildAsync(
                    force,
                    cancellationToken,
                    publicationGroup);
                pendingBuilds.Add(completed);
                var docs = completed.Result;
                files += docs.Files;
                chunks += docs.Chunks;
                parts.Add($"{docs.Files} pages ({docs.Chunks} chunks) via '{docs.Mode}'");
            }

            if (includeApi)
            {
                var completed = await apiIngestor.BuildAsync(
                    force,
                    cancellationToken,
                    publicationGroup);
                pendingBuilds.Add(completed);
                var api = completed.Result;
                files += api.Files;
                chunks += api.Chunks;
                parts.Add($"{api.Files} API types ({api.Chunks} chunks)");
            }

            await vectorStore.CommitBuildsAsync(
                pendingBuilds.Select(completed => completed.Build).ToArray(),
                cancellationToken);
            _hasPublishedIndex = true;
            _lastFinishedUtc = DateTimeOffset.UtcNow;
            var outcome = new RunOutcome(
                RunStatus.Completed,
                $"Ingested {string.Join("; ", parts)}.",
                files, chunks, force, _lastStartedUtc, _lastFinishedUtc);
            _lastOutcome = outcome;
            logger.LogInformation("Ingestion complete (trigger: {Trigger}): {Message}", trigger, outcome.Message);
            IngestionTelemetry.CompleteRun(activity, outcome, trigger, startedTimestamp);
            return outcome;
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            await AbortPendingAsync(pendingBuilds);
            IngestionTelemetry.CancelRun(activity, trigger, force, startedTimestamp);
            throw;
        }
        catch (Exception ex)
        {
            await AbortPendingAsync(pendingBuilds);
            _lastFinishedUtc = DateTimeOffset.UtcNow;
            var outcome = new RunOutcome(
                RunStatus.Failed, $"Ingestion failed: {ex.Message}", 0, 0, force, _lastStartedUtc, _lastFinishedUtc);
            _lastOutcome = outcome;
            logger.LogError(ex, "Ingestion failed (trigger: {Trigger}).", trigger);
            IngestionTelemetry.CompleteRun(
                activity,
                outcome,
                trigger,
                startedTimestamp,
                ex.GetType().Name);
            return outcome;
        }
        finally
        {
            if (gateAcquired)
            {
                _isRunning = false;
                _gate.Release();
            }
        }
    }

    private async Task AbortPendingAsync(IReadOnlyList<IngestionBuildResult> pendingBuilds)
    {
        foreach (var completed in pendingBuilds)
        {
            try
            {
                await vectorStore.AbortBuildAsync(completed.Build, CancellationToken.None);
            }
            catch (Exception ex)
            {
                logger.LogWarning(
                    ex,
                    "Unable to clean up staging generation {Collection}.",
                    completed.Build.PhysicalCollection);
            }
        }
    }
}
