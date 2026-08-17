namespace AspireDiscordBot.Core.Ai;

/// <summary>A single chat message in an OpenAI-compatible conversation.</summary>
/// <param name="Role">One of <c>system</c>, <c>user</c>, <c>assistant</c>.</param>
/// <param name="Content">The message text.</param>
public readonly record struct AiChatMessage(string Role, string Content)
{
    public static AiChatMessage System(string content) => new("system", content);
    public static AiChatMessage User(string content) => new("user", content);
    public static AiChatMessage Assistant(string content) => new("assistant", content);
}
