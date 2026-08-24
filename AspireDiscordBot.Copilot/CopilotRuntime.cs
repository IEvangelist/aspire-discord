using AspireDiscordBot.Core.Configuration;
using GitHub.Copilot;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace AspireDiscordBot.Copilot;

/// <summary>Owns one long-lived, server-safe GitHub Copilot SDK runtime.</summary>
public sealed class CopilotRuntime(
    IOptions<AiOptions> options,
    ILogger<CopilotRuntime> logger) : IHostedService, IAsyncDisposable
{
    private readonly AiOptions _options = options.Value;
    private readonly SemaphoreSlim _gate = new(1, 1);
    private CopilotClient? _client;

    public Task StartAsync(CancellationToken cancellationToken) => EnsureStartedAsync(cancellationToken);

    public async Task StopAsync(CancellationToken cancellationToken)
    {
        if (_client is not null)
        {
            await _client.StopAsync();
        }
    }

    public async Task<CopilotClient> GetClientAsync(CancellationToken cancellationToken = default)
    {
        await EnsureStartedAsync(cancellationToken);
        return _client!;
    }

    private async Task EnsureStartedAsync(CancellationToken cancellationToken)
    {
        if (_client is not null)
        {
            return;
        }

        await _gate.WaitAsync(cancellationToken);
        try
        {
            if (_client is not null)
            {
                return;
            }

            var baseDirectory = _options.Copilot.RuntimeBasePath;
            if (string.IsNullOrWhiteSpace(baseDirectory))
            {
                baseDirectory = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "AspireDiscordBot",
                    "copilot");
            }

            Directory.CreateDirectory(baseDirectory);
            var token = FirstNonEmpty(
                _options.Copilot.GitHubToken,
                Environment.GetEnvironmentVariable("COPILOT_GITHUB_TOKEN"));
            var otlpEndpoint = Environment.GetEnvironmentVariable("OTEL_EXPORTER_OTLP_ENDPOINT");

            _client = new CopilotClient(new CopilotClientOptions
            {
                Mode = CopilotClientMode.Empty,
                BaseDirectory = baseDirectory,
                WorkingDirectory = baseDirectory,
                GitHubToken = token,
                UseLoggedInUser = token is null && _options.Copilot.UseLoggedInUser,
                SessionIdleTimeoutSeconds = Math.Max(60, _options.Copilot.SessionIdleTimeoutSeconds),
                LogLevel = CopilotLogLevel.Warning,
                Logger = logger,
                Telemetry = string.IsNullOrWhiteSpace(otlpEndpoint)
                    ? null
                    : new TelemetryConfig
                    {
                        OtlpEndpoint = otlpEndpoint,
                        OtlpProtocol = "http/protobuf",
                        ExporterType = "otlp-http",
                        SourceName = "AspireDiscordBot.Copilot",
                        CaptureContent = _options.CaptureMessageContent,
                    },
            });

            try
            {
                await _client.StartAsync();
                logger.LogInformation("GitHub Copilot SDK runtime started in server-safe Empty mode.");
            }
            catch
            {
                await _client.DisposeAsync();
                _client = null;
                throw;
            }
        }
        finally
        {
            _gate.Release();
        }
    }

    public async ValueTask DisposeAsync()
    {
        if (_client is not null)
        {
            await _client.DisposeAsync();
        }

        _gate.Dispose();
    }

    private static string? FirstNonEmpty(params string?[] values) =>
        values.FirstOrDefault(value => !string.IsNullOrWhiteSpace(value));
}
