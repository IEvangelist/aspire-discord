using System.Text.RegularExpressions;
using AspireDiscordBot.Core.Rag;
using Discord;
using Discord.WebSocket;
using Microsoft.Extensions.Options;

namespace AspireDiscordBot.Bot;

/// <summary>
/// Hosts the Discord gateway connection, registers the <c>/ask</c> slash command, and
/// answers questions (via slash command or @mention) using the grounded RAG pipeline.
/// </summary>
public sealed class DiscordBotService(
    DiscordSocketClient client,
    GroundedAnswerService answers,
    DiscordResponseFormatter formatter,
    IOptions<DiscordOptions> options,
    ILogger<DiscordBotService> logger) : IHostedService
{
    private const string AskCommandName = "ask";
    private readonly DiscordOptions _options = options.Value;

    // Discord gateway close codes that are fatal — reconnecting won't help until config changes.
    private const int GatewayAuthenticationFailed = 4004; // invalid bot token
    private const int GatewayDisallowedIntents = 4014;    // a privileged intent isn't enabled

    public async Task StartAsync(CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(_options.Token))
        {
            logger.LogWarning(
                "No Discord token configured (Discord:Token). The bot will not connect. " +
                "Set the token via user-secrets or the AppHost parameter to enable it.");
            return;
        }

        client.Log += OnLog;
        client.Ready += OnReady;
        client.SlashCommandExecuted += OnSlashCommand;
        client.Disconnected += OnDisconnected;

        if (_options.MentionEnabled)
        {
            client.MessageReceived += OnMessageReceived;
        }

        try
        {
            await client.LoginAsync(TokenType.Bot, _options.Token);
            await client.StartAsync();
            logger.LogInformation("Discord bot starting (mentions {MentionState}).",
                _options.MentionEnabled ? "enabled" : "disabled");
        }
        catch (Exception ex)
        {
            // Never let a bad token crash the host (which would trigger an endless restart loop).
            // Log an actionable error and leave the bot offline; the rest of the app keeps running.
            logger.LogError(ex,
                "Failed to sign in to Discord. Check that Discord:Token is a valid bot token " +
                "(Developer Portal → your app → Bot → Reset Token). The bot will stay offline.");
            await SafeStopAsync();
        }
    }

    public async Task StopAsync(CancellationToken cancellationToken)
    {
        client.Log -= OnLog;
        client.Ready -= OnReady;
        client.SlashCommandExecuted -= OnSlashCommand;
        client.MessageReceived -= OnMessageReceived;
        client.Disconnected -= OnDisconnected;

        await SafeStopAsync();
    }

    private async Task SafeStopAsync()
    {
        try
        {
            await client.StopAsync();
            await client.LogoutAsync();
        }
        catch (Exception ex)
        {
            logger.LogDebug(ex, "Error while stopping the Discord client.");
        }
    }

    /// <summary>
    /// Breaks Discord.Net's automatic reconnect loop when the gateway closed for a reason that
    /// won't resolve by retrying (invalid token, or a privileged intent that isn't enabled).
    /// </summary>
    private Task OnDisconnected(Exception? exception)
    {
        var closeCode = FindCloseCode(exception);
        if (closeCode is GatewayAuthenticationFailed)
        {
            logger.LogError(
                "Discord closed the connection: authentication failed (invalid bot token). " +
                "Update Discord:Token and restart. The bot will stop reconnecting.");
            _ = SafeStopAsync();
        }
        else if (closeCode is GatewayDisallowedIntents)
        {
            logger.LogError(
                "Discord closed the connection: a privileged intent isn't enabled. Enable " +
                "\"Message Content Intent\" (Developer Portal → Bot → Privileged Gateway Intents), " +
                "or set Discord:MentionEnabled=false. The bot will stop reconnecting.");
            _ = SafeStopAsync();
        }

        return Task.CompletedTask;
    }

    private static int? FindCloseCode(Exception? exception)
    {
        for (var ex = exception; ex is not null; ex = ex.InnerException)
        {
            // Discord.Net's WebSocketClosedException carries the numeric close code.
            var codeProp = ex.GetType().GetProperty("CloseCode");
            if (codeProp?.GetValue(ex) is int code)
            {
                return code;
            }
        }

        return null;
    }

    private async Task OnReady()
    {
        try
        {
            var command = new SlashCommandBuilder()
                .WithName(AskCommandName)
                .WithDescription("Ask a question about Aspire, answered from the official docs.")
                .AddOption("question", ApplicationCommandOptionType.String, "Your Aspire question", isRequired: true)
                .Build();

            if (_options.GuildId is { } guildId)
            {
                await client.Rest.CreateGuildCommand(command, guildId);
                logger.LogInformation("Registered /ask command to guild {GuildId}.", guildId);
            }
            else
            {
                await client.CreateGlobalApplicationCommandAsync(command);
                logger.LogInformation("Registered global /ask command (may take up to 1 hour to propagate).");
            }
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Failed to register the /ask slash command.");
        }
    }

    private Task OnSlashCommand(SocketSlashCommand command)
    {
        if (command.CommandName != AskCommandName)
        {
            return Task.CompletedTask;
        }

        // Offload work so the gateway task is never blocked.
        _ = Task.Run(async () =>
        {
            try
            {
                await command.DeferAsync();
                var question = command.Data.Options.FirstOrDefault()?.Value as string ?? string.Empty;

                logger.LogInformation("/ask from {User}: {Question}", command.User.Username, question);
                var answer = await answers.AnswerAsync(question);
                await command.FollowupAsync(embed: formatter.Build(question, answer));
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "Error handling /ask command.");
                await SafeFollowupAsync(command);
            }
        });

        return Task.CompletedTask;
    }

    private Task OnMessageReceived(SocketMessage message)
    {
        if (message is not SocketUserMessage userMessage || message.Author.IsBot)
        {
            return Task.CompletedTask;
        }

        var self = client.CurrentUser;
        if (self is null || !message.MentionedUsers.Any(u => u.Id == self.Id))
        {
            return Task.CompletedTask;
        }

        _ = Task.Run(async () =>
        {
            try
            {
                var question = StripMentions(userMessage.Content, self.Id);
                if (string.IsNullOrWhiteSpace(question))
                {
                    await userMessage.Channel.SendMessageAsync(
                        "Hi! Ask me a question about Aspire and I'll answer from the official docs. " +
                        "For example: `@me how do I add a Redis resource?`",
                        messageReference: new MessageReference(userMessage.Id));
                    return;
                }

                logger.LogInformation("mention from {User}: {Question}", userMessage.Author.Username, question);
                using (userMessage.Channel.EnterTypingState())
                {
                    var answer = await answers.AnswerAsync(question);
                    await userMessage.Channel.SendMessageAsync(
                        embed: formatter.Build(question, answer),
                        messageReference: new MessageReference(userMessage.Id));
                }
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "Error handling mention.");
            }
        });

        return Task.CompletedTask;
    }

    private async Task SafeFollowupAsync(SocketSlashCommand command)
    {
        try
        {
            await command.FollowupAsync("Sorry — something went wrong answering that. Please try again.");
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Failed to send error follow-up.");
        }
    }

    private static string StripMentions(string content, ulong botId)
    {
        var withoutBot = Regex.Replace(content ?? string.Empty, $"<@!?{botId}>", string.Empty);
        return withoutBot.Trim();
    }

    private Task OnLog(LogMessage message)
    {
        var level = message.Severity switch
        {
            LogSeverity.Critical => LogLevel.Critical,
            LogSeverity.Error => LogLevel.Error,
            LogSeverity.Warning => LogLevel.Warning,
            LogSeverity.Info => LogLevel.Information,
            LogSeverity.Verbose => LogLevel.Debug,
            LogSeverity.Debug => LogLevel.Trace,
            _ => LogLevel.Information,
        };

        logger.Log(level, message.Exception, "[Discord:{Source}] {Message}", message.Source, message.Message);

        // Give an actionable hint for the most common misconfiguration.
        if (message.Exception?.ToString().Contains("Disallowed intent", StringComparison.OrdinalIgnoreCase) == true)
        {
            logger.LogError(
                "Discord rejected the connection because a privileged intent isn't enabled. Either set " +
                "Discord:MentionEnabled=false (the /ask command works without it), or enable the " +
                "\"Message Content Intent\" for the app at Discord Developer Portal → Bot → Privileged Gateway Intents.");
        }

        return Task.CompletedTask;
    }
}
