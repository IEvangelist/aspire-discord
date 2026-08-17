namespace AspireDiscordBot.Core.Safety;

/// <summary>Why a question was blocked by the safety guard.</summary>
public enum SafetyCategory
{
    /// <summary>The question passed all checks.</summary>
    Allowed,

    /// <summary>Empty or whitespace-only input.</summary>
    Empty,

    /// <summary>Exceeds the maximum allowed length.</summary>
    TooLong,

    /// <summary>Looks like a prompt-injection / instruction-override attempt.</summary>
    PromptInjection,

    /// <summary>Looks like a jailbreak / persona-override / policy-evasion attempt.</summary>
    Jailbreak,

    /// <summary>Attempts to extract the system prompt or internal configuration.</summary>
    SystemPromptExtraction,
}

/// <summary>The verdict from <see cref="QuestionSafetyGuard"/>.</summary>
public sealed record SafetyVerdict(bool IsAllowed, SafetyCategory Category, string Reason)
{
    public static SafetyVerdict Allow() => new(true, SafetyCategory.Allowed, "ok");

    public static SafetyVerdict Block(SafetyCategory category, string reason) => new(false, category, reason);
}
