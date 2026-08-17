using AspireDiscordBot.Core.Configuration;

namespace AspireDiscordBot.Core.Documents;

/// <summary>Reads raw documentation files from a configured set of repositories.</summary>
public interface IDocSourceReader
{
    /// <summary>The human-readable name of the active source mode (for logging).</summary>
    string ModeName { get; }

    /// <summary>Streams every included documentation file across all configured sources.</summary>
    IAsyncEnumerable<RawDocument> ReadAllAsync(
        IReadOnlyList<DocRepoOptions> sources,
        CancellationToken cancellationToken = default);
}
