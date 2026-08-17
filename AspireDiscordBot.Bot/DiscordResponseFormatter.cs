using AspireDiscordBot.Core.Rag;
using Discord;

namespace AspireDiscordBot.Bot;

/// <summary>Formats grounded answers into Discord embeds with source citations.</summary>
public sealed class DiscordResponseFormatter
{
    // .NET / Aspire purple for grounded answers; muted grey when nothing was found.
    private static readonly Color GroundedColor = new(0x51_2B_D4);
    private static readonly Color NotFoundColor = new(0x9E_9E_9E);

    public Embed Build(string question, GroundedAnswer answer)
    {
        var builder = new EmbedBuilder()
            .WithColor(answer.IsGrounded ? GroundedColor : NotFoundColor)
            .WithTitle(Truncate($"❓ {question}", 256))
            .WithDescription(Truncate(answer.Answer, 4000))
            .WithFooter("Grounded in microsoft/aspire & aspire.dev")
            .WithCurrentTimestamp();

        if (answer.IsGrounded && answer.Citations.Count > 0)
        {
            var sources = string.Join(
                "\n",
                answer.Citations
                    .Take(5)
                    .Select(c => $"[{c.Number}] [{Truncate(Sanitize(c.Title), 100)}]({c.Url})"));

            builder.AddField("Sources", Truncate(sources, 1000));
        }

        return builder.Build();
    }

    private static string Sanitize(string text) =>
        text.Replace("[", "(").Replace("]", ")");

    private static string Truncate(string text, int max) =>
        text.Length <= max ? text : text[..(max - 1)] + "…";
}
