using AspireDiscordBot.Core.Configuration;
using AspireDiscordBot.Core.Documents;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

namespace AspireDiscordBot.Tests;

public sealed class GitSourceSnapshotProviderTests : IDisposable
{
    private readonly string _root = Path.Combine(
        Path.GetTempPath(),
        "aspire-discord-git-tests",
        Guid.NewGuid().ToString("N"));

    [Fact]
    public async Task ManagedSnapshot_TracksNewCommits_WithoutMutatingOldSnapshot()
    {
        var source = Path.Combine(_root, "source");
        var cache = Path.Combine(_root, "cache");
        Directory.CreateDirectory(Path.Combine(source, "src", "Aspire.Hosting"));
        await GitAsync(["init", "--initial-branch=main", source]);
        await GitAsync(["-C", source, "config", "user.email", "tests@example.invalid"]);
        await GitAsync(["-C", source, "config", "user.name", "Tests"]);
        await File.WriteAllTextAsync(
            Path.Combine(source, "src", "Aspire.Hosting", "Version.cs"),
            "public static class Version { public const int Value = 1; }");
        await CommitAsync(source, "first");

        var options = Options.Create(new ApiSurfaceOptions
        {
            Enabled = true,
            RepositoryUrl = source,
            SourceRef = "main",
            CachePath = cache,
            CitationRepo = "microsoft/aspire",
        });
        var provider = new GitSourceSnapshotProvider(
            options,
            NullLogger<GitSourceSnapshotProvider>.Instance);

        var first = await provider.GetAsync();
        Assert.True(File.Exists(Path.Combine(first.SourceRoot, "Aspire.Hosting", "Version.cs")));

        await File.WriteAllTextAsync(
            Path.Combine(source, "src", "Aspire.Hosting", "Version.cs"),
            "public static class Version { public const int Value = 2; }");
        await CommitAsync(source, "second");
        var second = await provider.GetAsync();

        Assert.NotEqual(first.Revision, second.Revision);
        Assert.Contains("Value = 1", await File.ReadAllTextAsync(
            Path.Combine(first.SourceRoot, "Aspire.Hosting", "Version.cs")));
        Assert.Contains("Value = 2", await File.ReadAllTextAsync(
            Path.Combine(second.SourceRoot, "Aspire.Hosting", "Version.cs")));
    }

    private static async Task CommitAsync(string repository, string message)
    {
        await GitAsync(["-C", repository, "add", "src"]);
        await GitAsync(["-C", repository, "commit", "-m", message]);
    }

    private static async Task GitAsync(IReadOnlyList<string> arguments)
    {
        var result = await ProcessRunner.RunAsync(
            "git",
            arguments,
            TimeSpan.FromSeconds(30));
        Assert.True(result.ExitCode == 0, result.StandardError);
    }

    public void Dispose()
    {
        if (Directory.Exists(_root))
        {
            foreach (var path in Directory.EnumerateFileSystemEntries(
                         _root,
                         "*",
                         SearchOption.AllDirectories))
            {
                File.SetAttributes(path, FileAttributes.Normal);
            }

            Directory.Delete(_root, recursive: true);
        }
    }
}
