using AspireDiscordBot.Bot;
using AspireDiscordBot.Core;
using Discord;
using Discord.WebSocket;
using Microsoft.Extensions.Options;
using Scalar.AspNetCore;

var builder = WebApplication.CreateBuilder(args);

builder.AddServiceDefaults();
builder.AddAspireDiscordBotCore("qdrant");

// OpenAPI document (served at /openapi/v1.json) + a Scalar API reference UI (served at /scalar),
// surfaced as a link on the bot resource in the Aspire dashboard.
builder.Services.AddOpenApi();

builder.Services.Configure<DiscordOptions>(builder.Configuration.GetSection(DiscordOptions.SectionName));

builder.Services.AddSingleton(sp =>
{
    var opts = sp.GetRequiredService<IOptions<DiscordOptions>>().Value;

    var intents = GatewayIntents.Guilds;
    if (opts.MentionEnabled)
    {
        // Message Content is a privileged intent; enable it in the Discord Developer Portal.
        intents |= GatewayIntents.GuildMessages | GatewayIntents.MessageContent;
    }

    return new DiscordSocketClient(new DiscordSocketConfig
    {
        GatewayIntents = intents,
        LogLevel = LogSeverity.Info,
        AlwaysDownloadUsers = false,
    });
});

builder.Services.AddSingleton<DiscordResponseFormatter>();
builder.Services.AddSingleton<ConversationContextReader>();
builder.Services.AddHostedService<DiscordBotService>();

var app = builder.Build();

app.MapDefaultEndpoints();

app.MapOpenApi();
app.MapScalarApiReference();

// Live gateway status for the bot, useful from the dashboard for a quick health glance.
app.MapGet("/status", (DiscordSocketClient client, IOptions<DiscordOptions> options) =>
    new BotStatus(
        Connection: client.ConnectionState.ToString(),
        LatencyMs: client.Latency,
        Guilds: client.Guilds.Count,
        MentionEnabled: options.Value.MentionEnabled,
        BotUser: client.CurrentUser?.ToString()))
    .WithName("BotStatus")
    .WithSummary("Discord gateway status")
    .WithDescription("Reports the bot's current Discord gateway connection state, gateway latency, the number of guilds it is in, whether @mention answering is enabled, and the signed-in bot user (once connected).")
    .WithTags("Bot");

app.Run();

/// <summary>A snapshot of the bot's Discord gateway connection, returned by <c>GET /status</c>.</summary>
/// <param name="Connection">Gateway connection state (Disconnected, Connecting, Connected, Disconnecting).</param>
/// <param name="LatencyMs">Gateway heartbeat latency in milliseconds.</param>
/// <param name="Guilds">Number of guilds (servers) the bot is currently a member of.</param>
/// <param name="MentionEnabled">Whether the bot also answers when @mentioned (requires the Message Content intent).</param>
/// <param name="BotUser">The signed-in bot user (username#discriminator), or null before the gateway is ready.</param>
internal sealed record BotStatus(
    string Connection,
    int LatencyMs,
    int Guilds,
    bool MentionEnabled,
    string? BotUser);
