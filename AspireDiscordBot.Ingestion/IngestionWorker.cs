using AspireDiscordBot.Core.Documents;

namespace AspireDiscordBot.Ingestion;

/// <summary>
/// Runs the documentation ingestion pipeline on startup: reads the Aspire docs from the
/// configured source of truth, embeds them, and upserts them into Qdrant.
/// </summary>
public sealed class IngestionWorker(
    DocumentIngestor ingestor,
    ILogger<IngestionWorker> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            logger.LogInformation("Starting Aspire documentation ingestion...");
            var result = await ingestor.IngestAsync(stoppingToken);
            logger.LogInformation(
                "Ingestion finished: {Files} files, {Chunks} chunks via '{Mode}'. The bot is ready to answer questions.",
                result.Files, result.Chunks, result.Mode);
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
            // Shutting down.
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Documentation ingestion failed.");
        }
    }
}
