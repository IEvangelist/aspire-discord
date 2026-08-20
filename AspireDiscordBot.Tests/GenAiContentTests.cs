using System.Text.Json;
using AspireDiscordBot.Core.Telemetry;

namespace AspireDiscordBot.Tests;

public class GenAiContentTests
{
    [Fact]
    public void Messages_SerializesTextParts_WithRoleAndFinishReason()
    {
        var json = GenAiContent.Messages([
            new GenAiMsg("user", [GenAiPart.Text("How do I add Redis?")]),
            new GenAiMsg("assistant", [GenAiPart.Text("Use AddRedis.")], "stop"),
        ]);

        using var doc = JsonDocument.Parse(json);
        var arr = doc.RootElement;
        Assert.Equal(2, arr.GetArrayLength());

        var user = arr[0];
        Assert.Equal("user", user.GetProperty("role").GetString());
        Assert.Equal("text", user.GetProperty("parts")[0].GetProperty("type").GetString());
        Assert.Equal("How do I add Redis?", user.GetProperty("parts")[0].GetProperty("content").GetString());

        var assistant = arr[1];
        Assert.Equal("stop", assistant.GetProperty("finish_reason").GetString());
    }

    [Fact]
    public void Messages_ToolCall_EmbedsArgumentsAsObject()
    {
        var json = GenAiContent.Messages([
            new GenAiMsg("assistant", [GenAiPart.ToolCall("call_1", "search_docs", """{"query":"redis"}""")]),
        ]);

        using var doc = JsonDocument.Parse(json);
        var part = doc.RootElement[0].GetProperty("parts")[0];
        Assert.Equal("tool_call", part.GetProperty("type").GetString());
        Assert.Equal("call_1", part.GetProperty("id").GetString());
        Assert.Equal("search_docs", part.GetProperty("name").GetString());
        // Arguments parsed to a JSON object, not a string.
        Assert.Equal(JsonValueKind.Object, part.GetProperty("arguments").ValueKind);
        Assert.Equal("redis", part.GetProperty("arguments").GetProperty("query").GetString());
    }

    [Fact]
    public void Messages_ToolCall_FallsBackToStringForInvalidJson()
    {
        var json = GenAiContent.Messages([
            new GenAiMsg("assistant", [GenAiPart.ToolCall("c", "t", "not json")]),
        ]);
        using var doc = JsonDocument.Parse(json);
        var args = doc.RootElement[0].GetProperty("parts")[0].GetProperty("arguments");
        Assert.Equal(JsonValueKind.String, args.ValueKind);
    }

    [Fact]
    public void Messages_ToolResult_UsesResponseField()
    {
        var json = GenAiContent.Messages([
            new GenAiMsg("tool", [GenAiPart.ToolResult("call_1", "6 results")]),
        ]);
        using var doc = JsonDocument.Parse(json);
        var part = doc.RootElement[0].GetProperty("parts")[0];
        Assert.Equal("tool_call_response", part.GetProperty("type").GetString());
        Assert.Equal("6 results", part.GetProperty("response").GetString());
    }

    [Fact]
    public void SystemInstructions_ProducesTextPartsArray()
    {
        var json = GenAiContent.SystemInstructions(["You are helpful.", "Be terse."]);
        using var doc = JsonDocument.Parse(json);
        Assert.Equal(2, doc.RootElement.GetArrayLength());
        Assert.Equal("text", doc.RootElement[0].GetProperty("type").GetString());
        Assert.Equal("You are helpful.", doc.RootElement[0].GetProperty("content").GetString());
    }
}
