using System.Text.Json;
using System.Text.Json.Serialization;

namespace AspireDiscordBot.Core.Ai;

/// <summary>
/// Reads and writes the shared GitHub Copilot OAuth token cache. The AppHost (which performs the
/// interactive sign-in) and the services (which consume the token) both use this exact on-disk
/// format and path, so a mismatch can't silently break the hand-off.
/// </summary>
public static class CopilotOAuthCache
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    /// <summary>The default cache path: <c>%USERPROFILE%/.aspire-discord/copilot-oauth.json</c>.</summary>
    public static string DefaultPath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
        ".aspire-discord",
        "copilot-oauth.json");

    /// <summary>Reads the cached OAuth access token, or null when absent/empty/invalid.</summary>
    public static string? Read(string path)
    {
        try
        {
            if (!File.Exists(path))
            {
                return null;
            }

            var cached = JsonSerializer.Deserialize<CachedOAuth>(File.ReadAllText(path), JsonOptions);
            return string.IsNullOrWhiteSpace(cached?.AccessToken) ? null : cached!.AccessToken;
        }
        catch
        {
            return null;
        }
    }

    /// <summary>Writes the OAuth access token to the cache, creating the directory if needed.</summary>
    public static void Write(string path, string accessToken)
    {
        var dir = Path.GetDirectoryName(path);
        if (!string.IsNullOrEmpty(dir))
        {
            Directory.CreateDirectory(dir);
        }

        var json = JsonSerializer.Serialize(new CachedOAuth(accessToken, DateTimeOffset.UtcNow), JsonOptions);
        File.WriteAllText(path, json);
    }

    /// <summary>Deletes the cached token if present.</summary>
    public static void Delete(string path)
    {
        try
        {
            if (File.Exists(path))
            {
                File.Delete(path);
            }
        }
        catch
        {
            // Best effort.
        }
    }

    private sealed record CachedOAuth(
        [property: JsonPropertyName("access_token")] string AccessToken,
        [property: JsonPropertyName("created")] DateTimeOffset Created);
}
