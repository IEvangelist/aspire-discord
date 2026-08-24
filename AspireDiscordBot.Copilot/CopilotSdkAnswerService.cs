using System.Diagnostics;
using AspireDiscordBot.Core.Ai;
using AspireDiscordBot.Core.Configuration;
using AspireDiscordBot.Core.Rag;
using AspireDiscordBot.Core.Safety;
using AspireDiscordBot.Core.Telemetry;
using AspireDiscordBot.Core.Vectors;
using GitHub.Copilot;
using Microsoft.Extensions.AI;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace AspireDiscordBot.Copilot;

/// <summary>Grounded agent implementation backed by the official GitHub Copilot SDK.</summary>
public sealed class CopilotSdkAnswerService(
    CopilotRuntime runtime,
    IEmbeddingModel embeddingModel,
    QdrantVectorStore vectorStore,
    QuestionSafetyGuard safetyGuard,
    AgentToolCatalog toolCatalog,
    IOptions<AiOptions> aiOptions,
    IOptions<RetrievalOptions> retrievalOptions,
    IOptions<SafetyOptions> safetyOptions,
    IOptions<AgentOptions> agentOptions,
    ILogger<CopilotSdkAnswerService> logger) : IAnswerService
{
    private readonly AiOptions _ai = aiOptions.Value;
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
        activity?.SetTag("gen_ai.agent.runtime", "github-copilot-sdk");

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
        var tools = await toolCatalog.CreateAsync(citations, _agent.MaxToolCalls, cancellationToken);
        var toolNames = tools.Functions.Select(tool => tool.Name).ToHashSet(StringComparer.Ordinal);
        var client = await runtime.GetClientAsync(cancellationToken);

        var session = await client.CreateSessionAsync(new SessionConfig
        {
            SessionId = $"discord-{Guid.NewGuid():N}",
            ClientName = "aspire-discord-bot",
            Model = _ai.ChatModel,
            ReasoningEffort = _ai.ReasoningEffort,
            EnableConfigDiscovery = false,
            SkipEmbeddingRetrieval = true,
            EnableOnDemandInstructionDiscovery = false,
            EnableFileHooks = false,
            EnableHostGitOperations = false,
            EnableSessionStore = false,
            EnableSkills = false,
            EnableSessionTelemetry = true,
            SkipCustomInstructions = true,
            CoauthorEnabled = false,
            ManageScheduleEnabled = false,
            InfiniteSessions = new InfiniteSessionConfig { Enabled = false },
            SystemMessage = new SystemMessageConfig
            {
                Mode = SystemMessageMode.Append,
                Content = PromptBuilder.AgentSystemPrompt,
            },
            Tools = tools.Functions.Cast<AIFunctionDeclaration>().ToList(),
            AvailableTools = ["custom:*"],
        });

        try
        {
            try
            {
                var response = await session.SendAndWaitAsync(
                    new MessageOptions
                    {
                        Prompt = PromptBuilder.BuildAgentUserPrompt(
                            question,
                            seedContext,
                            toolNames),
                    },
                    TimeSpan.FromSeconds(Math.Max(15, _agent.TimeoutSeconds)),
                    cancellationToken);
                return FinalizeAnswer(response?.Data.Content ?? string.Empty, citations, topScore, activity);
            }
            catch (TimeoutException ex)
            {
                throw new TimeoutException(
                    $"GitHub Copilot SDK did not finish within {_agent.TimeoutSeconds} seconds.",
                    ex);
            }
        }
        catch
        {
            await AbortSafelyAsync(session);
            throw;
        }
        finally
        {
            var sessionId = session.SessionId;
            await CleanupSessionAsync(client, session, sessionId);
        }
    }

    private GroundedAnswer FinalizeAnswer(
        string answer,
        CitationRegistry citations,
        float topScore,
        Activity? activity)
    {
        answer = answer.Trim();
        if (string.IsNullOrWhiteSpace(answer)
            || answer.Contains("NOT_COVERED", StringComparison.OrdinalIgnoreCase))
        {
            activity?.SetTag("gen_ai.agent.outcome", "not_covered");
            return GroundedAnswer.NotFound(PromptBuilder.NotCoveredMessage) with { TopScore = topScore };
        }

        if (!AnswerValidator.IsSafe(answer))
        {
            logger.LogWarning("Suppressed a Copilot SDK answer that failed output validation.");
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

    private async Task AbortSafelyAsync(CopilotSession session)
    {
        try
        {
            await session.AbortAsync();
        }
        catch (Exception ex)
        {
            logger.LogDebug(ex, "Unable to abort Copilot session {SessionId}.", session.SessionId);
        }
    }

    private async Task CleanupSessionAsync(
        CopilotClient client,
        CopilotSession session,
        string sessionId)
    {
        try
        {
            await session.DisposeAsync();
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Unable to dispose Copilot session {SessionId}.", sessionId);
        }

        try
        {
            await client.DeleteSessionAsync(sessionId);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Unable to delete Copilot session {SessionId}.", sessionId);
        }
    }
}
