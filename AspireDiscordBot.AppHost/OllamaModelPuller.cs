using System.Net.Http.Json;
using Microsoft.Extensions.Logging;

namespace AspireDiscordBot.AppHost;

/// <summary>
/// Pulls Ollama models via the server's <c>/api/pull</c> endpoint so an orchestrated Ollama
/// container has the configured chat + embedding models available.
/// </summary>
internal static class OllamaModelPuller
{
    public static async Task PullAsync(
        string baseUrl, IReadOnlyList<string> models, ILogger logger, CancellationToken cancellationToken)
    {
        using var http = new HttpClient { Timeout = TimeSpan.FromMinutes(30) };

        foreach (var model in models.Distinct(StringComparer.OrdinalIgnoreCase))
        {
            Exception? lastError = null;
            for (var attempt = 1; attempt <= 3; attempt++)
            {
                try
                {
                    logger.LogInformation(
                        "Pulling Ollama model '{Model}' (attempt {Attempt}/3; first use can take a while)...",
                        model,
                        attempt);
                    using var response = await http.PostAsJsonAsync(
                        $"{baseUrl.TrimEnd('/')}/api/pull",
                        new { model, stream = false },
                        cancellationToken);
                    if (!response.IsSuccessStatusCode)
                    {
                        var body = await response.Content.ReadAsStringAsync(cancellationToken);
                        throw new HttpRequestException(
                            $"Ollama returned {(int)response.StatusCode}: {body}");
                    }

                    logger.LogInformation("Ollama model '{Model}' is ready.", model);
                    lastError = null;
                    break;
                }
                catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
                {
                    throw;
                }
                catch (Exception ex)
                {
                    lastError = ex;
                    if (attempt < 3)
                    {
                        await Task.Delay(TimeSpan.FromSeconds(attempt * 2), cancellationToken);
                    }
                }
            }

            if (lastError is not null)
            {
                throw new InvalidOperationException(
                    $"Unable to pull required Ollama model '{model}'.",
                    lastError);
            }
        }
    }
}
