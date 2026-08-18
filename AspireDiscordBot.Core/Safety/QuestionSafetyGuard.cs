using System.Text.RegularExpressions;
using Microsoft.Extensions.Options;

namespace AspireDiscordBot.Core.Safety;

/// <summary>
/// First line of defense: a fast, deterministic pre-retrieval check that rejects obvious
/// prompt-injection, jailbreak, and system-prompt-extraction attempts before the question
/// ever reaches the model. This complements (does not replace) the two stronger controls:
/// retrieval-based topic gating and the hardened, data-delimited system prompt.
/// </summary>
public sealed partial class QuestionSafetyGuard(IOptions<SafetyOptions> options)
{
    private readonly SafetyOptions _options = options.Value;

    // Instruction-override / prompt-injection markers.
    private static readonly Regex[] InjectionPatterns =
    [
        IgnorePreviousRegex(),
        DisregardRegex(),
        ForgetInstructionsRegex(),
        NewInstructionsRegex(),
        OverrideRulesRegex(),
        EndOfPromptRegex(),
    ];

    // Jailbreak / persona-override / policy-evasion markers.
    private static readonly Regex[] JailbreakPatterns =
    [
        PretendRoleRegex(),
        YouAreNowRegex(),
        DeveloperModeRegex(),
        DanRegex(),
        NoRestrictionsRegex(),
        BypassRegex(),
    ];

    // System-prompt / configuration extraction markers.
    private static readonly Regex[] ExtractionPatterns =
    [
        RevealPromptRegex(),
        RepeatPromptRegex(),
        WhatAreYourInstructionsRegex(),
    ];

    public SafetyVerdict Evaluate(string question)
    {
        if (string.IsNullOrWhiteSpace(question))
        {
            return SafetyVerdict.Block(SafetyCategory.Empty, "Empty question.");
        }

        if (question.Length > _options.MaxQuestionLength)
        {
            return SafetyVerdict.Block(SafetyCategory.TooLong,
                $"Question exceeds {_options.MaxQuestionLength} characters.");
        }

        // Normalize to defeat spacing / punctuation / case obfuscation before matching.
        var normalized = Normalize(question);

        foreach (var pattern in ExtractionPatterns)
        {
            if (pattern.IsMatch(normalized))
            {
                return SafetyVerdict.Block(SafetyCategory.SystemPromptExtraction, $"Matched extraction pattern: {pattern}");
            }
        }

        foreach (var pattern in InjectionPatterns)
        {
            if (pattern.IsMatch(normalized))
            {
                return SafetyVerdict.Block(SafetyCategory.PromptInjection, $"Matched injection pattern: {pattern}");
            }
        }

        foreach (var pattern in JailbreakPatterns)
        {
            if (pattern.IsMatch(normalized))
            {
                return SafetyVerdict.Block(SafetyCategory.Jailbreak, $"Matched jailbreak pattern: {pattern}");
            }
        }

        return SafetyVerdict.Allow();
    }

    /// <summary>
    /// Collapses runs of whitespace and strips characters commonly used to break up trigger
    /// words (e.g. "i-g-n-o-r-e" or "ig.nore"), lowercasing for case-insensitive matching.
    /// </summary>
    private static string Normalize(string input)
    {
        var lowered = input.ToLowerInvariant();
        var collapsed = WhitespaceRegex().Replace(lowered, " ");
        // Remove separator punctuation / zero-width chars between letters that are used to obfuscate.
        return SeparatorRegex().Replace(collapsed, "");
    }

    [GeneratedRegex(@"\s+")]
    private static partial Regex WhitespaceRegex();

    [GeneratedRegex(@"(?<=\p{L})[\-_.\u200b](?=\p{L})")]
    private static partial Regex SeparatorRegex();

    [GeneratedRegex(@"ignore\s+(all\s+|the\s+|any\s+|your\s+)?(previous|prior|earlier|above|preceding|system)\s+(instruction|instructions|prompt|prompts|message|messages|rule|rules|context|directive|directives)")]
    private static partial Regex IgnorePreviousRegex();

    [GeneratedRegex(@"disregard\s+(all\s+|the\s+|any\s+|your\s+|everything\s+)?(previous|prior|earlier|above|preceding|system|instruction|instructions|prompt|rule|rules)")]
    private static partial Regex DisregardRegex();

    [GeneratedRegex(@"forget\s+(all\s+|the\s+|any\s+|your\s+|everything\s+|about\s+)?(previous|prior|earlier|above|instruction|instructions|prompt|rule|rules|what)")]
    private static partial Regex ForgetInstructionsRegex();

    [GeneratedRegex(@"(here\s+are|these\s+are|follow\s+these|new)\s+(your\s+)?(new\s+)?(instruction|instructions|rules|directives)")]
    private static partial Regex NewInstructionsRegex();

    [GeneratedRegex(@"(override|overrule|bypass|change|update|replace)\s+(your\s+|the\s+|all\s+)?(rule|rules|instruction|instructions|system\s+prompt|guardrail|guardrails|restriction|restrictions)")]
    private static partial Regex OverrideRulesRegex();

    [GeneratedRegex(@"(end\s+of\s+(prompt|context|system|instructions))|(\-{2,}\s*end)|(</?(system|instructions|prompt)>)")]
    private static partial Regex EndOfPromptRegex();

    [GeneratedRegex(@"(pretend|act|behave|roleplay|role\s*play)\s+(to\s+be|as|like|that\s+you)")]
    private static partial Regex PretendRoleRegex();

    [GeneratedRegex(@"you\s+are\s+(now|no\s+longer|from\s+now|actually|really)\b")]
    private static partial Regex YouAreNowRegex();

    [GeneratedRegex(@"(developer|debug|admin|god|sudo|root|unrestricted)\s+mode")]
    private static partial Regex DeveloperModeRegex();

    [GeneratedRegex(@"\bdan\b|do\s+anything\s+now|stay\s+in\s+character")]
    private static partial Regex DanRegex();

    [GeneratedRegex(@"(no|without|ignore|remove|drop)\s+(restrictions|limits|filters|rules|guardrails|safety|constraints)")]
    private static partial Regex NoRestrictionsRegex();

    [GeneratedRegex(@"(bypass|circumvent|get\s+around|work\s+around|evade)\s+(the\s+|your\s+|all\s+)?(filter|filters|safety|guardrail|guardrails|restriction|restrictions|rules)")]
    private static partial Regex BypassRegex();

    [GeneratedRegex(@"(reveal|show|print|display|output|expose|leak|give\s+me)\s+(me\s+)?(your\s+|the\s+)?(system\s+prompt|system\s+message|initial\s+prompt|instructions|prompt|configuration|rules)")]
    private static partial Regex RevealPromptRegex();

    [GeneratedRegex(@"(repeat|echo|say|write\s+out)\s+(back\s+)?(your\s+|the\s+|everything\s+|all\s+)?(system\s+prompt|instructions|prompt|text\s+above|words\s+above)")]
    private static partial Regex RepeatPromptRegex();

    [GeneratedRegex(@"what\s+(are|were|is)\s+(your|the)\s+(system\s+)?(instruction|instructions|prompt|rules|guidelines|directives)")]
    private static partial Regex WhatAreYourInstructionsRegex();
}
