using System.Net;
using System.Text;
using System.Text.Json;
using Azure.Core;
using AspireDiscordBot.Core.Ai;
using AspireDiscordBot.Core.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

namespace AspireDiscordBot.Tests;

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
    public async Task OpenAiEmbeddingsSendBearerAuthenticationAndPreserveOrder()
    {
        var client = CreateClient("openai", "credential");

        var vectors = await client.EmbedAsync(["hello", "world"]);

        Assert.Equal(2, vectors.Count);
        Assert.Equal([1f, 0f, 0f, 0f], vectors[0]);
        Assert.Equal([0f, 1f, 0f, 0f], vectors[1]);
        var request = Assert.Single(_requests);
        Assert.StartsWith("Bearer ", request.Auth);
        Assert.True(request.Auth.Length > "Bearer ".Length);
        Assert.Contains("/v1/embeddings", request.Path);
    }

    [Fact]
    public async Task AzureOpenAiEmbeddingsUseDeploymentRouteAndApiKeyHeader()
    {
        var client = CreateClient("azureopenai", "credential");

        await client.EmbedAsync(["hello"]);

        var request = Assert.Single(_requests);
        Assert.DoesNotContain("Bearer ", request.Auth);
        Assert.NotEmpty(request.Auth);
        Assert.Contains(
            "/openai/deployments/test-embedding/embeddings?api-version=2024-10-21",
            request.Path);
    }

    [Fact]
    public async Task FoundryEmbeddingsUseV1RouteAndEntraBearerToken()
    {
        var client = CreateClient("azureaifoundry", "");

        await client.EmbedAsync(["hello"]);

        var request = Assert.Single(_requests);
        Assert.Equal("Bearer foundry-token", request.Auth);
        Assert.Contains("/openai/v1/embeddings", request.Path);
        Assert.DoesNotContain("api-version", request.Path);
        Assert.Contains("\"dimensions\":4", request.Body);
        Assert.Contains("\"model\":\"test-embedding\"", request.Body);
    }

    [Fact]
    public async Task OllamaEmbeddingsDoNotInheritAnotherProvidersKey()
    {
        var options = Options.Create(new AiOptions
        {
            Provider = "openai",
            ApiKey = "credential",
            EmbeddingProvider = "ollama",
            EmbeddingEndpoint = _prefix.TrimEnd('/'),
            EmbeddingModel = "test-embedding",
            EmbeddingDimensions = 4,
        });
        var client = CreateClient(options);

        await client.EmbedAsync(["hello"]);

        var request = Assert.Single(_requests);
        Assert.Empty(request.Auth);
        Assert.DoesNotContain("\"dimensions\"", request.Body);
    }

    [Fact]
    public async Task SameProviderDoesNotInheritKeyAcrossDifferentEndpoints()
    {
        var options = Options.Create(new AiOptions
        {
            Provider = "openai",
            Endpoint = "https://chat.example.invalid",
            ApiKey = "credential",
            EmbeddingProvider = "openai",
            EmbeddingEndpoint = _prefix.TrimEnd('/'),
            EmbeddingModel = "test-embedding",
            EmbeddingDimensions = 4,
        });
        var client = CreateClient(options);

        var error = await Assert.ThrowsAsync<InvalidOperationException>(
            () => client.EmbedAsync(["hello"]));

        Assert.Contains("requires Ai:EmbeddingApiKey", error.Message);
        Assert.Empty(_requests);
    }

    [Fact]
    public async Task CopilotEmbeddingsAreRejected()
    {
        var client = CreateClient("copilot", "");

        var error = await Assert.ThrowsAsync<InvalidOperationException>(
            () => client.EmbedAsync(["hello"]));

        Assert.Contains("does not expose a supported embeddings API", error.Message);
    }

    private OpenAiCompatibleClient CreateClient(string provider, string apiKey)
    {
        return CreateClient(Options.Create(new AiOptions
        {
            Provider = provider,
            Endpoint = _prefix.TrimEnd('/'),
            ApiKey = apiKey,
            EmbeddingProvider = provider,
            EmbeddingEndpoint = _prefix.TrimEnd('/'),
            EmbeddingApiKey = apiKey,
            EmbeddingModel = "test-embedding",
            EmbeddingDimensions = 4,
            ApiVersion = "2024-10-21",
        }));
    }

    private static OpenAiCompatibleClient CreateClient(IOptions<AiOptions> options)
    {
        return new OpenAiCompatibleClient(
            new SingleClientFactory(),
            options,
            new TestTokenCredential(),
            NullLogger<OpenAiCompatibleClient>.Instance);
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
            var auth = context.Request.Headers["api-key"]
                ?? context.Request.Headers["Authorization"]
                ?? "";
            using var reader = new StreamReader(
                context.Request.InputStream,
                context.Request.ContentEncoding);
            var body = await reader.ReadToEndAsync();
            _requests.Add((path, auth, body));

            using var request = JsonDocument.Parse(body);
            var inputCount = request.RootElement.GetProperty("input").GetArrayLength();
            var data = Enumerable.Range(0, inputCount)
                .Select(index => new
                {
                    index,
                    embedding = Enumerable.Range(0, 4)
                        .Select(dimension => dimension == index ? 1f : 0f)
                        .ToArray(),
                });
            var json = JsonSerializer.Serialize(new { data });
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
        try
        {
            _listener.Stop();
        }
        catch
        {
            // Listener may already be closed.
        }
        ((IDisposable)_listener).Dispose();
    }

    private sealed class SingleClientFactory : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new();
    }

    private sealed class TestTokenCredential : TokenCredential
    {
        public override AccessToken GetToken(
            TokenRequestContext requestContext,
            CancellationToken cancellationToken)
        {
            Assert.Contains("https://ai.azure.com/.default", requestContext.Scopes);
            return new AccessToken("foundry-token", DateTimeOffset.UtcNow.AddHours(1));
        }

        public override ValueTask<AccessToken> GetTokenAsync(
            TokenRequestContext requestContext,
            CancellationToken cancellationToken) =>
            ValueTask.FromResult(GetToken(requestContext, cancellationToken));
    }
}
