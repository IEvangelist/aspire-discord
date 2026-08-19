using AspireDiscordBot.Core;
using AspireDiscordBot.Core.Documents;
using AspireDiscordBot.Ingestion;
using Scalar.AspNetCore;

var builder = WebApplication.CreateBuilder(args);

builder.AddServiceDefaults();
builder.AddAspireDiscordBotCore("qdrant");

// OpenAPI document (served at /openapi/v1.json) + a Scalar API reference UI (served at /scalar),
// surfaced as a link on the ingestion resource in the Aspire dashboard.
builder.Services.AddOpenApi();

// The ingestion coordinator (IngestionRunner) is registered by AddAspireDiscordBotCore.
builder.Services.AddHostedService<IngestionWorker>();

var app = builder.Build();

app.MapDefaultEndpoints();

app.MapOpenApi();
app.MapScalarApiReference();

// Admin endpoints backing the Aspire dashboard commands (see the AppHost's WithHttpCommand calls).
// POST /admin/reingest  -> incremental refresh (updates + adds pages)
// POST /admin/rebuild   -> full rebuild (drops the collection first; prunes deleted pages)
app.MapPost("/admin/reingest", async (IngestionRunner runner, CancellationToken cancellationToken) =>
{
    var outcome = await runner.RunAsync(force: false, "http", cancellationToken);
    return ToResult(outcome);
})
    .WithName("ReingestDocs")
    .WithSummary("Re-ingest docs (incremental)")
    .WithDescription("Re-reads the Aspire docs and updates the vector index incrementally, adding and updating changed pages. Returns 409 if an ingestion run is already in progress.")
    .WithTags("Admin")
    .Produces<RunOutcome>(StatusCodes.Status200OK)
    .Produces<RunOutcome>(StatusCodes.Status409Conflict)
    .Produces<RunOutcome>(StatusCodes.Status500InternalServerError);

app.MapPost("/admin/rebuild", async (IngestionRunner runner, CancellationToken cancellationToken) =>
{
    var outcome = await runner.RunAsync(force: true, "http", cancellationToken);
    return ToResult(outcome);
})
    .WithName("RebuildIndex")
    .WithSummary("Force rebuild index")
    .WithDescription("Drops the collection and rebuilds the whole index from scratch, pruning pages that no longer exist. Returns 409 if an ingestion run is already in progress.")
    .WithTags("Admin")
    .Produces<RunOutcome>(StatusCodes.Status200OK)
    .Produces<RunOutcome>(StatusCodes.Status409Conflict)
    .Produces<RunOutcome>(StatusCodes.Status500InternalServerError);

app.MapGet("/admin/status", (IngestionRunner runner) =>
    Results.Json(new { runner.IsRunning, last = runner.LastOutcome }))
    .WithName("IngestionStatus")
    .WithSummary("Ingestion status")
    .WithDescription("Reports whether an ingestion run is currently in progress and the outcome of the last completed run.")
    .WithTags("Admin");

app.Run();
return;

// A Busy request maps to 409 so the dashboard shows the command as rejected, not failed.
static IResult ToResult(RunOutcome outcome) => outcome.Status switch
{
    RunStatus.Busy => Results.Json(outcome, statusCode: StatusCodes.Status409Conflict),
    RunStatus.Failed => Results.Json(outcome, statusCode: StatusCodes.Status500InternalServerError),
    _ => Results.Json(outcome, statusCode: StatusCodes.Status200OK),
};
