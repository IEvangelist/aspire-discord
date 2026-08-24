using AspireDiscordBot.Core.Configuration;
using AspireDiscordBot.Core.Ai;
using AspireDiscordBot.Core.Rag;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

namespace AspireDiscordBot.Copilot;

public static class CopilotServiceCollectionExtensions
{
    /// <summary>Replaces the default answer service with the official GitHub Copilot SDK path.</summary>
    public static IHostApplicationBuilder AddCopilotSdkAnswering(this IHostApplicationBuilder builder)
    {
        builder.Services.AddSingleton<CopilotRuntime>();
        builder.Services.AddSingleton<IHostedService>(services =>
            services.GetRequiredService<CopilotRuntime>());
        builder.Services.AddSingleton<CopilotSdkChatModel>();
        builder.Services.AddSingleton<IChatModel>(services =>
            services.GetRequiredService<CopilotSdkChatModel>());
        builder.Services.AddSingleton<CopilotSdkAnswerService>();
        var mode = builder.Configuration[$"{AgentOptions.SectionName}:Mode"] ?? "agentic";
        if (!string.Equals(mode, "single", StringComparison.OrdinalIgnoreCase))
        {
            builder.Services.AddSingleton<IAnswerService>(services =>
                services.GetRequiredService<CopilotSdkAnswerService>());
        }

        return builder;
    }

    public static bool UsesCopilotSdk(this IHostApplicationBuilder builder) =>
        string.Equals(
            builder.Configuration[$"{AiOptions.SectionName}:Provider"] ?? "copilot",
            "copilot",
            StringComparison.OrdinalIgnoreCase);
}
