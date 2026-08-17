using System.Runtime.CompilerServices;
using AspireDiscordBot.Core.Configuration;
using Microsoft.Extensions.Logging;

namespace AspireDiscordBot.Core.Documents;

/// <summary>Reads documentation files from local repository clones on disk.</summary>
public sealed class LocalDocSourceReader(ILogger<LocalDocSourceReader> logger) : IDocSourceReader
{
    public string ModeName => "local";

    public async IAsyncEnumerable<RawDocument> ReadAllAsync(
        IReadOnlyList<DocRepoOptions> sources,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        foreach (var repo in sources)
        {
            if (string.IsNullOrWhiteSpace(repo.LocalPath) || !Directory.Exists(repo.LocalPath))
            {
                logger.LogWarning(
                    "Local path for {Repo} is missing or not set ('{LocalPath}'); skipping.",
                    repo.Repo, repo.LocalPath);
                continue;
            }

            var root = Path.GetFullPath(repo.LocalPath);

            foreach (var prefix in repo.IncludePrefixes)
            {
                var searchRoot = Path.GetFullPath(Path.Combine(root, prefix.Replace('/', Path.DirectorySeparatorChar)));
                if (!Directory.Exists(searchRoot))
                {
                    logger.LogWarning("Include path {SearchRoot} not found for {Repo}; skipping.", searchRoot, repo.Repo);
                    continue;
                }

                foreach (var file in Directory.EnumerateFiles(searchRoot, "*", SearchOption.AllDirectories))
                {
                    cancellationToken.ThrowIfCancellationRequested();

                    var relative = Path.GetRelativePath(root, file).Replace('\\', '/');
                    if (!DocSourceCatalog.ShouldInclude(repo, relative))
                    {
                        continue;
                    }

                    string raw;
                    try
                    {
                        raw = await File.ReadAllTextAsync(file, cancellationToken);
                    }
                    catch (IOException ex)
                    {
                        logger.LogWarning(ex, "Failed to read {File}; skipping.", file);
                        continue;
                    }

                    yield return new RawDocument(repo.Repo, relative, raw, repo.UrlStyle, repo.Branch);
                }
            }
        }
    }
}
