using System.Diagnostics;
using System.Diagnostics.Metrics;
using AspireDiscordBot.Core.Documents;

namespace AspireDiscordBot.Core.Telemetry;

internal static class IngestionTelemetry
{
    public const string Name = "AspireDiscordBot.Ingestion";

    private static readonly ActivitySource ActivitySource = new(Name);
    private static readonly Meter Meter = new(Name);
    private static readonly Counter<long> RunCounter =
        Meter.CreateCounter<long>("aspire.ingestion.runs", "{run}", "Ingestion runs by outcome.");
    private static readonly Histogram<double> RunDuration =
        Meter.CreateHistogram<double>("aspire.ingestion.run.duration", "s", "End-to-end ingestion run duration.");
    private static readonly Histogram<long> Files =
        Meter.CreateHistogram<long>("aspire.ingestion.files", "{file}", "Files processed by an ingestion run.");
    private static readonly Histogram<long> Chunks =
        Meter.CreateHistogram<long>("aspire.ingestion.chunks", "{chunk}", "Chunks produced by an ingestion run.");

    public static Activity? StartRun(string trigger, bool forced)
    {
        var activity = ActivitySource.StartActivity("ingestion run", ActivityKind.Internal);
        activity?.SetTag("aspire.ingestion.trigger", trigger);
        activity?.SetTag("aspire.ingestion.forced", forced);
        return activity;
    }

    public static void CompleteRun(
        Activity? activity,
        RunOutcome outcome,
        string trigger,
        long startedTimestamp,
        string? errorType = null)
    {
        var status = outcome.Status.ToString().ToLowerInvariant();
        var tags = new TagList
        {
            { "aspire.ingestion.trigger", trigger },
            { "aspire.ingestion.status", status },
            { "aspire.ingestion.forced", outcome.Forced },
        };
        RunCounter.Add(1, tags);
        RunDuration.Record(Stopwatch.GetElapsedTime(startedTimestamp).TotalSeconds, tags);
        Files.Record(outcome.Files, tags);
        Chunks.Record(outcome.Chunks, tags);

        activity?.SetTag("aspire.ingestion.status", status);
        activity?.SetTag("aspire.ingestion.file_count", outcome.Files);
        activity?.SetTag("aspire.ingestion.chunk_count", outcome.Chunks);
        if (errorType is not null)
        {
            activity?.SetTag("error.type", errorType);
        }
        activity?.SetStatus(
            outcome.Status is RunStatus.Failed ? ActivityStatusCode.Error : ActivityStatusCode.Ok);
    }

    public static void CancelRun(Activity? activity, string trigger, bool forced, long startedTimestamp)
    {
        var tags = new TagList
        {
            { "aspire.ingestion.trigger", trigger },
            { "aspire.ingestion.status", "cancelled" },
            { "aspire.ingestion.forced", forced },
        };
        RunCounter.Add(1, tags);
        RunDuration.Record(Stopwatch.GetElapsedTime(startedTimestamp).TotalSeconds, tags);
        activity?.SetTag("aspire.ingestion.status", "cancelled");
    }

    public static void FailRun(
        Activity? activity,
        string trigger,
        bool forced,
        long startedTimestamp,
        Exception error)
    {
        var tags = new TagList
        {
            { "aspire.ingestion.trigger", trigger },
            { "aspire.ingestion.status", "failed" },
            { "aspire.ingestion.forced", forced },
        };
        RunCounter.Add(1, tags);
        RunDuration.Record(Stopwatch.GetElapsedTime(startedTimestamp).TotalSeconds, tags);
        activity?.SetTag("aspire.ingestion.status", "failed");
        activity?.SetTag("error.type", error.GetType().Name);
        activity?.SetStatus(ActivityStatusCode.Error, error.Message);
    }
}
