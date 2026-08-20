namespace AspireDiscordBot.Core.Evals;

/// <summary>
/// One answer-quality evaluation case: a question plus deterministic expectations about the answer.
/// Checks are intentionally robust (substring / any-of / none-of) rather than exact-match, so they
/// assert answer <b>quality</b> (grounded, cited the right area, mentioned the key concept, didn't
/// leak or hallucinate) without being brittle to wording changes.
/// </summary>
public sealed record EvalCase
{
    public required string Id { get; init; }

    public required string Question { get; init; }

    /// <summary>Short note on what this case guards against.</summary>
    public string? Notes { get; init; }

    /// <summary>Expected grounding: true = must answer, false = must refuse, null = don't care.</summary>
    public bool? MustBeGrounded { get; init; }

    /// <summary>Each substring must appear in at least one citation's URL or title (case-insensitive).</summary>
    public string[] CitationsContainAll { get; init; } = [];

    /// <summary>Every substring must appear in the answer text (case-insensitive).</summary>
    public string[] AnswerContainsAll { get; init; } = [];

    /// <summary>At least one substring must appear in the answer text (case-insensitive).</summary>
    public string[] AnswerContainsAny { get; init; } = [];

    /// <summary>None of these substrings may appear in the answer text (case-insensitive).</summary>
    public string[] AnswerContainsNone { get; init; } = [];
}
