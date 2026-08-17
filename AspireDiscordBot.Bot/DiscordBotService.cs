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

        if (_options.MentionEnabled)
        {
            client.MessageReceived += OnMessageReceived;
        }

        await client.LoginAsync(TokenType.Bot, _options.Token);
        await client.StartAsync();
        logger.LogInformation("Discord bot starting (mentions {MentionState}).",
            _options.MentionEnabled ? "enabled" : "disabled");
    }

    public async Task StopAsync(CancellationToken cancellationToken)
    {
        client.Log -= OnLog;
        client.Ready -= OnReady;
        client.SlashCommandExecuted -= OnSlashCommand;
        client.MessageReceived -= OnMessageReceived;

        await client.StopAsync();
        await client.LogoutAsync();
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
        return Task.CompletedTask;
    }
}
