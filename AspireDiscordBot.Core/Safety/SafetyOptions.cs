namespace AspireDiscordBot.Core.Safety;

/// <summary>Tunable knobs for the safety layer.</summary>
public sealed class SafetyOptions
{
    public const string SectionName = "Safety";

    /// <summary>Maximum characters accepted for a question.</summary>
    public int MaxQuestionLength { get; set; } = 600;

    /// <summary>
    /// Minimum retrieval similarity for a question to be considered on-topic (Aspire).
    /// When the best retrieved chunk is below this, the question is treated as out of scope.
    /// This is the primary topic gate: the vector store only contains Aspire documentation,
    /// so an off-topic question retrieves nothing relevant.
    /// </summary>
    public float MinTopicScore { get; set; } = 0.35f;

    /// <summary>User-facing message shown when input is blocked by the guard.</summary>
    public string BlockedMessage { get; set; } =
        "I can only help with questions about Aspire and closely related technologies, " +
        "answered from the official Aspire documentation. Please ask an Aspire question — " +
        "for example: \"How do I add a Postgres resource to my app host?\"";

    /// <summary>User-facing message shown when a question is off-topic (nothing relevant retrieved).</summary>
    public string OffTopicMessage { get; set; } =
        "That doesn't look like it's covered by the Aspire documentation, so I can't help with it. " +
        "Ask me about Aspire — the app host, integrations, the dashboard, deployment, and so on.";
}
