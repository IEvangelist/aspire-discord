using Aspire.Hosting.ApplicationModel;

namespace AspireDiscordBot.AppHost;

/// <summary>
/// The resolved AI settings applied to the services as <c>Ai__*</c> environment variables.
/// Built once in the AppHost and shared by the ingestion worker and the bot. When
/// <see cref="OllamaEndpoint"/> is set, the endpoint is wired from the orchestrated Ollama
/// container and no API key is sent; otherwise the configured endpoint/key are used.
/// </summary>
internal sealed record AiConfiguration
{
    public required string Provider { get; init; }

    public required string ChatModel { get; init; }

    public required string EmbeddingModel { get; init; }

    public required string EmbeddingDimensions { get; init; }

    /// <summary>Endpoint used when not running against an orchestrated Ollama container.</summary>
    public string? Endpoint { get; init; }

    /// <summary>API key used when not running against an orchestrated Ollama container.</summary>
    public string? ApiKey { get; init; }

    /// <summary>When set, AI is served by this orchestrated Ollama container endpoint.</summary>
    public EndpointReference? OllamaEndpoint { get; init; }

    /// <summary>
    /// For the copilot provider: whether the service should run the interactive device-flow
    /// sign-in itself. Set false when the AppHost drives the sign-in via the dashboard.
    /// </summary>
    public bool? CopilotInteractiveSignIn { get; init; }
}

/// <summary>AppHost helper extensions for wiring shared configuration onto resources.</summary>
internal static class AppHostExtensions
{
    /// <summary>Applies the shared AI environment (<c>Ai__*</c>) to a service resource.</summary>
    public static IResourceBuilder<T> WithAiEnvironment<T>(this IResourceBuilder<T> builder, AiConfiguration ai)
        where T : IResourceWithEnvironment
    {
        builder
            .WithEnvironment("Ai__Provider", ai.Provider)
            .WithEnvironment("Ai__ChatModel", ai.ChatModel)
            .WithEnvironment("Ai__EmbeddingModel", ai.EmbeddingModel)
            .WithEnvironment("Ai__EmbeddingDimensions", ai.EmbeddingDimensions);

        if (ai.OllamaEndpoint is not null)
        {
            builder.WithEnvironment("Ai__Endpoint", ai.OllamaEndpoint);
        }
        else
        {
            builder
                .WithEnvironment("Ai__Endpoint", ai.Endpoint)
                .WithEnvironment("Ai__ApiKey", ai.ApiKey);
        }

        if (ai.CopilotInteractiveSignIn is { } interactive)
        {
            builder.WithEnvironment("Ai__Copilot__InteractiveSignIn", interactive ? "true" : "false");
        }

        return builder;
    }
}
