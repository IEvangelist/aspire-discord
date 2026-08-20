using System.Text.Json;
using System.Text.Json.Nodes;

namespace AspireDiscordBot.Core.Telemetry;

/// <summary>A single part of a GenAI message (text, a tool call, or a tool-call response).</summary>
public sealed record GenAiPart
{
    public required string Type { get; init; }
    public string? Content { get; init; }
    public string? Id { get; init; }
    public string? Name { get; init; }
    public string? Arguments { get; init; }
    public string? Response { get; init; }

    public static GenAiPart Text(string content) => new() { Type = "text", Content = content };
    public static GenAiPart ToolCall(string id, string name, string arguments) =>
        new() { Type = "tool_call", Id = id, Name = name, Arguments = arguments };
    public static GenAiPart ToolResult(string id, string response) =>
        new() { Type = "tool_call_response", Id = id, Response = response };
}

/// <summary>A GenAI message: a role plus its parts, and (for outputs) an optional finish reason.</summary>
public sealed record GenAiMsg(string Role, IReadOnlyList<GenAiPart> Parts, string? FinishReason = null);

/// <summary>
/// Builds the opt-in GenAI content attributes (<c>gen_ai.input.messages</c>,
/// <c>gen_ai.output.messages</c>, <c>gen_ai.system_instructions</c>) in the exact JSON shape the OTel
/// GenAI conventions define, which the Aspire dashboard renders in a span's Input/Output panels.
/// </summary>
public static class GenAiContent
{
    public const string InputMessagesKey = "gen_ai.input.messages";
    public const string OutputMessagesKey = "gen_ai.output.messages";
    public const string SystemInstructionsKey = "gen_ai.system_instructions";

    /// <summary>Serializes a list of messages to the conventions' JSON array format.</summary>
    public static string Messages(IEnumerable<GenAiMsg> messages)
    {
        var array = new JsonArray();
        foreach (var m in messages)
        {
            var parts = new JsonArray();
            foreach (var p in m.Parts)
            {
                parts.Add(PartNode(p));
            }

            var obj = new JsonObject { ["role"] = m.Role, ["parts"] = parts };
            if (!string.IsNullOrEmpty(m.FinishReason))
            {
                obj["finish_reason"] = m.FinishReason;
            }

            array.Add(obj);
        }

        return array.ToJsonString();
    }

    /// <summary>Serializes system instruction text(s) to the conventions' parts-array format.</summary>
    public static string SystemInstructions(IEnumerable<string> instructions)
    {
        var array = new JsonArray();
        foreach (var text in instructions)
        {
            array.Add(new JsonObject { ["type"] = "text", ["content"] = text });
        }

        return array.ToJsonString();
    }

    private static JsonObject PartNode(GenAiPart p) => p.Type switch
    {
        "text" => new JsonObject { ["type"] = "text", ["content"] = p.Content ?? "" },
        "tool_call" => new JsonObject
        {
            ["type"] = "tool_call",
            ["id"] = p.Id,
            ["name"] = p.Name,
            ["arguments"] = ParseOrString(p.Arguments),
        },
        "tool_call_response" => new JsonObject
        {
            ["type"] = "tool_call_response",
            ["id"] = p.Id,
            ["response"] = p.Response ?? "",
        },
        _ => new JsonObject { ["type"] = p.Type, ["content"] = p.Content ?? "" },
    };

    /// <summary>Tool-call arguments are JSON; embed as an object when parseable, else as a string.</summary>
    private static JsonNode? ParseOrString(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw))
        {
            return JsonValue.Create("");
        }

        try
        {
            return JsonNode.Parse(raw);
        }
        catch (JsonException)
        {
            return JsonValue.Create(raw);
        }
    }
}
