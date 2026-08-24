using System.Formats.Tar;
using System.Text.RegularExpressions;
using AspireDiscordBot.Core.Configuration;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace AspireDiscordBot.Core.Documents;

/// <summary>An immutable source tree and the exact Git revision from which it was exported.</summary>
public sealed record GitSourceSnapshot(
    string SourceRoot,
    string Revision,
    string RequestedRef,
    bool IsManaged);

/// <summary>
/// Resolves a local checkout or maintains a bare mirror and exports only <c>src</c> into an
/// immutable SHA-keyed snapshot. User checkouts are never modified.
/// </summary>
public sealed partial class GitSourceSnapshotProvider(
    IOptions<ApiSurfaceOptions> options,
    ILogger<GitSourceSnapshotProvider> logger)
{
    private readonly ApiSurfaceOptions _options = options.Value;
    private readonly SemaphoreSlim _gate = new(1, 1);

    public async Task<GitSourceSnapshot> GetAsync(CancellationToken cancellationToken = default)
    {
        if (!string.IsNullOrWhiteSpace(_options.LocalSrcPath))
        {
            return await ResolveLocalAsync(_options.LocalSrcPath!, cancellationToken);
        }

        if (!_options.Enabled)
        {
            throw new InvalidOperationException("API-surface ingestion is disabled.");
        }

        await _gate.WaitAsync(cancellationToken);
        try
        {
            return await GetManagedAsync(cancellationToken);
        }
        finally
        {
            _gate.Release();
        }
    }

    private async Task<GitSourceSnapshot> ResolveLocalAsync(
        string configuredPath,
        CancellationToken cancellationToken)
    {
        var path = Path.GetFullPath(Environment.ExpandEnvironmentVariables(configuredPath));
        var sourceRoot = Directory.Exists(Path.Combine(path, "src"))
            ? Path.Combine(path, "src")
            : path;
        if (!Directory.Exists(sourceRoot))
        {
            throw new DirectoryNotFoundException($"API source path '{sourceRoot}' does not exist.");
        }

        var result = await ProcessRunner.RunAsync(
            _options.GitExecutable,
            ["-C", sourceRoot, "rev-parse", "HEAD"],
            CommandTimeout,
            cancellationToken);
        var revision = result.ExitCode == 0 && IsCommit(result.StandardOutput.Trim())
            ? result.StandardOutput.Trim()
            : _options.CitationBranch;

        if (!IsCommit(revision))
        {
            logger.LogWarning(
                "Local API source path is not a Git checkout; citations use mutable ref '{Ref}'.",
                revision);
        }

        return new GitSourceSnapshot(sourceRoot, revision, _options.SourceRef, IsManaged: false);
    }

    private async Task<GitSourceSnapshot> GetManagedAsync(CancellationToken cancellationToken)
    {
        var cacheRoot = string.IsNullOrWhiteSpace(_options.CachePath)
            ? Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "AspireDiscordBot",
                "git")
            : Path.GetFullPath(Environment.ExpandEnvironmentVariables(_options.CachePath));
        var slug = _options.CitationRepo.Replace('/', '-');
        var repositoryRoot = Path.Combine(cacheRoot, slug);
        var mirrorPath = Path.Combine(repositoryRoot, "repository.git");
        var snapshotsRoot = Path.Combine(repositoryRoot, "snapshots");
        Directory.CreateDirectory(repositoryRoot);
        Directory.CreateDirectory(snapshotsRoot);

        if (!Directory.Exists(mirrorPath))
        {
            var stagingMirror = mirrorPath + $".tmp-{Guid.NewGuid():N}";
            try
            {
                await RunRequiredAsync(
                    ["clone", "--mirror", "--filter=blob:none", "--no-tags", _options.RepositoryUrl, stagingMirror],
                    cancellationToken);
                Directory.Move(stagingMirror, mirrorPath);
            }
            finally
            {
                TryDeleteDirectory(stagingMirror);
            }
        }

        await RunRequiredAsync(
            [
                "--git-dir", mirrorPath,
                "fetch", "--force", "--prune", "--no-tags", "--filter=blob:none",
                "origin", _options.SourceRef,
            ],
            cancellationToken);
        var revisionResult = await RunRequiredAsync(
            ["--git-dir", mirrorPath, "rev-parse", "FETCH_HEAD"],
            cancellationToken);
        var revision = revisionResult.StandardOutput.Trim();
        if (!IsCommit(revision))
        {
            throw new InvalidOperationException(
                $"Git returned invalid revision '{revision}' for '{_options.SourceRef}'.");
        }

        var snapshotPath = Path.Combine(snapshotsRoot, revision);
        if (!Directory.Exists(snapshotPath))
        {
            var stagingPath = snapshotPath + $".tmp-{Guid.NewGuid():N}";
            var archivePath = Path.Combine(repositoryRoot, $"src-{revision}-{Guid.NewGuid():N}.tar");
            try
            {
                Directory.CreateDirectory(stagingPath);
                await RunRequiredAsync(
                    [
                        "--git-dir", mirrorPath,
                        "archive", "--format=tar", $"--output={archivePath}", revision, "src",
                    ],
                    cancellationToken);
                TarFile.ExtractToDirectory(archivePath, stagingPath, overwriteFiles: false);
                Directory.Move(stagingPath, snapshotPath);
            }
            finally
            {
                TryDeleteFile(archivePath);
                TryDeleteDirectory(stagingPath);
            }
        }

        PruneOldSnapshots(snapshotsRoot, snapshotPath);
        logger.LogInformation(
            "Using managed API source snapshot {Revision} for {Repo}@{Ref}.",
            revision,
            _options.CitationRepo,
            _options.SourceRef);
        return new GitSourceSnapshot(
            Path.Combine(snapshotPath, "src"),
            revision,
            _options.SourceRef,
            IsManaged: true);
    }

    private async Task<ProcessResult> RunRequiredAsync(
        IReadOnlyList<string> arguments,
        CancellationToken cancellationToken)
    {
        var result = await ProcessRunner.RunAsync(
            _options.GitExecutable,
            arguments,
            CommandTimeout,
            cancellationToken);
        if (result.ExitCode != 0)
        {
            throw new InvalidOperationException(
                $"Git command failed ({result.ExitCode}): {result.StandardError.Trim()}");
        }

        return result;
    }

    private void PruneOldSnapshots(string snapshotsRoot, string current)
    {
        var retention = Math.Max(1, _options.SnapshotRetention);
        foreach (var directory in Directory.EnumerateDirectories(snapshotsRoot)
                     .Where(path => !path.Contains(".tmp-", StringComparison.Ordinal))
                     .OrderByDescending(Directory.GetLastWriteTimeUtc)
                     .Skip(retention))
        {
            if (string.Equals(directory, current, StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            try
            {
                Directory.Delete(directory, recursive: true);
            }
            catch (Exception ex)
            {
                logger.LogDebug(ex, "Unable to prune old API source snapshot {Path}.", directory);
            }
        }
    }

    private void TryDeleteFile(string path)
    {
        try
        {
            if (File.Exists(path))
            {
                File.SetAttributes(path, FileAttributes.Normal);
                File.Delete(path);
            }
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Unable to remove temporary Git archive {Path}.", path);
        }
    }

    private void TryDeleteDirectory(string path)
    {
        if (!Directory.Exists(path))
        {
            return;
        }

        Exception? lastError = null;
        for (var attempt = 1; attempt <= 3; attempt++)
        {
            try
            {
                foreach (var entry in Directory.EnumerateFileSystemEntries(
                             path,
                             "*",
                             SearchOption.AllDirectories))
                {
                    File.SetAttributes(entry, FileAttributes.Normal);
                }

                Directory.Delete(path, recursive: true);
                return;
            }
            catch (Exception ex)
            {
                lastError = ex;
                if (attempt < 3)
                {
                    Thread.Sleep(TimeSpan.FromMilliseconds(100 * attempt));
                }
            }
        }

        logger.LogWarning(lastError, "Unable to remove temporary Git directory {Path}.", path);
    }

    private TimeSpan CommandTimeout =>
        TimeSpan.FromSeconds(Math.Max(30, _options.GitCommandTimeoutSeconds));

    private static bool IsCommit(string value) => CommitRegex().IsMatch(value);

    [GeneratedRegex("^[0-9a-fA-F]{40}([0-9a-fA-F]{24})?$")]
    private static partial Regex CommitRegex();
}
