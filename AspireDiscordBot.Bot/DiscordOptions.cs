namespace AspireDiscordBot.Bot;

/// <summary>Configuration for the Discord bot.</summary>
public sealed class DiscordOptions
{
    public const string SectionName = "Discord";

    /// <summary>Bot token from the Discord Developer Portal. Supplied via user-secrets / Aspire parameters.</summary>
    public string Token { get; set; } = "";

    /// <summary>
    /// Optional guild (server) id. When set, the <c>/ask</c> command is registered to that guild
    /// for instant availability; otherwise it is registered globally (can take up to 1 hour).
    /// </summary>
    public ulong? GuildId { get; set; }

    /// <summary>
    /// When true the bot also answers when @mentioned. This requires the privileged
    /// "Message Content Intent" to be enabled for the app in the Developer Portal.
    /// </summary>
    public bool MentionEnabled { get; set; } = true;
}
