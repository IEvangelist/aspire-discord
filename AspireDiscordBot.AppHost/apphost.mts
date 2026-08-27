import { createBuilder } from "./.aspire/modules/aspire.mjs";

const builder = await createBuilder();
const configuration = builder.getConfiguration();

const config = async (key: string, fallback = ""): Promise<string> =>
  (await configuration.getConfigValue(key)) || fallback;
const configBool = async (key: string, fallback: boolean): Promise<boolean> => {
  const value = await config(key);
  return value === "" ? fallback : value.toLowerCase() === "true";
};
const optionalSecret = async (name: string) =>
  (await configuration.exists(`Parameters:${name}`))
    ? builder.addParameterFromConfiguration(name, `Parameters:${name}`, {
        secret: true,
      })
    : undefined;

const discordToken = builder.addParameter("DiscordToken", { secret: true });
const copilotToken = await optionalSecret("CopilotGitHubToken");
const githubMcpToken = await optionalSecret("GitHubMcpToken");
const aiApiKey = await optionalSecret("AiApiKey");
const embeddingApiKey = await optionalSecret("AiEmbeddingApiKey");

const useOllamaForChat = await configBool("Ollama:Enabled", false);
const configuredChatProvider = await config("Parameters:AiProvider", "copilot");
const chatProvider = useOllamaForChat ? "ollama" : configuredChatProvider;
const configuredEmbeddingProvider = await config(
  "Parameters:AiEmbeddingProvider",
);
const embeddingProvider = useOllamaForChat
  ? "ollama"
  : configuredEmbeddingProvider ||
    (chatProvider === "copilot" ? "ollama" : chatProvider);
const ollamaChatModel = await config("Ollama:ChatModel", "llama3.1");
const ollamaEmbeddingModel = await config(
  "Ollama:EmbeddingModel",
  "nomic-embed-text",
);
const ollamaEmbeddingDimensions = await config(
  "Ollama:EmbeddingDimensions",
  "768",
);
const needsOllama = chatProvider === "ollama" || embeddingProvider === "ollama";

const qdrant = builder.addQdrant("qdrant");
await qdrant.withDataVolume({ name: "aspire-discord-qdrant" });
await qdrant.withPersistentLifetime();

let ollama: Awaited<ReturnType<typeof builder.addContainer>> | undefined;
if (needsOllama) {
  ollama = await builder.addContainer("ollama", {
    image: "ollama/ollama",
    tag: "latest",
  });
  await ollama.withHttpEndpoint({ targetPort: 11434, name: "http" });
  await ollama.withVolume("/root/.ollama", { name: "aspire-discord-ollama" });
  await ollama.withPersistentLifetime();
}

const chatModel =
  chatProvider === "ollama"
    ? ollamaChatModel
    : await config("Parameters:AiChatModel", "gpt-5.6-sol");
const embeddingModel =
  (await config("Parameters:AiEmbeddingModel")) ||
  (embeddingProvider === "ollama"
    ? ollamaEmbeddingModel
    : "text-embedding-3-small");
const embeddingDimensions =
  (await config("Parameters:AiEmbeddingDimensions")) ||
  (embeddingProvider === "ollama" ? ollamaEmbeddingDimensions : "1536");
const providersMatch = chatProvider === embeddingProvider;
const configuredAiEndpoint = await config("Parameters:AiEndpoint");
const configuredEmbeddingEndpoint =
  (await config("Parameters:AiEmbeddingEndpoint")) ||
  (providersMatch ? configuredAiEndpoint : "");
const endpointsMatch =
  providersMatch &&
  configuredAiEndpoint.replace(/\/+$/u, "") ===
    configuredEmbeddingEndpoint.replace(/\/+$/u, "");
const effectiveEmbeddingApiKey =
  embeddingApiKey ??
  (endpointsMatch && embeddingProvider !== "ollama" ? aiApiKey : undefined);

const ingestion = builder.addProject(
  "ingestion",
  "../AspireDiscordBot.Ingestion/AspireDiscordBot.Ingestion.csproj",
);
await ingestion.withHttpEndpoint({ name: "http" });
await ingestion.withHttpHealthCheck({ path: "/ready", endpointName: "http" });
await ingestion.withReference(qdrant);
await ingestion.waitFor(qdrant);
await ingestion.withEnvironment("Ai__Provider", chatProvider);
await ingestion.withEnvironment("Ai__ChatModel", chatModel);
await ingestion.withEnvironment("Ai__EmbeddingProvider", embeddingProvider);
await ingestion.withEnvironment("Ai__EmbeddingModel", embeddingModel);
await ingestion.withEnvironment("Ai__EmbeddingDimensions", embeddingDimensions);
await ingestion.withEnvironment(
  "Ai__EmbeddingApiVersion",
  await config("Parameters:AiEmbeddingApiVersion", "2024-10-21"),
);

