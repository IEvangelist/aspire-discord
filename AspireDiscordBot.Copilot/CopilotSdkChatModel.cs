using AspireDiscordBot.Core.Ai;
using AspireDiscordBot.Core.Configuration;
using GitHub.Copilot;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace AspireDiscordBot.Copilot;

/// <summary>Single-shot chat adapter for the official Copilot SDK.</summary>
public sealed class CopilotSdkChatModel(
    CopilotRuntime runtime,
    IOptions<AiOptions> aiOptions,
    IOptions<AgentOptions> agentOptions,
    ILogger<CopilotSdkChatModel> logger) : IChatModel
{
    private readonly AiOptions _ai = aiOptions.Value;
    private readonly AgentOptions _agent = agentOptions.Value;

    public async Task<string> CompleteAsync(
        IReadOnlyList<AiChatMessage> messages,
        CancellationToken cancellationToken = default)
    {
        var system = string.Join(
            "\n\n",
            messages.Where(message => message.Role == "system").Select(message => message.Content));
        var prompt = string.Join(
            "\n\n",
            messages.Where(message => message.Role != "system")
                .Select(message => $"{message.Role.ToUpperInvariant()}:\n{message.Content}"));
        var client = await runtime.GetClientAsync(cancellationToken);
        var session = await client.CreateSessionAsync(new SessionConfig
        {
            SessionId = $"discord-single-{Guid.NewGuid():N}",
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
            SystemMessage = string.IsNullOrWhiteSpace(system)
                ? null
                : new SystemMessageConfig
                {
                    Mode = SystemMessageMode.Append,
                    Content = system,
                },
            Tools = [],
            AvailableTools = [],
        });

        try
        {
            try
            {
                var response = await session.SendAndWaitAsync(
                    prompt,
                    TimeSpan.FromSeconds(Math.Max(15, _agent.TimeoutSeconds)),
                    cancellationToken);
                return response?.Data.Content?.Trim() ?? string.Empty;
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
