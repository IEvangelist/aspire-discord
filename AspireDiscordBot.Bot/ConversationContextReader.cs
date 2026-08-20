using Discord;
using Discord.Net;
using Microsoft.Extensions.Logging;

namespace AspireDiscordBot.Bot;

/// <summary>Outcome of trying to read the original poster's question from a thread/forum post.</summary>
public enum OpReadStatus
{
    /// <summary>The channel isn't a thread/forum post, so there's no "original question" to read.</summary>
    NotAThread,

    /// <summary>The original poster's question was read successfully.</summary>
    Found,

    /// <summary>It's a thread, but the starter message had no readable text content.</summary>
    Empty,

    /// <summary>The bot lacks permission to read the thread history (needs Read Message History).</summary>
    Forbidden,

    /// <summary>An unexpected error occurred while reading the thread.</summary>
    Error,
}

/// <summary>The resolved original-poster question plus why it did or didn't resolve.</summary>
public readonly record struct OpQuestionResult(string? Question, OpReadStatus Status)
{
    public bool HasQuestion => !string.IsNullOrWhiteSpace(Question);
}

/// <summary>
/// Reads conversational context from Discord so the bot can answer a question that lives in the
/// surrounding thread rather than in the command itself. For a forum post or a message-anchored
/// thread, the original poster's question is the thread's <b>starter message</b>, whose id matches
/// the thread's id. Requires the bot's <c>Read Message History</c> permission (View Channel + Read
/// Message History); the content is returned over REST without the Message Content gateway intent.
/// </summary>
public sealed class ConversationContextReader(ILogger<ConversationContextReader> logger)
{
    /// <summary>
    /// Reads the original poster's question (the thread's starter message) when the channel is a
    /// thread/forum post, truncated to <paramref name="maxChars"/> so it satisfies the safety
    /// length limit. The returned status explains the outcome so the caller can give actionable
    /// feedback (e.g. a missing permission) instead of a generic refusal.
    /// </summary>
    public async Task<OpQuestionResult> ReadOpQuestionAsync(IMessageChannel? channel, int maxChars)
    {
        if (channel is not IThreadChannel thread)
        {
            return new OpQuestionResult(null, OpReadStatus.NotAThread);
        }

        try
        {
            // For forum posts and message-anchored threads the starter message shares the thread id.
            var starter = await channel.GetMessageAsync(thread.Id, CacheMode.AllowDownload);
            var content = FirstNonEmpty(starter?.CleanContent, starter?.Content);

            if (string.IsNullOrWhiteSpace(content))
            {
                logger.LogWarning(
                    "Read the thread's starter message but it had no text content (thread {ThreadId}). " +
                    "If the post has text, ensure the bot has the Message Content intent and Read Message History.",
                    thread.Id);
                return new OpQuestionResult(null, OpReadStatus.Empty);
            }

            content = content.Trim();
            if (content.Length > maxChars)
            {
                content = content[..maxChars];
            }

            logger.LogInformation("Resolved the original poster's question from thread {ThreadId}.", thread.Id);
            return new OpQuestionResult(content, OpReadStatus.Found);
        }
        catch (HttpException ex) when (ex.HttpCode == System.Net.HttpStatusCode.Forbidden)
        {
            logger.LogWarning(
                "Missing permission to read the thread's history (thread {ThreadId}). Re-invite the bot " +
                "with the 'Read Message History' permission so it can answer the original poster's question.",
                thread.Id);
            return new OpQuestionResult(null, OpReadStatus.Forbidden);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Couldn't read the thread's starter message (thread {ThreadId}).", thread.Id);
            return new OpQuestionResult(null, OpReadStatus.Error);
        }
    }

    private static string? FirstNonEmpty(string? a, string? b) =>
        !string.IsNullOrWhiteSpace(a) ? a : b;
}
