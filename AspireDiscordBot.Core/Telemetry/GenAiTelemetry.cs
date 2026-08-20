using System.Diagnostics;
using System.Diagnostics.Metrics;

namespace AspireDiscordBot.Core.Telemetry;

/// <summary>
/// Emits OpenTelemetry GenAI telemetry (spans + metrics) following the OTel GenAI semantic
/// conventions, so AI operations light up the Aspire dashboard's GenAI visualization. One
/// <see cref="ActivitySource"/> and <see cref="Meter"/> named <see cref="Name"/> cover chat,
/// embeddings, tool execution, and the agent as a whole. Register the source + meter with
/// OpenTelemetry (done in ServiceDefaults) for the data to be exported.
/// </summary>
public static class GenAiTelemetry
{
    /// <summary>Shared name for the ActivitySource and Meter (registered in ServiceDefaults).</summary>
    public const string Name = "AspireDiscordBot.GenAI";

    // GenAI semantic-convention attribute keys.
    public const string OperationName = "gen_ai.operation.name";
    public const string ProviderNameKey = "gen_ai.provider.name";
    public const string SystemKey = "gen_ai.system"; // legacy alias, still read by some tools
    public const string RequestModel = "gen_ai.request.model";
    public const string ResponseModel = "gen_ai.response.model";
    public const string ResponseId = "gen_ai.response.id";
    public const string RequestMaxTokens = "gen_ai.request.max_tokens";
    public const string RequestTemperature = "gen_ai.request.temperature";
    public const string RequestReasoningLevel = "gen_ai.request.reasoning.level";
    public const string ResponseFinishReasons = "gen_ai.response.finish_reasons";
    public const string UsageInputTokens = "gen_ai.usage.input_tokens";
    public const string UsageOutputTokens = "gen_ai.usage.output_tokens";
    public const string ToolNameKey = "gen_ai.tool.name";
    public const string ToolCallId = "gen_ai.tool.call.id";
    public const string ToolType = "gen_ai.tool.type";
    public const string TokenType = "gen_ai.token.type";
    public const string ErrorType = "error.type";

    // Operation names.
    public const string OpChat = "chat";
    public const string OpEmbeddings = "embeddings";
    public const string OpExecuteTool = "execute_tool";
    public const string OpInvokeAgent = "invoke_agent";

    public static readonly ActivitySource ActivitySource = new(Name);
    private static readonly Meter Meter = new(Name);

    private static readonly Histogram<long> TokenUsageHistogram =
        Meter.CreateHistogram<long>("gen_ai.client.token.usage", "{token}", "Number of tokens used per GenAI operation.");

    private static readonly Histogram<double> OperationDurationHistogram =
        Meter.CreateHistogram<double>("gen_ai.client.operation.duration", "s", "GenAI operation duration.");

    /// <summary>
    /// Maps our provider key to a GenAI-convention provider name. The Copilot endpoint proxies
    /// OpenAI models, so it reports as <c>openai</c>.
    /// </summary>
    public static string ProviderName(string provider) => provider.ToLowerInvariant() switch
    {
        "azureopenai" => "azure.ai.openai",
        "azureaifoundry" => "azure.ai.inference",
        "ollama" => "ollama",
        _ => "openai", // openai, copilot
    };

    /// <summary>Starts a GenAI client span named "{operation} {model}" with the required attributes.</summary>
    public static Activity? StartOperation(string operation, string provider, string model)
    {
        var providerName = ProviderName(provider);
        var activity = ActivitySource.StartActivity($"{operation} {model}", ActivityKind.Client);
        if (activity is null)
        {
            return null;
        }

        activity.SetTag(OperationName, operation);
        activity.SetTag(ProviderNameKey, providerName);
        activity.SetTag(SystemKey, providerName);
        activity.SetTag(RequestModel, model);
        return activity;
    }

    /// <summary>Starts an execute_tool span named "execute_tool {toolName}".</summary>
    public static Activity? StartToolExecution(string toolName, string? callId)
    {
        var activity = ActivitySource.StartActivity($"{OpExecuteTool} {toolName}", ActivityKind.Internal);
        if (activity is null)
        {
            return null;
        }

        activity.SetTag(OperationName, OpExecuteTool);
        activity.SetTag(ToolNameKey, toolName);
        activity.SetTag(ToolType, "function");
        if (!string.IsNullOrEmpty(callId))
        {
            activity.SetTag(ToolCallId, callId);
        }

        return activity;
    }

    /// <summary>Records token usage on the span and the token-usage histogram.</summary>
    public static void RecordUsage(
        Activity? activity, string operation, string provider, string model,
        int? inputTokens, int? outputTokens, string? responseModel = null, string? responseId = null,
        string? finishReason = null)
    {
        var providerName = ProviderName(provider);

        if (inputTokens is { } inTok)
        {
            activity?.SetTag(UsageInputTokens, inTok);
            TokenUsageHistogram.Record(inTok,
                new(OperationName, operation), new(ProviderNameKey, providerName),
                new(RequestModel, model), new(TokenType, "input"));
        }

        if (outputTokens is { } outTok)
        {
            activity?.SetTag(UsageOutputTokens, outTok);
            TokenUsageHistogram.Record(outTok,
                new(OperationName, operation), new(ProviderNameKey, providerName),
                new(RequestModel, model), new(TokenType, "output"));
        }

        if (!string.IsNullOrEmpty(responseModel))
        {
            activity?.SetTag(ResponseModel, responseModel);
        }

        if (!string.IsNullOrEmpty(responseId))
        {
            activity?.SetTag(ResponseId, responseId);
        }

        if (!string.IsNullOrEmpty(finishReason))
        {
            activity?.SetTag(ResponseFinishReasons, new[] { finishReason });
        }
    }

    /// <summary>Records the operation duration on the duration histogram (call once per operation).</summary>
    public static void RecordDuration(
        string operation, string provider, string model, double seconds, string? errorType = null)
    {
        var tags = new TagList
        {
            { OperationName, operation },
            { ProviderNameKey, ProviderName(provider) },
            { RequestModel, model },
        };
        if (!string.IsNullOrEmpty(errorType))
        {
            tags.Add(ErrorType, errorType);
        }

        OperationDurationHistogram.Record(seconds, tags);
    }

    /// <summary>Marks a span as failed and tags the error type per the conventions.</summary>
    public static void RecordError(Activity? activity, Exception ex)
    {
        activity?.SetTag(ErrorType, ex.GetType().FullName);
        activity?.SetStatus(ActivityStatusCode.Error, ex.Message);
    }
}
