namespace AspireDiscordBot.Core.Ai;

/// <summary>Generates a chat completion from an OpenAI-compatible provider.</summary>
public interface IChatModel
{
    Task<string> CompleteAsync(IReadOnlyList<AiChatMessage> messages, CancellationToken cancellationToken = default);
}
