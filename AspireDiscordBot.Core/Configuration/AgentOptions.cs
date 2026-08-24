namespace AspireDiscordBot.Core.Configuration;

/// <summary>Controls the agentic (tool-calling) answer pipeline.</summary>
public sealed class AgentOptions
{
    public const string SectionName = "Agent";

    /// <summary>
    /// Answer pipeline: <c>agentic</c> (tool-calling research loop, default) or <c>single</c>
    /// (one-shot retrieve-then-answer). Agentic falls back to single automatically when the
    /// configured AI provider doesn't support tool calling (e.g. Ollama).
    /// </summary>
    public string Mode { get; set; } = "agentic";

    /// <summary>Maximum agent turns (model calls) per question, bounding latency and cost.</summary>
    public int MaxIterations { get; set; } = 5;

    /// <summary>Maximum total tool calls the agent may make per question.</summary>
    public int MaxToolCalls { get; set; } = 10;

    /// <summary>Results returned per <c>search_docs</c> tool call.</summary>
    public int SearchResultsPerCall { get; set; } = 6;

    /// <summary>Maximum wall-clock time for one SDK-driven answer.</summary>
    public int TimeoutSeconds { get; set; } = 90;
}
