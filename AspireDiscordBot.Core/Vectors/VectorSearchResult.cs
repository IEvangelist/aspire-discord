namespace AspireDiscordBot.Core.Vectors;

/// <summary>A single retrieved chunk with its similarity score and citation metadata.</summary>
public sealed record VectorSearchResult(
    float Score,
    string Content,
    string Title,
    string Url,
    string Repo,
    string Path,
    string? Heading);
