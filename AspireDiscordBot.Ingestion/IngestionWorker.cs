using AspireDiscordBot.Core.Configuration;
using AspireDiscordBot.Core.Documents;
using Microsoft.Extensions.Options;

namespace AspireDiscordBot.Ingestion;

/// <summary>
/// Drives ingestion over the service's lifetime: it runs the startup ingest, then — when a
/// refresh interval is configured — periodically re-ingests so the index tracks site updates.
/// Manual refreshes via the dashboard command share the same <see cref="IngestionRunner"/>.
/// </summary>
public sealed class IngestionWorker(
    IngestionRunner runner,
    IOptions<IngestionOptions> options,
    ILogger<IngestionWorker> logger) : BackgroundService
{
    private readonly IngestionOptions _options = options.Value;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            await runner.RunStartupAsync(stoppingToken);

            var intervalHours = _options.RefreshIntervalHours;
            if (intervalHours <= 0)
            {
                logger.LogInformation("Scheduled refresh disabled (RefreshIntervalHours <= 0).");
                return;
            }

            var interval = TimeSpan.FromHours(intervalHours);
            logger.LogInformation("Scheduled refresh enabled: every {Hours}h.", intervalHours);

            using var timer = new PeriodicTimer(interval);
            while (await timer.WaitForNextTickAsync(stoppingToken))
            {
                await runner.RunAsync(force: false, "scheduled", stoppingToken);
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
            // Shutting down.
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Ingestion worker terminated unexpectedly.");
        }
    }
}
