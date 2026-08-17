namespace AspireDiscordBot.Core.Rag;

/// <summary>A source reference shown alongside a grounded answer.</summary>
public sealed record Citation(int Number, string Title, string Url, string Repo);

/// <summary>The result of a grounded question-answering call.</summary>
public sealed record GroundedAnswer
{
    /// <summary>True when relevant documentation was found and used.</summary>
    public required bool IsGrounded { get; init; }

    /// <summary>The answer text (or the "not covered" message when not grounded).</summary>
    public required string Answer { get; init; }

    /// <summary>Sources used, in citation order.</summary>
    public IReadOnlyList<Citation> Citations { get; init; } = [];

    /// <summary>The best retrieval score (diagnostics).</summary>
    public float TopScore { get; init; }

    public static GroundedAnswer NotFound(string message) => new()
    {
        IsGrounded = false,
        Answer = message,
        Citations = [],
    };
}
