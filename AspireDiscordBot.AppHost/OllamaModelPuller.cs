using System.Net.Http.Json;
using Microsoft.Extensions.Logging;

namespace AspireDiscordBot.AppHost;

/// <summary>
/// Pulls Ollama models via the server's <c>/api/pull</c> endpoint so an orchestrated Ollama
/// container has the configured chat + embedding models available. Best-effort: failures are
/// logged, not fatal (the user can also pull models manually with <c>ollama pull</c>).
/// </summary>
internal static class OllamaModelPuller
{
    public static async Task PullAsync(
        string baseUrl, IReadOnlyList<string> models, ILogger logger, CancellationToken cancellationToken)
    {
        using var http = new HttpClient { Timeout = TimeSpan.FromMinutes(30) };

        foreach (var model in models.Distinct(StringComparer.OrdinalIgnoreCase))
        {
            try
            {
                logger.LogInformation("Pulling Ollama model '{Model}' (this can take a while on first run)...", model);
                using var response = await http.PostAsJsonAsync(
                    $"{baseUrl.TrimEnd('/')}/api/pull",
                    new { model, stream = false },
                    cancellationToken);

                if (response.IsSuccessStatusCode)
                {
                    logger.LogInformation("Ollama model '{Model}' is ready.", model);
                }
                else
                {
                    logger.LogWarning(
                        "Failed to pull Ollama model '{Model}' ({Status}). Pull it manually with `ollama pull`.",
                        model, (int)response.StatusCode);
                }
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                logger.LogWarning(ex, "Error pulling Ollama model '{Model}'. Pull it manually with `ollama pull`.", model);
            }
        }
    }
}
