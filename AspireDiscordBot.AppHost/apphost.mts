import { createBuilder } from "./.aspire/modules/aspire.mjs";
import { resolve } from "node:path";
import { configureProductionDeployment } from "./deployment-pipeline.mjs";

const builder = await createBuilder();
const configuration = builder.getConfiguration();
const isPublishMode = await builder.executionContext().isPublishMode();
const environment = await builder.environment();
const environmentName = await environment.environmentName.get();

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

const useLocalAi = await configBool("Ollama:Enabled", false);
const deploymentResourceSuffix = await config(
  "Parameters:DeploymentResourceSuffix",
  "ffccd7",
);
const productionFoundryEndpoint = `https://aspire-discord-ai-${deploymentResourceSuffix}.openai.azure.com`;
const configuredChatProvider = await config("Parameters:AiProvider", "copilot");
const chatProvider = useLocalAi ? "ollama" : configuredChatProvider;
const configuredEmbeddingProvider = await config(
  "Parameters:AiEmbeddingProvider",
  "azureaifoundry",
);
const embeddingProvider = useLocalAi ? "ollama" : configuredEmbeddingProvider;
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
const imageContextEnabled = await configBool(
  "Parameters:ImageContextEnabled",
  chatModel === "gpt-5.6-sol",
);
const embeddingModel =
  (await config("Parameters:AiEmbeddingModel")) ||
  (embeddingProvider === "ollama"
    ? ollamaEmbeddingModel
    : "text-embedding-3-small");
const embeddingDimensions =
  (await config("Parameters:AiEmbeddingDimensions")) ||
  (embeddingProvider === "ollama" ? ollamaEmbeddingDimensions : "1536");
const providersMatch = chatProvider === embeddingProvider;
const configuredAiEndpoint = await config(
  "Parameters:AiEndpoint",
  isPublishMode ? productionFoundryEndpoint : "",
);
const configuredEmbeddingEndpoint = (
  (await config("Parameters:AiEmbeddingEndpoint")) ||
  (providersMatch ? configuredAiEndpoint : "") ||
  (isPublishMode ? productionFoundryEndpoint : "")
).trim();
if (embeddingProvider !== "ollama" && !configuredEmbeddingEndpoint) {
  throw new Error(
    `Parameters:AiEmbeddingEndpoint is required for ${embeddingProvider} embeddings. ` +
      "Set it to the Microsoft Foundry resource endpoint, or enable Ollama for local AI.",
  );
}
if (embeddingProvider === "azureaifoundry") {
  let endpoint: URL;
  try {
    endpoint = new URL(configuredEmbeddingEndpoint);
  } catch {
    throw new Error(
      "Parameters:AiEmbeddingEndpoint must be a valid Microsoft Foundry HTTPS endpoint.",
    );
  }
  if (endpoint.protocol !== "https:") {
    throw new Error(
      "Parameters:AiEmbeddingEndpoint must use HTTPS for Microsoft Foundry.",
    );
  }
}
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
  if (effectiveEmbeddingApiKey && embeddingProvider !== "azureaifoundry") {
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
await bot.withEnvironment(
  "SAFETY_MAX_QUESTION_LENGTH",
  await config("Parameters:SafetyMaxQuestionLength", "2000"),
);
await bot.withEnvironment("IMAGE_CONTEXT_ENABLED", String(imageContextEnabled));
await bot.withEnvironment(
  "IMAGE_CONTEXT_MAX_IMAGES",
  await config("Parameters:ImageContextMaxImages", "1"),
);
await bot.withEnvironment(
  "IMAGE_CONTEXT_MAX_BYTES",
  await config("Parameters:ImageContextMaxBytes", "3145728"),
);
await bot.withEnvironment(
  "IMAGE_CONTEXT_MAX_PIXELS",
  await config("Parameters:ImageContextMaxPixels", "16000000"),
);
await bot.withEnvironment(
  "LINK_CONTEXT_ALLOWED_HOSTS",
  await config(
    "Parameters:LinkContextAllowedHosts",
    "aspire.dev,learn.microsoft.com,devblogs.microsoft.com,dotnet.microsoft.com,azure.microsoft.com",
  ),
);
await bot.withEnvironment(
  "LINK_CONTEXT_MAX_URLS",
  await config("Parameters:LinkContextMaxUrls", "3"),
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
  if (effectiveEmbeddingApiKey && embeddingProvider !== "azureaifoundry") {
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

if (isPublishMode) {
  await configureProductionDeployment(builder, {
    allowedUserIds:
      process.env.DISCORD_ALLOWED_USER_IDS ??
      (await config("Parameters:DiscordAllowedUserIds")),
    discordToken:
      process.env.DISCORD_TOKEN ?? (await config("Parameters:DiscordToken")),
    environmentName,
    githubToken:
      process.env.GITHUB_MCP_TOKEN ??
      (await config("Parameters:GitHubMcpToken")),
    location: await config("Azure:Location", "centralus"),
    repositoryRoot: resolve(import.meta.dirname, ".."),
    resourceGroup: await config("Azure:ResourceGroup", "aspire-discord-prod"),
    resourceSuffix: deploymentResourceSuffix,
    skipBuild: await configBool("Parameters:DeploymentSkipBuild", false),
    subscriptionId: await config(
      "Azure:SubscriptionId",
      "11aa9ca6-306a-4ea9-b614-2d413efd04a8",
    ),
  });
}

await builder.build().run();
