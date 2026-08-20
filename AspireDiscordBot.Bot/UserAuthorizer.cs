namespace AspireDiscordBot.Bot;

/// <summary>
/// Decides whether a Discord user is allowed to use the bot. When the allow-list is empty the bot
/// is open to everyone (the default); when it contains any ids, only those users are allowed. This
/// lets an operator lock the bot to themselves (or a small group) while testing.
/// </summary>
public static class UserAuthorizer
{
    public static bool IsAllowed(ulong userId, IReadOnlyCollection<ulong>? allowedUserIds) =>
        allowedUserIds is null || allowedUserIds.Count == 0 || allowedUserIds.Contains(userId);
}
