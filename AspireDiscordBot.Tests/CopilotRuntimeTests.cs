using AspireDiscordBot.Copilot;
using AspireDiscordBot.Core.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

namespace AspireDiscordBot.Tests;

public sealed class CopilotRuntimeTests
{
    [Fact]
    public async Task BundledRuntime_StartsAndAnswersPing_InEmptyMode()
    {
        var basePath = Path.Combine(
            Path.GetTempPath(),
            "aspire-discord-copilot-tests",
            Guid.NewGuid().ToString("N"));
        var options = Options.Create(new AiOptions
        {
            Copilot = new CopilotOptions
            {
                RuntimeBasePath = basePath,
                UseLoggedInUser = false,
            },
        });

        await using var runtime = new CopilotRuntime(
            options,
            NullLogger<CopilotRuntime>.Instance);
        try
        {
            await runtime.StartAsync(CancellationToken.None);
            var client = await runtime.GetClientAsync();
            var response = await client.PingAsync("aspire-discord-smoke");
            Assert.NotNull(response);
        }
        finally
        {
            await runtime.StopAsync(CancellationToken.None);
            if (Directory.Exists(basePath))
            {
                Directory.Delete(basePath, recursive: true);
            }
        }
    }
}
