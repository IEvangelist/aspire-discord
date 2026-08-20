using AspireDiscordBot.Core;
using AspireDiscordBot.Core.Evals;
using AspireDiscordBot.Core.Rag;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Xunit.Abstractions;

namespace AspireDiscordBot.Tests;

/// <summary>
/// Runs the curated answer-quality eval fixture against the <b>real</b> agentic pipeline. Opt-in:
/// requires LIVE_EVAL_QDRANT (a Qdrant connection string pointing at the populated collections) and
/// a usable Copilot sign-in. Optional: LIVE_EVAL_API_SRC (aspire src path) and LIVE_EVAL_GH_TOKEN
/// enable the search_api / live GitHub tools. Skipped in normal CI.
///
/// Run it (with the app's Qdrant up) e.g.:
///   $env:LIVE_EVAL_QDRANT = "Endpoint=http://localhost:16665;Key=YOUR_KEY"
///   $env:LIVE_EVAL_API_SRC = "D:\GitHub\aspire\src"
///   $env:LIVE_EVAL_GH_TOKEN = (gh auth token)
///   dotnet test --filter FullyQualifiedName~AnswerQualityEvalTests
/// </summary>
public sealed class AnswerQualityEvalTests(ITestOutputHelper output)
{
    private static string? Qdrant => Environment.GetEnvironmentVariable("LIVE_EVAL_QDRANT");

    [SkippableFact]
    public async Task Fixture_MeetsQualityThreshold()
    {
        Skip.If(string.IsNullOrWhiteSpace(Qdrant), "LIVE_EVAL_QDRANT not set.");

        var settings = new Dictionary<string, string?>
        {
            ["ConnectionStrings:qdrant"] = Qdrant,
            ["Ai:Provider"] = "copilot",
            ["Ai:ChatModel"] = "gpt-5.6-sol",
            ["Ai:EmbeddingModel"] = "text-embedding-3-small",
            ["Ai:EmbeddingDimensions"] = "1536",
            ["Ai:ReasoningEffort"] = "low",
            ["Ai:MaxOutputTokens"] = "2000",
            ["Ingestion:CollectionName"] = "aspire_docs",
            ["ApiSurface:LocalSrcPath"] = Environment.GetEnvironmentVariable("LIVE_EVAL_API_SRC"),
            ["ApiSurface:CollectionName"] = "aspire_api",
            ["LiveSearch:GitHubToken"] = Environment.GetEnvironmentVariable("LIVE_EVAL_GH_TOKEN"),
            ["Agent:Mode"] = "agentic",
        };

        var builder = Host.CreateApplicationBuilder();
        builder.Configuration.AddInMemoryCollection(settings);
        builder.AddAspireDiscordBotCore("qdrant");
        using var host = builder.Build();

        var runner = new EvalRunner(host.Services.GetRequiredService<IAnswerService>());
        var report = await runner.RunAsync(EvalFixture.Default());

        output.WriteLine(report.Summary());

        // Require a high pass rate; the summary above pinpoints any regressions.
        Assert.True(report.PassRate >= 0.85,
            $"Answer-quality pass rate {report.PassRate:P0} is below threshold.\n{report.Summary()}");
    }
}
