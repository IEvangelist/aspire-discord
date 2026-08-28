using AspireDiscordBot.Core.Telemetry;

namespace AspireDiscordBot.Tests;

public sealed class GenAiTelemetryTests
{
    [Theory]
    [InlineData("azureaifoundry", "azure.ai.openai")]
    [InlineData("azureopenai", "azure.ai.openai")]
    [InlineData("ollama", "ollama")]
    [InlineData("openai", "openai")]
    public void ProviderName_UsesOpenTelemetryConventions(string provider, string expected)
    {
        Assert.Equal(expected, GenAiTelemetry.ProviderName(provider));
    }
}
