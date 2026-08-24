using Aspire.Hosting.ApplicationModel;

namespace AspireDiscordBot.AppHost;

/// <summary>Resolved chat and embedding settings shared by the bot and ingestion worker.</summary>
internal sealed record AiConfiguration
{
    public required string Provider { get; init; }
    public required string ChatModel { get; init; }
    public string? Endpoint { get; init; }
    public string? ApiKey { get; init; }
    public EndpointReference? ChatEndpointReference { get; init; }

    public required string EmbeddingProvider { get; init; }
    public required string EmbeddingModel { get; init; }
    public required string EmbeddingDimensions { get; init; }
    public string? EmbeddingEndpoint { get; init; }
    public string? EmbeddingApiKey { get; init; }
    public string? EmbeddingApiVersion { get; init; }
    public EndpointReference? EmbeddingEndpointReference { get; init; }

    public string? CopilotGitHubToken { get; init; }
    public string? GitHubMcpToken { get; init; }
}

internal static class AppHostExtensions
{
    public static IResourceBuilder<T> WithAiEnvironment<T>(
        this IResourceBuilder<T> builder,
        AiConfiguration ai)
        where T : IResourceWithEnvironment
    {
        builder
            .WithEnvironment("Ai__Provider", ai.Provider)
            .WithEnvironment("Ai__ChatModel", ai.ChatModel)
            .WithEnvironment("Ai__EmbeddingProvider", ai.EmbeddingProvider)
            .WithEnvironment("Ai__EmbeddingModel", ai.EmbeddingModel)
            .WithEnvironment("Ai__EmbeddingDimensions", ai.EmbeddingDimensions);

        if (ai.ChatEndpointReference is not null)
        {
            builder.WithEnvironment("Ai__Endpoint", ai.ChatEndpointReference);
        }
        else if (!string.IsNullOrWhiteSpace(ai.Endpoint))
        {
            builder.WithEnvironment("Ai__Endpoint", ai.Endpoint);
        }

        if (!string.IsNullOrWhiteSpace(ai.ApiKey))
        {
            builder.WithEnvironment("Ai__ApiKey", ai.ApiKey);
        }

        if (ai.EmbeddingEndpointReference is not null)
        {
            builder.WithEnvironment("Ai__EmbeddingEndpoint", ai.EmbeddingEndpointReference);
        }
        else if (!string.IsNullOrWhiteSpace(ai.EmbeddingEndpoint))
        {
            builder.WithEnvironment("Ai__EmbeddingEndpoint", ai.EmbeddingEndpoint);
        }

        if (!string.IsNullOrWhiteSpace(ai.EmbeddingApiKey))
        {
            builder.WithEnvironment("Ai__EmbeddingApiKey", ai.EmbeddingApiKey);
        }

        if (!string.IsNullOrWhiteSpace(ai.EmbeddingApiVersion))
        {
            builder.WithEnvironment("Ai__EmbeddingApiVersion", ai.EmbeddingApiVersion);
        }

        if (!string.IsNullOrWhiteSpace(ai.CopilotGitHubToken))
        {
            builder.WithEnvironment("COPILOT_GITHUB_TOKEN", ai.CopilotGitHubToken);
        }

        if (!string.IsNullOrWhiteSpace(ai.GitHubMcpToken))
        {
            builder.WithEnvironment("GITHUB_MCP_TOKEN", ai.GitHubMcpToken);
        }

        return builder;
    }
}
