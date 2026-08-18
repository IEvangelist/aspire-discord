using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;
using AspireDiscordBot.Core.Configuration;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace AspireDiscordBot.Core.Ai;

/// <summary>
/// Supplies a valid GitHub Copilot bearer token so the bot can inherit the operator's Copilot
/// entitlement. It performs a one-time GitHub device-flow login (caching the resulting OAuth
/// token on disk), then exchanges that OAuth token for the short-lived Copilot token used by the
/// Copilot API, refreshing it automatically before it expires.
/// </summary>
public sealed class CopilotTokenProvider(
    IHttpClientFactory httpFactory,
    IOptions<AiOptions> options,
    ILogger<CopilotTokenProvider> logger)
{
    private const string DeviceCodeUrl = "https://github.com/login/device/code";
    private const string AccessTokenUrl = "https://github.com/login/oauth/access_token";
    private const string CopilotTokenUrl = "https://api.github.com/copilot_internal/v2/token";
    private const string DeviceGrantType = "urn:ietf:params:oauth:grant-type:device_code";

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    private readonly CopilotOptions _copilot = options.Value.Copilot;
    private readonly SemaphoreSlim _gate = new(1, 1);

    private string? _copilotToken;
    private DateTimeOffset _copilotTokenExpiry = DateTimeOffset.MinValue;

    /// <summary>Returns a currently-valid Copilot bearer token, refreshing or logging in as needed.</summary>
    public async Task<string> GetTokenAsync(CancellationToken cancellationToken = default)
    {
        // Refresh a couple of minutes early to avoid using a token that expires mid-request.
        if (_copilotToken is not null && DateTimeOffset.UtcNow < _copilotTokenExpiry - TimeSpan.FromMinutes(2))
        {
            return _copilotToken;
        }

        await _gate.WaitAsync(cancellationToken);
        try
        {
            if (_copilotToken is not null && DateTimeOffset.UtcNow < _copilotTokenExpiry - TimeSpan.FromMinutes(2))
            {
                return _copilotToken;
            }

            var oauthToken = await EnsureOAuthTokenAsync(cancellationToken);
            var (token, expiry) = await ExchangeForCopilotTokenAsync(oauthToken, cancellationToken);
            _copilotToken = token;
            _copilotTokenExpiry = expiry;
            logger.LogInformation("Acquired a Copilot token (valid until {Expiry:u}).", expiry);
            return token;
        }
        finally
        {
            _gate.Release();
        }
    }

    private async Task<string> EnsureOAuthTokenAsync(CancellationToken cancellationToken)
    {
        var cached = ReadCachedOAuthToken();
        if (cached is not null)
        {
            return cached;
        }

        // When interactive sign-in is disabled, this service must not prompt. The AppHost performs
        // the device-flow sign-in (surfacing it in the dashboard) and writes the shared cache;
        // here we just wait for that token to appear.
        if (!_copilot.InteractiveSignIn)
        {
            return await WaitForCachedTokenAsync(cancellationToken);
        }

        // Serialize device-flow login across processes (ingestion + bot) so it happens only once.
        using var loginMutex = new Mutex(initiallyOwned: false, "aspire-discord-copilot-login");
        var held = false;
        try
        {
            try { held = loginMutex.WaitOne(TimeSpan.FromMinutes(10)); }
            catch (AbandonedMutexException) { held = true; }

            // Another process may have completed the login while we waited.
            cached = ReadCachedOAuthToken();
            if (cached is not null)
            {
                return cached;
            }

            var token = await PerformDeviceFlowAsync(cancellationToken);
            WriteCachedOAuthToken(token);
            return token;
        }
        finally
        {
            if (held)
            {
                loginMutex.ReleaseMutex();
            }
        }
    }

    /// <summary>Polls for the shared cached OAuth token (written by the AppHost) until it appears.</summary>
    private async Task<string> WaitForCachedTokenAsync(CancellationToken cancellationToken)
    {
        var deadline = DateTimeOffset.UtcNow.AddSeconds(Math.Max(30, _copilot.SignInWaitSeconds));
        var logged = false;

        while (DateTimeOffset.UtcNow < deadline)
        {
            var cached = ReadCachedOAuthToken();
            if (cached is not null)
            {
                return cached;
            }

            if (!logged)
            {
                logger.LogInformation(
                    "Waiting for GitHub Copilot sign-in. Complete the prompt shown in the Aspire dashboard.");
                logged = true;
            }

            await Task.Delay(TimeSpan.FromSeconds(3), cancellationToken);
        }

        throw new TimeoutException(
            "Timed out waiting for the GitHub Copilot sign-in to complete in the Aspire dashboard.");
    }

    private async Task<string> PerformDeviceFlowAsync(CancellationToken cancellationToken)
    {
        // Device codes expire (~15 min). Re-request a fresh code if the user hasn't authorized in
        // time, so a slow sign-in doesn't permanently fail ingestion/startup.
        var overallDeadline = DateTimeOffset.UtcNow.AddMinutes(60);

        while (DateTimeOffset.UtcNow < overallDeadline)
        {
            cancellationToken.ThrowIfCancellationRequested();

            var token = await RunSingleDeviceCodeAsync(cancellationToken);
            if (token is not null)
            {
                return token;
            }

            logger.LogWarning("The GitHub sign-in code expired before it was entered. Requesting a new code...");
        }

        throw new TimeoutException("GitHub Copilot sign-in timed out. Restart the app to try again.");
    }

    /// <summary>Requests one device code and polls it. Returns the token, or null if the code expired.</summary>
    private async Task<string?> RunSingleDeviceCodeAsync(CancellationToken cancellationToken)
    {
        var http = httpFactory.CreateClient("github-auth");

        using var codeResponse = await http.PostAsync(
            DeviceCodeUrl,
            new FormUrlEncodedContent(new Dictionary<string, string>
            {
                ["client_id"] = _copilot.ClientId,
                ["scope"] = "read:user",
            }),
            cancellationToken);
        codeResponse.EnsureSuccessStatusCode();

        var code = await codeResponse.Content.ReadFromJsonAsync<DeviceCodeResponse>(JsonOptions, cancellationToken)
                   ?? throw new InvalidOperationException("Empty device code response from GitHub.");

        // Surface the login prompt prominently — this is the one-time interactive step.
        logger.LogWarning(
            "GitHub Copilot sign-in required. Visit {Url} and enter code: {Code}",
            code.VerificationUri, code.UserCode);
        Console.WriteLine();
        Console.WriteLine("============================================================");
        Console.WriteLine("  Sign in to GitHub to grant Copilot access to the bot:");
        Console.WriteLine($"    1. Open: {code.VerificationUri}");
        Console.WriteLine($"    2. Enter code: {code.UserCode}");
        Console.WriteLine("============================================================");
        Console.WriteLine();

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
                    ["client_id"] = _copilot.ClientId,
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
                logger.LogInformation("GitHub Copilot sign-in complete.");
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

    private async Task<(string Token, DateTimeOffset Expiry)> ExchangeForCopilotTokenAsync(
        string oauthToken, CancellationToken cancellationToken)
    {
        var http = httpFactory.CreateClient("github-auth");

        using var request = new HttpRequestMessage(HttpMethod.Get, CopilotTokenUrl);
        request.Headers.TryAddWithoutValidation("Authorization", $"token {oauthToken}");

        using var response = await http.SendAsync(request, cancellationToken);
        if (response.StatusCode is System.Net.HttpStatusCode.Unauthorized or System.Net.HttpStatusCode.Forbidden)
        {
            // The cached OAuth token is stale or lacks Copilot access — force a fresh login next time.
            DeleteCachedOAuthToken();
            throw new InvalidOperationException(
                "The cached GitHub token was rejected by Copilot. It has been cleared; rerun to sign in again.");
        }

        response.EnsureSuccessStatusCode();
        var payload = await response.Content.ReadFromJsonAsync<CopilotTokenResponse>(JsonOptions, cancellationToken)
                      ?? throw new InvalidOperationException("Empty Copilot token response.");

        if (string.IsNullOrEmpty(payload.Token))
        {
            throw new InvalidOperationException("Copilot token response did not contain a token.");
        }

        var expiry = DateTimeOffset.FromUnixTimeSeconds(payload.ExpiresAt);
        return (payload.Token, expiry);
    }

    private string CachePath
    {
        get
        {
            if (!string.IsNullOrWhiteSpace(_copilot.OAuthTokenPath))
            {
                return _copilot.OAuthTokenPath!;
            }

            var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            return Path.Combine(home, ".aspire-discord", "copilot-oauth.json");
        }
    }

    private string? ReadCachedOAuthToken() => CopilotOAuthCache.Read(CachePath);

    private void WriteCachedOAuthToken(string token)
    {
        try
        {
            CopilotOAuthCache.Write(CachePath, token);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Failed to cache Copilot OAuth token at {Path}.", CachePath);
        }
    }

    private void DeleteCachedOAuthToken() => CopilotOAuthCache.Delete(CachePath);

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

    private sealed class CopilotTokenResponse
    {
        [JsonPropertyName("token")] public string Token { get; set; } = "";
        [JsonPropertyName("expires_at")] public long ExpiresAt { get; set; }
    }
}
