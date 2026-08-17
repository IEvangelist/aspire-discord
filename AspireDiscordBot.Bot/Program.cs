using AspireDiscordBot.Bot;
using AspireDiscordBot.Core;
using Discord;
using Discord.WebSocket;
using Microsoft.Extensions.Options;

var builder = Host.CreateApplicationBuilder(args);

builder.AddServiceDefaults();
builder.AddAspireDiscordBotCore("qdrant");

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
builder.Services.AddHostedService<DiscordBotService>();

var host = builder.Build();
host.Run();
