namespace AspireDiscordBot.Core.Configuration;

/// <summary>
/// Optional ingestion of the microsoft/aspire public API surface (types + XML docs) parsed from a
/// local source clone. Stored in a separate Qdrant collection and exposed to the agent via the
/// <c>search_api</c> tool, so questions about real APIs (types, method signatures) can be answered
/// from the code itself, not just prose docs.
/// </summary>
public sealed class ApiSurfaceOptions
{
    public const string SectionName = "ApiSurface";

    /// <summary>
    /// Path to a local clone of the microsoft/aspire <c>src</c> directory. When null/empty, API
    /// surface ingestion is disabled and the <c>search_api</c> tool isn't offered.
    /// </summary>
    public string? LocalSrcPath { get; set; }

    /// <summary>Qdrant collection storing the embedded API surface chunks.</summary>
    public string CollectionName { get; set; } = "aspire_api";

    /// <summary>
    /// Directory-name prefixes (under <c>src</c>) to include. Defaults to the hosting + core surface
    /// most questions target. Empty means include everything under <c>src</c>.
    /// </summary>
    public List<string> IncludeProjectPrefixes { get; set; } = ["Aspire.Hosting"];

    /// <summary>Canonical repo used for citation links (not the local clone's fork remote).</summary>
    public string CitationRepo { get; set; } = "microsoft/aspire";

    /// <summary>Branch used for citation links.</summary>
    public string CitationBranch { get; set; } = "main";
}
