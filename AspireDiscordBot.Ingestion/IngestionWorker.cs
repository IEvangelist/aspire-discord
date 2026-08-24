using AspireDiscordBot.Core.Configuration;
using AspireDiscordBot.Core.Ai;
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
    EmbeddingModelReadiness embeddingReadiness,
    IOptions<IngestionOptions> options,
    ILogger<IngestionWorker> logger) : BackgroundService
{
    private readonly IngestionOptions _options = options.Value;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            await RunStartupUntilSuccessfulAsync(stoppingToken);

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

    private async Task RunStartupUntilSuccessfulAsync(CancellationToken cancellationToken)
    {
        var delay = TimeSpan.FromSeconds(5);
        while (true)
        {
            cancellationToken.ThrowIfCancellationRequested();
            try
            {
                await embeddingReadiness.EnsureReadyAsync(cancellationToken);
                var outcome = await runner.RunStartupAsync(cancellationToken);
                if (outcome.Status is not (RunStatus.Failed or RunStatus.Busy))
                {
                    return;
                }

                logger.LogWarning(
                    "Startup ingestion did not complete ({Status}): {Message}. Retrying in {Delay}.",
                    outcome.Status,
                    outcome.Message,
                    delay);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "Startup prerequisites failed. Retrying in {Delay}.", delay);
            }

            await Task.Delay(delay, cancellationToken);
            delay = TimeSpan.FromSeconds(Math.Min(60, delay.TotalSeconds * 2));
        }
    }
}
