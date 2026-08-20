namespace AspireDiscordBot.Core.Rag;

/// <summary>Answers a user question, grounded in the Aspire sources of truth, with citations.</summary>
public interface IAnswerService
{
    Task<GroundedAnswer> AnswerAsync(string question, CancellationToken cancellationToken = default);
}
