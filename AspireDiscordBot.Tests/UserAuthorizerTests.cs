using AspireDiscordBot.Bot;

namespace AspireDiscordBot.Tests;

public class UserAuthorizerTests
{
    [Fact]
    public void AllowsEveryone_WhenListEmptyOrNull()
    {
        Assert.True(UserAuthorizer.IsAllowed(123, []));
        Assert.True(UserAuthorizer.IsAllowed(123, null));
    }

    [Fact]
    public void AllowsOnlyListedUsers_WhenListPopulated()
    {
        ulong[] allowed = [111, 222];
        Assert.True(UserAuthorizer.IsAllowed(111, allowed));
        Assert.True(UserAuthorizer.IsAllowed(222, allowed));
        Assert.False(UserAuthorizer.IsAllowed(333, allowed));
    }
}
