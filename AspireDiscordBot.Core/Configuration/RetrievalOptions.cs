namespace AspireDiscordBot.Core.Configuration;

/// <summary>Controls retrieval and the grounding guardrails.</summary>
public sealed class RetrievalOptions
{
    public const string SectionName = "Retrieval";

    /// <summary>Number of chunks to retrieve for each question.</summary>
    public int TopK { get; set; } = 6;

    /// <summary>
    /// Minimum cosine similarity for a chunk to be considered relevant.
    /// If the best match is below this, the bot answers "not covered in the Aspire docs".
    /// </summary>
    public float MinScore { get; set; } = 0.35f;

    /// <summary>Maximum characters of retrieved context passed to the model.</summary>
    public int MaxContextChars { get; set; } = 8000;
}
