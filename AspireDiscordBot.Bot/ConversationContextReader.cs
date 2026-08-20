using Discord;
using Microsoft.Extensions.Logging;

namespace AspireDiscordBot.Bot;

/// <summary>
/// Reads conversational context from Discord so the bot can answer a question that lives in the
/// surrounding thread rather than in the command itself. For a forum post or a message-anchored
/// thread, the original poster's question is the thread's <b>starter message</b>, whose id matches
/// the thread's id. Requires the <c>Read Message History</c> permission and the Message Content intent.
/// </summary>
public sealed class ConversationContextReader(ILogger<ConversationContextReader> logger)
{
    /// <summary>
    /// Returns the original poster's question (the thread's starter message) when the channel is a
    /// thread/forum post, truncated to <paramref name="maxChars"/> so it satisfies the safety
    /// length limit. Returns null for non-thread channels or when the message can't be read.
    /// </summary>
    public async Task<string?> ReadOpQuestionAsync(IMessageChannel channel, int maxChars)
    {
        if (channel is not IThreadChannel thread)
        {
            return null;
        }

        try
        {
            // For forum posts and message-anchored threads the starter message shares the thread id.
            var starter = await channel.GetMessageAsync(thread.Id, CacheMode.AllowDownload);
            var content = starter?.CleanContent;
            if (string.IsNullOrWhiteSpace(content))
            {
                content = starter?.Content;
            }

            if (string.IsNullOrWhiteSpace(content))
            {
                return null;
            }

            content = content.Trim();
            return content.Length > maxChars ? content[..maxChars] : content;
        }
        catch (Exception ex)
        {
            logger.LogDebug(ex,
                "Couldn't read the thread's starter message. The bot may lack the 'Read Message History' " +
                "permission, or the thread has no starter message.");
            return null;
        }
    }
}
