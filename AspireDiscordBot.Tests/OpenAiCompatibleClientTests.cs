using System.Net;
using System.Text;
using System.Text.Json;
using AspireDiscordBot.Core.Ai;
using AspireDiscordBot.Core.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

namespace AspireDiscordBot.Tests;

/// <summary>
/// Exercises <see cref="OpenAiCompatibleClient"/> over a real HTTP round-trip using a local
/// stub that speaks the OpenAI chat/embeddings wire format. Verifies URL construction, the
/// auth header, and request/response (de)serialization without needing a real provider.
/// </summary>
public sealed class OpenAiCompatibleClientTests : IDisposable
{
    private readonly HttpListener _listener = new();
    private readonly string _prefix;
    private readonly List<(string Path, string Auth, string Body)> _requests = [];

    public OpenAiCompatibleClientTests()
    {
        var port = GetFreePort();
        _prefix = $"http://localhost:{port}/";
        _listener.Prefixes.Add(_prefix);
        _listener.Start();
        _ = Task.Run(HandleRequestsAsync);
    }

    [Fact]
    public async Task Embed_SendsAuthHeader_AndParsesVectors()
    {
        var client = CreateClient("openai");

        var vectors = await client.EmbedAsync(["hello", "world"]);

        Assert.Equal(2, vectors.Count);
        Assert.Equal(4, vectors[0].Length);
        var embedRequest = _requests.Single(r => r.Path.Contains("embeddings"));
        Assert.Equal("Bearer test-key", embedRequest.Auth);
        Assert.Contains("\"input\"", embedRequest.Body);
    }

    [Fact]
    public async Task Complete_ParsesAssistantMessage()
    {
        var client = CreateClient("openai");

        var reply = await client.CompleteAsync([AiChatMessage.System("s"), AiChatMessage.User("hi")]);

        Assert.Equal("stub answer", reply);
        var chatRequest = _requests.Single(r => r.Path.Contains("chat/completions"));
        Assert.Contains("\"messages\"", chatRequest.Body);
    }

    [Fact]
    public async Task AzureOpenAi_BuildsDeploymentUrl_AndApiKeyHeader()
    {
        var client = CreateClient("azureopenai");

        await client.CompleteAsync([AiChatMessage.User("hi")]);

        var request = _requests.Single(r => r.Path.Contains("chat/completions"));
        Assert.Contains("/openai/deployments/gpt-4o-mini/chat/completions", request.Path);
        Assert.Contains("api-version=", request.Path);
        Assert.Equal("test-key", request.Auth); // api-key header, not Bearer
    }

    private OpenAiCompatibleClient CreateClient(string provider)
    {
        var options = Options.Create(new AiOptions
        {
            Provider = provider,
            Endpoint = _prefix.TrimEnd('/'),
            ApiKey = "test-key",
            ChatModel = "gpt-4o-mini",
            EmbeddingModel = "text-embedding-3-small",
            ApiVersion = "2024-10-21",
        });

        var factory = new SingleClientFactory();
        var copilot = new CopilotTokenProvider(factory, options, NullLogger<CopilotTokenProvider>.Instance);
        return new OpenAiCompatibleClient(factory, copilot, options, NullLogger<OpenAiCompatibleClient>.Instance);
    }

    private async Task HandleRequestsAsync()
    {
        while (_listener.IsListening)
        {
            HttpListenerContext context;
            try
            {
                context = await _listener.GetContextAsync();
            }
            catch
            {
                return;
            }

            var path = context.Request.Url!.PathAndQuery;
            var auth = context.Request.Headers["api-key"] ?? context.Request.Headers["Authorization"] ?? "";
            using var reader = new StreamReader(context.Request.InputStream, context.Request.ContentEncoding);
            var body = await reader.ReadToEndAsync();
            _requests.Add((path, auth, body));

            var json = path.Contains("embeddings")
                ? """{"data":[{"index":0,"embedding":[0.1,0.2,0.3,0.4]},{"index":1,"embedding":[0.5,0.6,0.7,0.8]}]}"""
                : """{"choices":[{"message":{"content":"stub answer"}}]}""";

            var bytes = Encoding.UTF8.GetBytes(json);
            context.Response.ContentType = "application/json";
            context.Response.StatusCode = 200;
            await context.Response.OutputStream.WriteAsync(bytes);
            context.Response.Close();
        }
    }

    private static int GetFreePort()
    {
        var listener = new System.Net.Sockets.TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        listener.Stop();
        return port;
    }

    public void Dispose()
    {
        try { _listener.Stop(); } catch { /* ignore */ }
        ((IDisposable)_listener).Dispose();
    }

    /// <summary>Minimal IHttpClientFactory that returns a fresh HttpClient per call.</summary>
    private sealed class SingleClientFactory : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new();
    }
}
