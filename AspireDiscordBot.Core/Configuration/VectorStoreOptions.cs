namespace AspireDiscordBot.Core.Configuration;

/// <summary>Selects the vector index implementation used by ingestion.</summary>
public sealed class VectorStoreOptions
{
    public const string SectionName = "VectorStore";

    /// <summary>One of <c>qdrant</c> or <c>azuresearch</c>.</summary>
    public string Provider { get; set; } = "qdrant";

    /// <summary>Azure AI Search service endpoint when <see cref="Provider"/> is <c>azuresearch</c>.</summary>
    public string? Endpoint { get; set; }

    /// <summary>Number of physical index generations retained per logical index.</summary>
    public int GenerationRetention { get; set; } = 2;
}
