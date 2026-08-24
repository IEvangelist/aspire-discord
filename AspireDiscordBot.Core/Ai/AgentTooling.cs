using System.Diagnostics;
using System.Text.Json;
using AspireDiscordBot.Core.Rag;
using AspireDiscordBot.Core.Telemetry;
using Microsoft.Extensions.AI;
using Microsoft.Extensions.Logging;

namespace AspireDiscordBot.Core.Ai;

/// <summary>The normalized output returned by every agent tool.</summary>
public sealed record AgentToolResult(string Output, int ResultCount = 0);

/// <summary>A thread-safe per-question budget shared by all tool providers.</summary>
public sealed class AgentToolBudget(int maximumCalls)
{
    private int _remaining = Math.Max(0, maximumCalls);

    public int Remaining => Math.Max(0, Volatile.Read(ref _remaining));

    public bool TryConsume()
    {
        while (true)
        {
            var current = Volatile.Read(ref _remaining);
            if (current <= 0)
            {
                return false;
            }

            if (Interlocked.CompareExchange(ref _remaining, current - 1, current) == current)
            {
                return true;
            }
        }
    }
}

/// <summary>Per-question state available to tool providers.</summary>
public sealed record AgentToolContext(CitationRegistry Citations, AgentToolBudget Budget);

/// <summary>Creates tools for one isolated agent question.</summary>
public interface IAgentToolProvider
{
    ValueTask<IReadOnlyList<AIFunction>> CreateToolsAsync(
        AgentToolContext context,
        CancellationToken cancellationToken = default);
}

/// <summary>
/// Builds a collision-free tool set and applies the same budget, telemetry, and explicit failure
/// result to tools regardless of which agent runtime invokes them.
/// </summary>
public sealed class AgentToolCatalog(
    IEnumerable<IAgentToolProvider> providers,
    ILoggerFactory loggerFactory)
{
    public async Task<AgentToolSet> CreateAsync(
        CitationRegistry citations,
        int maximumCalls,
        CancellationToken cancellationToken = default)
    {
        var budget = new AgentToolBudget(maximumCalls);
        var context = new AgentToolContext(citations, budget);
        var tools = new Dictionary<string, AIFunction>(StringComparer.Ordinal);

        foreach (var provider in providers)
        {
            var provided = await provider.CreateToolsAsync(context, cancellationToken);
            foreach (var tool in provided)
            {
                if (!tools.TryAdd(
                    tool.Name,
                    new BudgetedAgentTool(tool, budget, loggerFactory.CreateLogger(tool.Name))))
                {
                    throw new InvalidOperationException($"Multiple agent tool providers registered '{tool.Name}'.");
                }
            }
        }

        return new AgentToolSet(tools, budget);
    }
}

/// <summary>A per-question collection of invocable tools.</summary>
public sealed class AgentToolSet(
    IReadOnlyDictionary<string, AIFunction> tools,
    AgentToolBudget budget)
{
    public AgentToolBudget Budget { get; } = budget;

    public IReadOnlyList<AIFunction> Functions { get; } = tools.Values.ToArray();

    public IReadOnlyList<ToolSpec> Specs { get; } = tools.Values
        .Select(tool => new ToolSpec(
            tool.Name,
            tool.Description ?? string.Empty,
            tool.JsonSchema.GetRawText()))
        .ToArray();

    public bool Contains(string name) => tools.ContainsKey(name);

    public async Task<AgentToolResult> InvokeAsync(ToolCall call, CancellationToken cancellationToken = default)
    {
        if (!tools.TryGetValue(call.Name, out var tool))
        {
            return new AgentToolResult($"Unknown tool '{call.Name}'.");
        }

        try
        {
            var arguments = AgentToolArguments.Parse(call.ArgumentsJson);
            var result = await tool.InvokeAsync(arguments, cancellationToken);
            return AgentToolResultNormalizer.Normalize(result);
        }
        catch (JsonException ex)
        {
            return new AgentToolResult(
                $"Tool '{call.Name}' received invalid JSON arguments: {ex.Message}");
        }
    }
}

