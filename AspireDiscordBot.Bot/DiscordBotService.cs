using System.Text.RegularExpressions;
using AspireDiscordBot.Core.Rag;
using AspireDiscordBot.Core.Safety;
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
    ConversationContextReader contextReader,
    IOptions<DiscordOptions> options,
    IOptions<SafetyOptions> safetyOptions,
    ILogger<DiscordBotService> logger) : IHostedService
{
    private const string AskCommandName = "ask";
    private readonly DiscordOptions _options = options.Value;
    private readonly int _maxQuestionLength = safetyOptions.Value.MaxQuestionLength;

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

            if (_options.AllowedUserIds.Length > 0)
            {
                logger.LogInformation(
                    "Access is restricted to {Count} allow-listed user id(s); everyone else is declined.",
                    _options.AllowedUserIds.Length);
            }
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
        if (closeCode is GatewayAuthenticationFailed || IsUnauthorized(exception))
        {
            logger.LogError(
                "Discord rejected the bot token (401 / authentication failed). Update Discord:Token " +
                "with a valid bot token (Developer Portal → your app → Bot → Reset Token) and restart. " +
                "The bot will stop reconnecting.");
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

    /// <summary>
    /// Detects an HTTP 401 from Discord during the gateway handshake, which indicates an invalid
    /// bot token. Discord.Net swallows this inside <c>LoginAsync</c> and then retries the gateway
    /// connection forever, so we surface it here and stop reconnecting.
    /// </summary>
    private static bool IsUnauthorized(Exception? exception)
    {
        for (var ex = exception; ex is not null; ex = ex.InnerException)
        {
            if (ex is Discord.Net.HttpException http && http.HttpCode == System.Net.HttpStatusCode.Unauthorized)
            {
                return true;
            }
        }

        return false;
    }

    private async Task OnReady()
    {
        try
        {
            var command = new SlashCommandBuilder()
                .WithName(AskCommandName)
                .WithDescription("Ask a question about Aspire, answered from the official docs.")
                .AddOption(
                    "question",
                    ApplicationCommandOptionType.String,
                    "Your Aspire question. Optional in a forum post/thread — I'll answer the original question.",
                    isRequired: false)
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

        if (!UserAuthorizer.IsAllowed(command.User.Id, _options.AllowedUserIds))
        {
            logger.LogInformation(
                "Declined /ask from unauthorized user {User} ({UserId}).", command.User.Username, command.User.Id);
            return command.RespondAsync(
                "Sorry — this bot is currently restricted to specific users.", ephemeral: true);
        }

        // Offload work so the gateway task is never blocked.
        _ = Task.Run(async () =>
        {
            try
            {
                await command.DeferAsync();
                var typed = command.Data.Options.FirstOrDefault(o => o.Name == "question")?.Value as string ?? string.Empty;

                // Resolve the question: inside a forum post/thread, answer the original poster's
                // question when the invoker didn't type a concrete one (empty or "answer the OP above").
                var resolved = await ResolveAskAsync(command.Channel, typed);
                if (resolved.Question is null)
                {
                    await command.FollowupAsync(resolved.Problem);
                    return;
                }

                logger.LogInformation("/ask from {User}: {Question}", command.User.Username, ForLog(resolved.Question));
                var answer = await answers.AnswerAsync(resolved.Question);
                await command.FollowupAsync(embed: formatter.Build(resolved.Question, answer));
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "Error handling /ask command.");
                await SafeFollowupAsync(command);
            }
        });

        return Task.CompletedTask;
    }

    /// <summary>
    /// Resolves what to answer plus, when nothing can be answered, an actionable user-facing reason
    /// (e.g. a missing permission) so the bot never falls back to a confusing off-topic refusal.
    /// </summary>
    private async Task<ResolvedAsk> ResolveAskAsync(IMessageChannel? channel, string typed)
    {
        var op = await contextReader.ReadOpQuestionAsync(channel, _maxQuestionLength);
        var question = AskResolver.Resolve(typed, op.Question);
        if (!string.IsNullOrWhiteSpace(question))
        {
            return ResolvedAsk.Answered(question);
        }

        // Nothing to answer. If the user wanted the OP's question (empty or "answer the OP above"),
        // explain precisely why it couldn't be read; otherwise ask for a question.
        var wantedOp = string.IsNullOrWhiteSpace(typed) || AskResolver.ReferencesThread(typed);
        if (!wantedOp)
        {
            return ResolvedAsk.Unresolved(
                "Please include a question about Aspire and I'll answer it from the official docs.");
        }

        var reason = op.Status switch
        {
            OpReadStatus.Forbidden =>
                "I couldn't read the original post — I'm missing the **Read Message History** permission. " +
                "Re-invite me with **Read Message History** (and **Embed Links**), or paste the question here " +
                "and I'll answer it.",
            OpReadStatus.Empty =>
                "The original post doesn't have any text I can read. Paste the question and I'll answer it.",
            OpReadStatus.NotAThread =>
                "Run `/ask` inside a forum post or thread and I'll answer the original question — or just " +
                "include a question directly.",
            _ =>
                "I couldn't read the original post. Paste the question and I'll answer it.",
        };
        return ResolvedAsk.Unresolved(reason);
    }

    private static string ForLog(string question) =>
        question.Length <= 120 ? question : question[..120] + "…";

    /// <summary>Either a resolved question to answer, or an actionable message to show the user.</summary>
    private readonly record struct ResolvedAsk(string? Question, string? Problem)
    {
        public static ResolvedAsk Answered(string question) => new(question, null);
        public static ResolvedAsk Unresolved(string message) => new(null, message);
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

        if (!UserAuthorizer.IsAllowed(message.Author.Id, _options.AllowedUserIds))
        {
            logger.LogDebug("Ignoring mention from unauthorized user {UserId}.", message.Author.Id);
            return Task.CompletedTask;
        }

        _ = Task.Run(async () =>
        {
            try
            {
                var typed = StripMentions(userMessage.Content, self.Id);
                var resolved = await ResolveAskAsync(userMessage.Channel, typed);
                if (resolved.Question is null)
                {
                    await userMessage.Channel.SendMessageAsync(
                        resolved.Problem,
                        messageReference: new MessageReference(userMessage.Id));
                    return;
                }

                logger.LogInformation("mention from {User}: {Question}", userMessage.Author.Username, ForLog(resolved.Question));
                using (userMessage.Channel.EnterTypingState())
                {
                    var answer = await answers.AnswerAsync(resolved.Question);
                    await userMessage.Channel.SendMessageAsync(
                        embed: formatter.Build(resolved.Question, answer),
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
