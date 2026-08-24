using System.Diagnostics;
using AspireDiscordBot.Core.Ai;
using AspireDiscordBot.Core.Configuration;
using AspireDiscordBot.Core.Safety;
using AspireDiscordBot.Core.Telemetry;
using AspireDiscordBot.Core.Vectors;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace AspireDiscordBot.Core.Rag;

/// <summary>
/// Tool-calling answer service for OpenAI-compatible Responses providers. Tool implementations are
/// shared with the Copilot SDK path through <see cref="AgentToolCatalog"/>.
/// </summary>
public sealed class AgenticAnswerService(
    IEmbeddingModel embeddingModel,
    OpenAiCompatibleClient client,
    QdrantVectorStore vectorStore,
    QuestionSafetyGuard safetyGuard,
    AgentToolCatalog toolCatalog,
    IOptions<RetrievalOptions> retrievalOptions,
    IOptions<SafetyOptions> safetyOptions,
    IOptions<AgentOptions> agentOptions,
    ILogger<AgenticAnswerService> logger) : IAnswerService
{
    private readonly RetrievalOptions _retrieval = retrievalOptions.Value;
    private readonly SafetyOptions _safety = safetyOptions.Value;
    private readonly AgentOptions _agent = agentOptions.Value;

    public async Task<GroundedAnswer> AnswerAsync(
        string question,
        CancellationToken cancellationToken = default)
    {
        question = (question ?? string.Empty).Trim();

        using var activity = GenAiTelemetry.ActivitySource.StartActivity(
            $"{GenAiTelemetry.OpInvokeAgent} aspire-docs-agent",
            ActivityKind.Internal);
        activity?.SetTag(GenAiTelemetry.OperationName, GenAiTelemetry.OpInvokeAgent);
        activity?.SetTag("gen_ai.agent.name", "aspire-docs-agent");
        activity?.SetTag("gen_ai.agent.runtime", "responses");

        var verdict = safetyGuard.Evaluate(question);
        if (!verdict.IsAllowed)
        {
            logger.LogWarning("Blocked question ({Category}): {Reason}", verdict.Category, verdict.Reason);
            activity?.SetTag("gen_ai.agent.outcome", $"blocked:{verdict.Category}");
            var message = verdict.Category is SafetyCategory.Empty or SafetyCategory.TooLong
                ? "Please ask a clear Aspire question (up to a few sentences)."
                : _safety.BlockedMessage;
            return GroundedAnswer.NotFound(message);
        }

        var queryVector = await embeddingModel.EmbedAsync(question, cancellationToken);
        var seed = await vectorStore.SearchAsync(queryVector, _retrieval.TopK, cancellationToken);
        var topScore = seed.Count > 0 ? seed[0].Score : 0f;
        var minScore = Math.Max(_retrieval.MinScore, _safety.MinTopicScore);
        if (!seed.Any(result => result.Score >= minScore))
        {
            logger.LogInformation("Off-topic or uncovered question (top score {TopScore:F3}).", topScore);
            activity?.SetTag("gen_ai.agent.outcome", "off_topic");
            return GroundedAnswer.NotFound(_safety.OffTopicMessage) with { TopScore = topScore };
        }

        var citations = new CitationRegistry();
        var seedContext = citations.FormatResults(seed.Where(result => result.Score >= minScore).ToList());
        var tools = await toolCatalog.CreateAsync(
            citations,
            _agent.MaxToolCalls,
            cancellationToken);

        var items = new List<AgentItem>
        {
            AgentMessage.System(PromptBuilder.AgentSystemPrompt),
            AgentMessage.User(PromptBuilder.BuildAgentUserPrompt(
                question,
                seedContext,
                tools.Functions.Select(tool => tool.Name).ToArray())),
        };

        var answer = await RunAgentLoopAsync(items, tools, cancellationToken);
        return FinalizeAnswer(answer, citations, topScore, activity);
    }

    private async Task<string> RunAgentLoopAsync(
        List<AgentItem> items,
        AgentToolSet tools,
        CancellationToken cancellationToken)
    {
        for (var iteration = 0; iteration < _agent.MaxIterations; iteration++)
        {
            var available = tools.Budget.Remaining > 0
                ? tools.Specs
                : Array.Empty<ToolSpec>();
            var turn = await client.RunAgentTurnAsync(items, available, cancellationToken);

            if (!turn.WantsTools)
            {
                return (turn.Text ?? string.Empty).Trim();
            }

            foreach (var call in turn.ToolCalls)
            {
                items.Add(new AgentToolCall(call.CallId, call.Name, call.ArgumentsJson));
                var result = await tools.InvokeAsync(call, cancellationToken);
                items.Add(new AgentToolOutput(call.CallId, result.Output));
            }
        }

        logger.LogDebug("Agent hit the iteration limit; forcing a final answer.");
        items.Add(AgentMessage.User(
            "Provide your final answer now using only the information gathered above. Cite sources with [n]. "
            + "If the gathered material doesn't cover the question, reply exactly NOT_COVERED."));
        var final = await client.RunAgentTurnAsync(items, [], cancellationToken);
        return (final.Text ?? string.Empty).Trim();
    }

    private GroundedAnswer FinalizeAnswer(
        string answer,
        CitationRegistry citations,
        float topScore,
        Activity? activity)
    {
        if (string.IsNullOrWhiteSpace(answer)
            || answer.Contains("NOT_COVERED", StringComparison.OrdinalIgnoreCase))
        {
            activity?.SetTag("gen_ai.agent.outcome", "not_covered");
            return GroundedAnswer.NotFound(PromptBuilder.NotCoveredMessage) with { TopScore = topScore };
        }

        if (!AnswerValidator.IsSafe(answer))
        {
            logger.LogWarning("Suppressed a model answer that failed output validation.");
            activity?.SetTag("gen_ai.agent.outcome", "output_blocked");
            return GroundedAnswer.NotFound(_safety.BlockedMessage) with { TopScore = topScore };
        }

        var cited = citations.CitedBy(answer);
        activity?.SetTag("gen_ai.agent.outcome", "answered");
        activity?.SetTag("gen_ai.agent.citation_count", cited.Count);
        return new GroundedAnswer
        {
            IsGrounded = true,
            Answer = answer,
            Citations = cited,
            TopScore = topScore,
        };
    }

}
