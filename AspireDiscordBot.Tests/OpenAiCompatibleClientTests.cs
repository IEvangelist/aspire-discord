using System.Net;
using System.Text;
using AspireDiscordBot.Core.Ai;
using AspireDiscordBot.Core.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

namespace AspireDiscordBot.Tests;

/// <summary>
/// Exercises <see cref="OpenAiCompatibleClient"/> over a real HTTP round-trip using a local
/// stub. Verifies URL construction (Responses API for chat, chat/completions for Ollama),
/// the auth header, and request/response (de)serialization without needing a real provider.
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
    public async Task Complete_UsesResponsesApi_AndAggregatesOutputText()
    {
        var client = CreateClient("openai");

        var reply = await client.CompleteAsync([AiChatMessage.System("s"), AiChatMessage.User("hi")]);

        Assert.Equal("stub answer", reply);
        var chatRequest = _requests.Single(r => r.Path.Contains("/responses"));
        Assert.Contains("/v1/responses", chatRequest.Path);
        Assert.Contains("\"input\"", chatRequest.Body);
    }

    [Fact]
    public async Task AzureOpenAi_UsesV1ResponsesUrl_AndApiKeyHeader()
    {
        var client = CreateClient("azureopenai");

        await client.CompleteAsync([AiChatMessage.User("hi")]);

        var request = _requests.Single(r => r.Path.Contains("/responses"));
        Assert.Contains("/openai/v1/responses", request.Path);
        Assert.DoesNotContain("/deployments/", request.Path); // v1 surface: model in body, not URL
        Assert.Contains("\"model\":\"gpt-4o-mini\"", request.Body);
        Assert.Equal("test-key", request.Auth); // api-key header, not Bearer
    }

    [Fact]
    public async Task Ollama_UsesChatCompletions_AndSendsNoAuthWhenKeyEmpty()
    {
        var client = CreateClient("ollama", apiKey: "");

        await client.CompleteAsync([AiChatMessage.User("hi")]);

        var request = _requests.Single(r => r.Path.Contains("chat/completions"));
        Assert.Contains("/v1/chat/completions", request.Path);
        Assert.Equal("", request.Auth); // no Authorization / api-key header for local Ollama
    }

    [Fact]
    public async Task OllamaChat_SendsConfiguredBearerToken()
    {
        var client = CreateClient("ollama", apiKey: "ollama-secret");

        await client.CompleteAsync([AiChatMessage.User("hi")]);

        Assert.Equal(
            "Bearer ollama-secret",
            _requests.Single(request => request.Path.Contains("chat/completions")).Auth);
    }

    [Fact]
    public async Task CopilotChat_IsRejectedByLegacyHttpClient()
    {
        var client = CreateClient("copilot");

        var error = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            client.CompleteAsync([AiChatMessage.User("hi")]));

        Assert.Contains("GitHub.Copilot.SDK", error.Message);
    }

    [Fact]
    public async Task CopilotEmbeddings_RequireASeparateSupportedProvider()
    {
        var client = CreateClient("copilot");

        var error = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            client.EmbedAsync(["hello"]));

        Assert.Contains("EmbeddingProvider", error.Message);
    }

    [Fact]
    public async Task SeparateOllamaEmbeddings_DoNotReceiveChatApiKey()
    {
        var options = Options.Create(new AiOptions
        {
            Provider = "openai",
            Endpoint = _prefix.TrimEnd('/'),
            ApiKey = "chat-secret",
            ChatModel = "gpt-4o-mini",
            EmbeddingProvider = "ollama",
            EmbeddingEndpoint = _prefix.TrimEnd('/'),
            EmbeddingModel = "nomic-embed-text",
        });
        var client = new OpenAiCompatibleClient(
            new SingleClientFactory(),
            options,
            NullLogger<OpenAiCompatibleClient>.Instance);

        await client.EmbedAsync(["hello"]);

        Assert.Equal("", _requests.Single(request => request.Path.Contains("embeddings")).Auth);
    }

    private OpenAiCompatibleClient CreateClient(string provider, string apiKey = "test-key")
    {
        var options = Options.Create(new AiOptions
        {
            Provider = provider,
            Endpoint = _prefix.TrimEnd('/'),
            ApiKey = apiKey,
            ChatModel = "gpt-4o-mini",
            EmbeddingModel = "text-embedding-3-small",
            ApiVersion = "2024-10-21",
        });

        var factory = new SingleClientFactory();
        return new OpenAiCompatibleClient(factory, options, NullLogger<OpenAiCompatibleClient>.Instance);
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

            string json;
            if (path.Contains("embeddings"))
            {
                json = """{"data":[{"index":0,"embedding":[0.1,0.2,0.3,0.4]},{"index":1,"embedding":[0.5,0.6,0.7,0.8]}]}""";
            }
            else if (path.Contains("/responses"))
            {
                // Mirrors the real Responses shape: output_text is null and the text must be
                // aggregated from the message item, skipping the leading reasoning item.
                json = """{"output_text":null,"output":[{"type":"reasoning","content":[]},{"type":"message","content":[{"type":"output_text","text":"stub answer"}]}]}""";
            }
            else
            {
                json = """{"choices":[{"message":{"content":"stub answer"}}]}""";
            }

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
