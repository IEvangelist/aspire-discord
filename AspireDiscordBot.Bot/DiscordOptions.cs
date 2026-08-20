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
    /// "Message Content Intent" to be enabled for the app in the Discord Developer Portal
    /// (Bot → Privileged Gateway Intents). Leave false to run with the <c>/ask</c> slash command
    /// only, which needs no privileged intents.
    /// </summary>
    public bool MentionEnabled { get; set; }

    /// <summary>
    /// Optional allow-list of Discord user IDs. When empty (default) the bot answers everyone; when
    /// it contains any ids, ONLY those users get answers — slash commands from others are politely
    /// declined (privately), and mentions from others are ignored. Use this to lock the bot to
    /// yourself while testing. Get your id in Discord: enable Settings → Advanced → Developer Mode,
    /// then right-click your name → Copy User ID.
    /// </summary>
    public ulong[] AllowedUserIds { get; set; } = [];
}
