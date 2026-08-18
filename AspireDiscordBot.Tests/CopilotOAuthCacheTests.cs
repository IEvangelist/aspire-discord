using AspireDiscordBot.Core.Ai;

namespace AspireDiscordBot.Tests;

public class CopilotOAuthCacheTests : IDisposable
{
    private readonly string _path = Path.Combine(Path.GetTempPath(), $"copilot-oauth-{Guid.NewGuid():N}.json");

    [Fact]
    public void Read_ReturnsNull_WhenFileMissing()
    {
        Assert.Null(CopilotOAuthCache.Read(_path));
    }

    [Fact]
    public void WriteThenRead_RoundTripsToken()
    {
        CopilotOAuthCache.Write(_path, "gho_exampletoken");
        Assert.Equal("gho_exampletoken", CopilotOAuthCache.Read(_path));
    }

    [Fact]
    public void Read_ParsesTheAppHostWrittenFormat()
    {
        // This is the exact on-disk shape the AppHost's CopilotSignIn.WriteCache produces. If the
        // two ever drift, the dashboard sign-in would silently fail to hand the token to the
        // services — so we pin the contract here.
        var appHostJson = """{"access_token":"gho_fromapphost","created":"2026-08-18T20:51:00+00:00"}""";
        File.WriteAllText(_path, appHostJson);

        Assert.Equal("gho_fromapphost", CopilotOAuthCache.Read(_path));
    }

    [Fact]
    public void Read_ReturnsNull_ForEmptyToken()
    {
        File.WriteAllText(_path, """{"access_token":"","created":"2026-08-18T20:51:00+00:00"}""");
        Assert.Null(CopilotOAuthCache.Read(_path));
    }

    [Fact]
    public void Delete_RemovesTheCache()
    {
        CopilotOAuthCache.Write(_path, "tok");
        CopilotOAuthCache.Delete(_path);
        Assert.False(File.Exists(_path));
    }

    public void Dispose()
    {
        try { File.Delete(_path); } catch { /* ignore */ }
    }
}
