using AspireDiscordBot.Core.Ai;
using AspireDiscordBot.Core.Configuration;
using AspireDiscordBot.Core.Safety;
using AspireDiscordBot.Core.Vectors;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace AspireDiscordBot.Core.Rag;

/// <summary>
/// Orchestrates retrieval-augmented generation with defense-in-depth safety:
///   1. Input guard   — reject prompt-injection / jailbreak / extraction attempts up front.
///   2. Topic gating  — the vector store holds only Aspire docs, so an off-topic question
///                      retrieves nothing above the score threshold and is refused.
///   3. Prompt hardening — CONTEXT + QUESTION are fenced and marked as untrusted data.
///   4. Output guard  — suppress answers that leak the prompt or show injection succeeded.
/// If any layer trips, the bot refuses instead of answering.
/// </summary>
public sealed class GroundedAnswerService(
    IEmbeddingModel embeddingModel,
    IChatModel chatModel,
    QdrantVectorStore vectorStore,
    QuestionSafetyGuard safetyGuard,
    IOptions<RetrievalOptions> retrievalOptions,
    IOptions<SafetyOptions> safetyOptions,
    ILogger<GroundedAnswerService> logger)
{
    private readonly RetrievalOptions _retrieval = retrievalOptions.Value;
    private readonly SafetyOptions _safety = safetyOptions.Value;

    public async Task<GroundedAnswer> AnswerAsync(string question, CancellationToken cancellationToken = default)
    {
        question = (question ?? string.Empty).Trim();

        // Layer 1: input guard.
        var verdict = safetyGuard.Evaluate(question);
        if (!verdict.IsAllowed)
        {
            logger.LogWarning("Blocked question ({Category}): {Reason}", verdict.Category, verdict.Reason);
            var message = verdict.Category is SafetyCategory.Empty or SafetyCategory.TooLong
                ? "Please ask a clear Aspire question (up to a few sentences)."
                : _safety.BlockedMessage;
            return GroundedAnswer.NotFound(message);
        }

        var queryVector = await embeddingModel.EmbedAsync(question, cancellationToken);
        var results = await vectorStore.SearchAsync(queryVector, _retrieval.TopK, cancellationToken);
        var topScore = results.Count > 0 ? results[0].Score : 0f;

        // Layer 2: topic gating. Use the stricter of the retrieval and safety thresholds.
        var minScore = Math.Max(_retrieval.MinScore, _safety.MinTopicScore);
        var relevant = results.Where(r => r.Score >= minScore).ToList();
        if (relevant.Count == 0)
        {
            logger.LogInformation("Off-topic or uncovered question (top score {TopScore:F3}).", topScore);
            return GroundedAnswer.NotFound(_safety.OffTopicMessage) with { TopScore = topScore };
        }

        // Layer 3: hardened, data-delimited prompt.
        var userPrompt = PromptBuilder.BuildUserPrompt(question, relevant, _retrieval.MaxContextChars);
        var messages = new List<AiChatMessage>
        {
            AiChatMessage.System(PromptBuilder.SystemPrompt),
            AiChatMessage.User(userPrompt),
        };

        var answer = (await chatModel.CompleteAsync(messages, cancellationToken)).Trim();

        // The model signals insufficient context / off-topic with the NOT_COVERED sentinel.
        if (answer.Length == 0 || answer.Contains("NOT_COVERED", StringComparison.OrdinalIgnoreCase))
        {
            return GroundedAnswer.NotFound(PromptBuilder.NotCoveredMessage) with { TopScore = topScore };
        }

        // Layer 4: output guard.
        if (!AnswerValidator.IsSafe(answer))
        {
            logger.LogWarning("Suppressed a model answer that failed output validation.");
            return GroundedAnswer.NotFound(_safety.BlockedMessage) with { TopScore = topScore };
        }

        var citations = BuildCitations(relevant);
        return new GroundedAnswer
        {
            IsGrounded = true,
            Answer = answer,
            Citations = citations,
            TopScore = topScore,
        };
    }

    /// <summary>Builds a de-duplicated citation list preserving retrieval order.</summary>
    private static List<Citation> BuildCitations(IReadOnlyList<VectorSearchResult> results)
    {
        var citations = new List<Citation>();
        var seenUrls = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var number = 1;

        foreach (var r in results)
        {
            if (seenUrls.Add(r.Url))
            {
                citations.Add(new Citation(number++, r.Title, r.Url, r.Repo));
            }
        }

        return citations;
    }
}
