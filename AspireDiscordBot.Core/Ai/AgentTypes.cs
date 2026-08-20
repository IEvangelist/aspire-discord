namespace AspireDiscordBot.Core.Ai;

/// <summary>
/// Types for a tool-calling ("agentic") conversation over the Responses API. The agent maintains a
/// running list of <see cref="AgentItem"/>s (messages, the model's tool calls, and our tool
/// outputs) and sends them back each turn so the model can plan, call tools, read results, and
/// iterate before producing a final answer.
/// </summary>

/// <summary>A callable tool exposed to the model. <paramref name="ParametersJsonSchema"/> is a JSON Schema object.</summary>
public sealed record ToolSpec(string Name, string Description, string ParametersJsonSchema);

/// <summary>A tool invocation requested by the model.</summary>
public sealed record ToolCall(string CallId, string Name, string ArgumentsJson);

/// <summary>An item in the agent conversation sent to the model.</summary>
public abstract record AgentItem;

/// <summary>A plain chat message (system/user/assistant).</summary>
public sealed record AgentMessage(string Role, string Content) : AgentItem
{
    public static AgentMessage System(string content) => new("system", content);
    public static AgentMessage User(string content) => new("user", content);
}

/// <summary>Echoes a tool call the model previously made, so the model retains its own context.</summary>
public sealed record AgentToolCall(string CallId, string Name, string ArgumentsJson) : AgentItem;

/// <summary>The result of executing a tool, returned to the model.</summary>
public sealed record AgentToolOutput(string CallId, string Output) : AgentItem;

/// <summary>One turn of the agent: either final answer text, or a set of tool calls to execute.</summary>
public sealed record AgentTurn(string? Text, IReadOnlyList<ToolCall> ToolCalls)
{
    public bool WantsTools => ToolCalls.Count > 0;
}
