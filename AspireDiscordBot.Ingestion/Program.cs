using AspireDiscordBot.Core;
using AspireDiscordBot.Ingestion;

var builder = Host.CreateApplicationBuilder(args);

builder.AddServiceDefaults();
builder.AddAspireDiscordBotCore("qdrant");

builder.Services.AddHostedService<IngestionWorker>();

var host = builder.Build();
host.Run();
