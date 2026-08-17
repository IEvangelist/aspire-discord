using System.Text.RegularExpressions;

namespace AspireDiscordBot.Core.Safety;

/// <summary>
/// Last line of defense: inspects the model's generated answer for signs that a prompt
/// injection succeeded — e.g. leaking the system prompt, echoing security instructions, or
/// announcing a persona/mode change. If detected, the answer is suppressed.
/// </summary>
public static partial class AnswerValidator
{
    private static readonly Regex[] LeakPatterns =
    [
        SystemPromptLeakRegex(),
        SecuritySectionLeakRegex(),
        PersonaChangeRegex(),
        ContextMechanismLeakRegex(),
    ];

    /// <summary>Returns true when the answer appears safe to send to users.</summary>
    public static bool IsSafe(string answer)
    {
        if (string.IsNullOrWhiteSpace(answer))
        {
            return false;
        }

        return !LeakPatterns.Any(p => p.IsMatch(answer));
    }

    [GeneratedRegex(@"(?i)(you are the aspire documentation assistant|security\s*[—\-:]\s*read carefully|answering rules:)")]
    private static partial Regex SystemPromptLeakRegex();

    [GeneratedRegex(@"(?i)(untrusted data|do not treat as instructions|=== (begin|end) (context|question))")]
    private static partial Regex SecuritySectionLeakRegex();

    [GeneratedRegex(@"(?i)(i am now|as (a|an) (dan|jailbroken)|developer mode (enabled|activated)|i will ignore (my|all|previous))")]
    private static partial Regex PersonaChangeRegex();

    [GeneratedRegex(@"(?i)(my system prompt|my instructions are|the context (i was|provided to me))")]
    private static partial Regex ContextMechanismLeakRegex();
}