if (embeddingProvider === "ollama" && ollama) {
  await ingestion.withEnvironment(
    "Ai__EmbeddingEndpoint",
    ollama.getEndpoint("http"),
  );
  await ingestion.waitFor(ollama);
} else {
  await ingestion.withEnvironment(
    "Ai__EmbeddingEndpoint",
    configuredEmbeddingEndpoint,
  );
  if (effectiveEmbeddingApiKey) {
    await ingestion.withEnvironment(
      "Ai__EmbeddingApiKey",
      effectiveEmbeddingApiKey,
    );
  }
}

await ingestion.withHttpCommand("/admin/reingest", "Refresh index", {
  endpointName: "http",
  methodName: "POST",
  description:
    "Build and atomically publish fresh documentation and API index generations.",
  iconName: "ArrowSync",
});
await ingestion.withHttpCommand("/admin/rebuild", "Force rebuild index", {
  endpointName: "http",
  methodName: "POST",
  description:
    "Resolve fresh source snapshots and atomically replace all index generations.",
  confirmationMessage: "This re-embeds every page and API entry. Continue?",
  iconName: "DatabaseArrowUp",
});
await ingestion.withUrl("/scalar", { displayText: "API Reference (Scalar)" });

const bot = builder.addJavaScriptApp("bot", "../AspireDiscordBot.Bot", {
  runScriptName: "dev",
});
await bot.withNpm();
await bot.withHttpEndpoint({ name: "http", env: "PORT" });
await bot.withHttpHealthCheck({ path: "/ready", endpointName: "http" });
await bot.withReference(qdrant);
await bot.waitFor(qdrant);
await bot.waitFor(ingestion);
await bot.withEnvironment("NODE_ENV", "development");
await bot.withEnvironment("DISCORD_TOKEN", discordToken);
await bot.withEnvironment(
  "DISCORD_MENTION_ENABLED",
  await config("Parameters:DiscordMentionEnabled", "true"),
);
await bot.withEnvironment(
  "DISCORD_GUILD_ID",
  await config("Parameters:DiscordGuildId"),
);
await bot.withEnvironment(
  "DISCORD_ALLOWED_USER_IDS",
  await config("Parameters:DiscordAllowedUserIds"),
);
await bot.withEnvironment("AI_PROVIDER", chatProvider);
await bot.withEnvironment("AI_CHAT_MODEL", chatModel);
await bot.withEnvironment(
  "AI_ENDPOINT",
  chatProvider === "ollama" && ollama
    ? ollama.getEndpoint("http")
    : configuredAiEndpoint,
);
await bot.withEnvironment(
  "AI_REASONING_EFFORT",
  await config("Parameters:AiReasoningEffort", "low"),
);
await bot.withEnvironment("AI_EMBEDDING_PROVIDER", embeddingProvider);
await bot.withEnvironment("AI_EMBEDDING_MODEL", embeddingModel);
await bot.withEnvironment("AI_EMBEDDING_DIMENSIONS", embeddingDimensions);
await bot.withEnvironment(
  "AI_EMBEDDING_API_VERSION",
  await config("Parameters:AiEmbeddingApiVersion", "2024-10-21"),
);

if (aiApiKey) {
  await bot.withEnvironment("AI_API_KEY", aiApiKey);
}
if (embeddingProvider === "ollama" && ollama) {
  await bot.withEnvironment(
    "AI_EMBEDDING_ENDPOINT",
    ollama.getEndpoint("http"),
  );
  await bot.waitFor(ollama);
} else {
  await bot.withEnvironment(
    "AI_EMBEDDING_ENDPOINT",
    configuredEmbeddingEndpoint,
  );
  if (effectiveEmbeddingApiKey) {
    await bot.withEnvironment("AI_EMBEDDING_API_KEY", effectiveEmbeddingApiKey);
  }
}
if (copilotToken) {
  await bot.withEnvironment("COPILOT_GITHUB_TOKEN", copilotToken);
}
if (githubMcpToken) {
  await bot.withEnvironment("GITHUB_MCP_TOKEN", githubMcpToken);
}

await bot.withUrl("/scalar", { displayText: "API Reference (Scalar)" });
await bot.publishAsPackageScript({ scriptName: "start" });

await builder.build().run();
