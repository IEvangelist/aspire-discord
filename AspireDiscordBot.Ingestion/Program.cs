using AspireDiscordBot.Core;
using AspireDiscordBot.Core.Documents;
using AspireDiscordBot.Ingestion;

var builder = WebApplication.CreateBuilder(args);

builder.AddServiceDefaults();
builder.AddAspireDiscordBotCore("qdrant");

// The ingestion coordinator (IngestionRunner) is registered by AddAspireDiscordBotCore.
builder.Services.AddHostedService<IngestionWorker>();

var app = builder.Build();

app.MapDefaultEndpoints();

// Admin endpoints backing the Aspire dashboard commands (see the AppHost's WithHttpCommand calls).
// POST /admin/reingest  -> incremental refresh (updates + adds pages)
// POST /admin/rebuild   -> full rebuild (drops the collection first; prunes deleted pages)
app.MapPost("/admin/reingest", async (IngestionRunner runner, CancellationToken cancellationToken) =>
{
    var outcome = await runner.RunAsync(force: false, "http", cancellationToken);
    return ToResult(outcome);
});

app.MapPost("/admin/rebuild", async (IngestionRunner runner, CancellationToken cancellationToken) =>
{
    var outcome = await runner.RunAsync(force: true, "http", cancellationToken);
    return ToResult(outcome);
});

app.MapGet("/admin/status", (IngestionRunner runner) =>
    Results.Json(new { runner.IsRunning, last = runner.LastOutcome }));

app.Run();
return;

// A Busy request maps to 409 so the dashboard shows the command as rejected, not failed.
static IResult ToResult(RunOutcome outcome) => outcome.Status switch
{
    RunStatus.Busy => Results.Json(outcome, statusCode: StatusCodes.Status409Conflict),
    RunStatus.Failed => Results.Json(outcome, statusCode: StatusCodes.Status500InternalServerError),
    _ => Results.Json(outcome, statusCode: StatusCodes.Status200OK),
};
