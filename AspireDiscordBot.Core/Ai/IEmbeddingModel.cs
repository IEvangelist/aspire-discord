namespace AspireDiscordBot.Core.Ai;

/// <summary>Generates embedding vectors from an OpenAI-compatible provider.</summary>
public interface IEmbeddingModel
{
    /// <summary>Embeds a batch of inputs, returning one vector per input in order.</summary>
    Task<IReadOnlyList<float[]>> EmbedAsync(IReadOnlyList<string> inputs, CancellationToken cancellationToken = default);

    /// <summary>Convenience overload for a single input.</summary>
    async Task<float[]> EmbedAsync(string input, CancellationToken cancellationToken = default)
        => (await EmbedAsync([input], cancellationToken))[0];
}
