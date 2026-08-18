using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;
using Aspire.Hosting;
using Microsoft.Extensions.Logging;

#pragma warning disable ASPIREINTERACTION001 // Interaction service APIs are experimental.

namespace AspireDiscordBot.AppHost;

/// <summary>
/// Performs the interactive GitHub Copilot device-flow sign-in from the AppHost and surfaces it as
/// a prominent Aspire dashboard notification (with a clickable sign-in link and the device code),
/// instead of burying the code in a service's console logs. The resulting OAuth token is written to
/// the shared cache that the services read, so the ingestion worker and the bot never prompt.
/// </summary>
internal static class CopilotSignIn
{
    private const string ClientId = "Iv1.b507a08c87ecfe98";
    private const string DeviceCodeUrl = "https://github.com/login/device/code";
    private const string AccessTokenUrl = "https://github.com/login/oauth/access_token";
    private const string DeviceGrantType = "urn:ietf:params:oauth:grant-type:device_code";

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    /// <summary>The shared OAuth token cache path (must match the services' CopilotTokenProvider).</summary>
    public static string CachePath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
        ".aspire-discord",
        "copilot-oauth.json");

    /// <summary>True when a cached OAuth token already exists (no sign-in needed).</summary>
    public static bool HasCachedToken()
    {
        try
        {
            if (!File.Exists(CachePath))
            {
                return false;
            }

            var cached = JsonSerializer.Deserialize<CachedOAuth>(File.ReadAllText(CachePath), JsonOptions);
            return !string.IsNullOrWhiteSpace(cached?.AccessToken);
        }
        catch
        {
            return false;
        }
    }

    /// <summary>
    /// Runs the device-flow sign-in, surfacing the code + link in the dashboard, and caches the
    /// resulting OAuth token. Re-issues a fresh code if the current one expires. Best-effort:
    /// failures are logged; the services will report if they can't get a token.
    /// </summary>
    public static async Task RunAsync(
        IInteractionService interaction, HttpClient http, ILogger logger, CancellationToken cancellationToken)
    {
        if (HasCachedToken())
        {
            return;
        }

        try
        {
            var overallDeadline = DateTimeOffset.UtcNow.AddMinutes(30);
            while (DateTimeOffset.UtcNow < overallDeadline)
            {
                cancellationToken.ThrowIfCancellationRequested();

                var token = await RunSingleDeviceCodeAsync(interaction, http, logger, cancellationToken);
                if (token is not null)
                {
                    WriteCache(token);
                    logger.LogInformation("GitHub Copilot sign-in complete; token cached for the services.");
                    _ = interaction.PromptNotificationAsync(
                        "GitHub Copilot connected",
                        "Sign-in complete. The bot and ingestion can now use Copilot.",
                        new NotificationInteractionOptions { Intent = MessageIntent.Success },
                        cancellationToken);
                    return;
                }

                logger.LogWarning("The GitHub sign-in code expired before it was entered; issuing a new code.");
            }

            logger.LogError("GitHub Copilot sign-in timed out. Restart the app to try again.");
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            // Shutting down.
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "GitHub Copilot sign-in failed.");
        }
    }

    private static async Task<string?> RunSingleDeviceCodeAsync(
        IInteractionService interaction, HttpClient http, ILogger logger, CancellationToken cancellationToken)
    {
        using var codeResponse = await http.PostAsync(
            DeviceCodeUrl,
            new FormUrlEncodedContent(new Dictionary<string, string>
            {
                ["client_id"] = ClientId,
                ["scope"] = "read:user",
            }),
            cancellationToken);
        codeResponse.EnsureSuccessStatusCode();

        var code = await codeResponse.Content.ReadFromJsonAsync<DeviceCodeResponse>(JsonOptions, cancellationToken)
                   ?? throw new InvalidOperationException("Empty device code response from GitHub.");

        // Surface the code + clickable link prominently in the dashboard. Not awaited: the dialog
        // stays up while we poll for completion in the background.
        _ = interaction.PromptNotificationAsync(
            "Sign in to GitHub Copilot",
            $"To let the bot use your GitHub Copilot access, open the link below and enter this code:\n\n" +
            $"**`{code.UserCode}`**\n\nWaiting for you to authorize…",
            new NotificationInteractionOptions
            {
                Intent = MessageIntent.Information,
                LinkUrl = code.VerificationUri,
                LinkText = "Open the GitHub device sign-in page",
                EnableMessageMarkdown = true,
            },
            cancellationToken);

        logger.LogWarning(
            "GitHub Copilot sign-in required. Open {Url} and enter code: {Code}",
            code.VerificationUri, code.UserCode);

        var interval = TimeSpan.FromSeconds(Math.Max(5, code.Interval));
        var deadline = DateTimeOffset.UtcNow.AddSeconds(code.ExpiresIn);

        while (DateTimeOffset.UtcNow < deadline)
        {
            cancellationToken.ThrowIfCancellationRequested();
            await Task.Delay(interval, cancellationToken);

            using var tokenResponse = await http.PostAsync(
                AccessTokenUrl,
                new FormUrlEncodedContent(new Dictionary<string, string>
                {
                    ["client_id"] = ClientId,
                    ["device_code"] = code.DeviceCode,
                    ["grant_type"] = DeviceGrantType,
                }),
                cancellationToken);

            var poll = await tokenResponse.Content.ReadFromJsonAsync<AccessTokenResponse>(JsonOptions, cancellationToken);
            if (poll is null)
            {
                continue;
            }

            if (!string.IsNullOrEmpty(poll.AccessToken))
            {
                return poll.AccessToken;
            }

            switch (poll.Error)
            {
                case "authorization_pending":
                    break;
                case "slow_down":
                    interval += TimeSpan.FromSeconds(5);
                    break;
                case "expired_token":
                    return null; // request a fresh code
                case "access_denied":
                    throw new InvalidOperationException("GitHub Copilot sign-in was denied.");
                default:
                    throw new InvalidOperationException($"Device-flow login failed: {poll.Error}.");
            }
        }

        return null; // expired locally; request a fresh code
    }

    private static void WriteCache(string accessToken)
    {
        var dir = Path.GetDirectoryName(CachePath)!;
        Directory.CreateDirectory(dir);
        var json = JsonSerializer.Serialize(new CachedOAuth(accessToken, DateTimeOffset.UtcNow), JsonOptions);
        File.WriteAllText(CachePath, json);
    }

    private sealed record CachedOAuth(
        [property: JsonPropertyName("access_token")] string AccessToken,
        [property: JsonPropertyName("created")] DateTimeOffset Created);

    private sealed class DeviceCodeResponse
    {
        [JsonPropertyName("device_code")] public string DeviceCode { get; set; } = "";
        [JsonPropertyName("user_code")] public string UserCode { get; set; } = "";
        [JsonPropertyName("verification_uri")] public string VerificationUri { get; set; } = "";
        [JsonPropertyName("expires_in")] public int ExpiresIn { get; set; } = 900;
        [JsonPropertyName("interval")] public int Interval { get; set; } = 5;
    }

    private sealed class AccessTokenResponse
    {
        [JsonPropertyName("access_token")] public string? AccessToken { get; set; }
        [JsonPropertyName("error")] public string? Error { get; set; }
    }
}