internal static class AgentToolArguments
{
    public static AIFunctionArguments Parse(string json)
    {
        using var document = JsonDocument.Parse(string.IsNullOrWhiteSpace(json) ? "{}" : json);
        if (document.RootElement.ValueKind is not JsonValueKind.Object)
        {
            throw new JsonException("Tool arguments must be a JSON object.");
        }

        var values = document.RootElement.EnumerateObject()
            .ToDictionary(property => property.Name, property => Convert(property.Value), StringComparer.Ordinal);
        return new AIFunctionArguments(values!);
    }

    private static object? Convert(JsonElement value) => value.ValueKind switch
    {
        JsonValueKind.Object => value.EnumerateObject()
            .ToDictionary(property => property.Name, property => Convert(property.Value), StringComparer.Ordinal),
        JsonValueKind.Array => value.EnumerateArray().Select(Convert).ToArray(),
        JsonValueKind.String => value.GetString(),
        JsonValueKind.Number when value.TryGetInt64(out var integer) => integer,
        JsonValueKind.Number => value.GetDouble(),
        JsonValueKind.True => true,
        JsonValueKind.False => false,
        JsonValueKind.Null => null,
        _ => value.GetRawText(),
    };
}

internal static class AgentToolResultNormalizer
{
    public static AgentToolResult Normalize(object? value)
    {
        if (value is AgentToolResult result)
        {
            return result;
        }

        if (value is string text)
        {
            return new AgentToolResult(text);
        }

        if (value is JsonElement json)
        {
            if (json.ValueKind is JsonValueKind.Object
                && json.TryGetProperty("output", out var output))
            {
                var count = json.TryGetProperty("resultCount", out var resultCount)
                    && resultCount.TryGetInt32(out var parsed)
                        ? parsed
                        : 0;
                return new AgentToolResult(output.GetString() ?? string.Empty, count);
            }

            return new AgentToolResult(json.GetRawText());
        }

        return new AgentToolResult(
            value is null ? string.Empty : JsonSerializer.Serialize(value, value.GetType()));
    }
}

internal sealed class BudgetedAgentTool(
    AIFunction inner,
    AgentToolBudget budget,
    ILogger logger) : AIFunction
{
    private readonly IReadOnlyDictionary<string, object?> _additionalProperties =
        CreateAdditionalProperties(inner);

    public override string Name => inner.Name;
    public override string Description => inner.Description;
    public override JsonElement JsonSchema => inner.JsonSchema;
    public override JsonElement? ReturnJsonSchema => inner.ReturnJsonSchema;
    public override JsonSerializerOptions JsonSerializerOptions => inner.JsonSerializerOptions;
    public override IReadOnlyDictionary<string, object?> AdditionalProperties => _additionalProperties;

    protected override async ValueTask<object?> InvokeCoreAsync(
        AIFunctionArguments arguments,
        CancellationToken cancellationToken)
    {
        if (!budget.TryConsume())
        {
            return new AgentToolResult(
                "Tool-call budget exhausted. Answer using the information already gathered.");
        }

        using var activity = GenAiTelemetry.StartToolExecution(Name, Activity.Current?.Id);
        try
        {
            var value = await inner.InvokeAsync(arguments, cancellationToken);
            var result = AgentToolResultNormalizer.Normalize(value);
            activity?.SetTag("gen_ai.tool.result_count", result.ResultCount);
            logger.LogInformation("Agent tool {Tool} returned {Count} results.", Name, result.ResultCount);
            return result;
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            GenAiTelemetry.RecordError(activity, ex);
            logger.LogWarning(ex, "Agent tool {Tool} failed.", Name);
            return new AgentToolResult(
                $"Tool '{Name}' failed: {ex.Message}. Try a different search or answer with the information already gathered.");
        }
    }

    private static IReadOnlyDictionary<string, object?> CreateAdditionalProperties(AIFunction inner)
    {
        var properties = inner.AdditionalProperties is null
            ? new Dictionary<string, object?>()
            : new Dictionary<string, object?>(inner.AdditionalProperties);
        properties["skip_permission"] = true;
        return properties;
    }
}
