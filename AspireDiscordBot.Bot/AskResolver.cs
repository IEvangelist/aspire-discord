using System.Text.RegularExpressions;

namespace AspireDiscordBot.Bot;

/// <summary>
/// Decides which question the bot should actually answer for an <c>/ask</c> invocation or a mention.
/// When the command runs inside a forum post/thread, a user often has no explicit question — or types
/// a meta-instruction like "please answer the OP's question above". In those cases the bot answers the
/// thread's original (starter) message. A substantive typed question is always answered as-is.
/// </summary>
public static partial class AskResolver
{
    /// <summary>
    /// Resolves the effective question. Returns the original poster's question when the user didn't
    /// ask something concrete (empty or a reference to the thread) and an OP question is available;
    /// otherwise the typed question; or null when there's nothing to answer.
    /// </summary>
    public static string? Resolve(string? typed, string? opQuestion)
    {
        var trimmed = (typed ?? string.Empty).Trim();
        var hasOp = !string.IsNullOrWhiteSpace(opQuestion);

        if (hasOp && (trimmed.Length == 0 || ReferencesThread(trimmed)))
        {
            return opQuestion!.Trim();
        }

        if (trimmed.Length > 0)
        {
            return trimmed;
        }

        return hasOp ? opQuestion!.Trim() : null;
    }

    /// <summary>
    /// True when the text is a meta-reference to the thread/original poster rather than a concrete
    /// question of its own (e.g. "answer the OP", "help with the question above", "this post").
    /// </summary>
    public static bool ReferencesThread(string? typed) =>
        !string.IsNullOrWhiteSpace(typed) && ThreadReferenceRegex().IsMatch(typed);

    [GeneratedRegex(
        @"(?i)\b(op|ops|op's|original\s+poster|this\s+(post|thread|question)|(question|post|thread)\s+above|above|answer\s+(the|this|their|his|her|it)\b|help\s+(me\s+)?(answer|out)|their\s+question)\b")]
    private static partial Regex ThreadReferenceRegex();
}
