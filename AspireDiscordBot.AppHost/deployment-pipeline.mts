import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type {
  CancellationToken,
  DistributedApplicationBuilder,
  PipelineStepContext,
  ReportingTask,
} from "./.aspire/modules/aspire.mjs";

const preflightStep = "production-preflight";
const deploymentStep = "production-blue-green";

export interface ProductionDeploymentOptions {
  readonly allowedUserIds: string;
  readonly appHostPath: string;
  readonly discordToken: string;
  readonly environmentName: string;
  readonly githubToken: string;
  readonly location: string;
  readonly repositoryRoot: string;
  readonly resourceGroup: string;
  readonly resourceSuffix: string;
  readonly skipBuild: boolean;
  readonly subscriptionId: string;
}

interface DeploymentResult {
  readonly Application: string;
  readonly BotUser?: string;
  readonly ImageTag: string;
  readonly ResourceGroup: string;
  readonly SearchEndpoint: string;
  readonly SubscriptionId: string;
  readonly Url: string;
}

interface DeploymentSecrets {
  readonly allowedUserIds: string;
  readonly discordToken: string;
  readonly githubToken: string;
}

interface RunOptions {
  readonly captureOutput?: boolean;
  readonly discardOutput?: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly onAbort?: () => Promise<void> | void;
  readonly signal?: AbortSignal;
  readonly terminateOnAbort?: boolean;
}

interface CommandInvocation {
  readonly args: readonly string[];
  readonly command: string;
}

export async function configureProductionDeployment(
  builder: DistributedApplicationBuilder,
  options: ProductionDeploymentOptions,
): Promise<void> {
  const pipeline = await builder.pipeline();
  let deploymentSecrets: DeploymentSecrets | undefined;
  await pipeline.addStep(preflightStep, async (context) => {
    await withPipelineCancellation(context, async (signal) => {
      deploymentSecrets = await resolveDeploymentSecrets(options, signal);
      await runPreflight(context, options, signal);
    });
  });
  await pipeline.addStep(
    deploymentStep,
    async (context) => {
      await withPipelineCancellation(context, async (signal) => {
        deploymentSecrets ??= await resolveDeploymentSecrets(options, signal);
        await runDeployment(context, options, deploymentSecrets, signal);
      });
    },
    {
      dependsOn: [preflightStep],
      requiredBy: ["deploy"],
    },
  );
}

export function buildDeploymentArguments(
  scriptPath: string,
  resultPath: string,
  cancellationPath: string,
  options: ProductionDeploymentOptions,
): readonly string[] {
  return [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-File",
    scriptPath,
    "-SubscriptionId",
    options.subscriptionId,
    "-ResourceGroup",
    options.resourceGroup,
    "-Location",
    options.location,
    "-ResourceSuffix",
    options.resourceSuffix,
    "-ResultPath",
    resultPath,
    "-CancellationPath",
    cancellationPath,
    ...(options.skipBuild ? ["-SkipBuild"] : []),
  ];
}

export function validateDeploymentOptions(
  options: ProductionDeploymentOptions,
): void {
  if (options.environmentName.toLocaleLowerCase("en-US") !== "production") {
    throw new Error(
      `The Aspire Discord deployment pipeline only targets Production, not '${options.environmentName}'.`,
    );
  }
  if (!options.appHostPath.trim()) {
    throw new Error("The production AppHost path is required.");
  }
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
      options.subscriptionId,
    )
  ) {
    throw new Error("Azure:SubscriptionId must be a valid subscription ID.");
  }
  if (!/^[\w().-]{1,90}$/u.test(options.resourceGroup)) {
    throw new Error("Azure:ResourceGroup is invalid.");
  }
  if (!/^[a-z0-9]{6,10}$/u.test(options.resourceSuffix)) {
    throw new Error(
      "Parameters:DeploymentResourceSuffix must contain 6-10 lowercase letters or digits.",
    );
  }
}

async function resolveDeploymentSecrets(
  options: ProductionDeploymentOptions,
  signal: AbortSignal,
): Promise<DeploymentSecrets> {
  return {
    allowedUserIds: await resolveSecret(
      options.allowedUserIds,
      "Parameters:DiscordAllowedUserIds",
      false,
      options,
      signal,
    ),
    discordToken: await resolveSecret(
      options.discordToken,
      "Parameters:DiscordToken",
      true,
      options,
      signal,
    ),
    githubToken: await resolveSecret(
      options.githubToken,
      "Parameters:GitHubMcpToken",
      true,
      options,
      signal,
    ),
  };
}

async function resolveSecret(
  configuredValue: string,
  key: string,
  required: boolean,
  options: ProductionDeploymentOptions,
  signal: AbortSignal,
): Promise<string> {
  if (configuredValue.trim()) {
    return configuredValue;
  }
  try {
    const output = await runCommand(
      "aspire",
      [
        "secret",
        "get",
        key,
        "--apphost",
        options.appHostPath,
        "--non-interactive",
        "--nologo",
      ],
      options.repositoryRoot,
      {
        captureOutput: true,
        discardOutput: true,
        signal,
        terminateOnAbort: true,
      },
    );
    const value = output
      .split(/\r?\n/gu)
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1);
    if (value) {
      return value;
    }
  } catch (error) {
    if (signal.aborted) {
      throw error;
    }
    if (required) {
      throw new Error(
        `Aspire secret '${key}' is required for production deployment.`,
        {
          cause: error,
        },
      );
    }
    return "";
  }
  if (required) {
    throw new Error(
      `Aspire secret '${key}' is required for production deployment.`,
    );
  }
  return "";
}

async function withPipelineCancellation<T>(
  context: PipelineStepContext,
  action: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const remoteToken = await context.cancellationToken();
  const reportingStep = await context.reportingStep();
  const task = await reportingStep.createTask(
    "Monitoring deployment cancellation.",
    { cancellationToken: remoteToken },
  );
  const controller = new AbortController();
  let finished = false;
  const cancel = (cause?: unknown): void => {
    if (!controller.signal.aborted) {
      controller.abort(
        new Error("Aspire deployment was cancelled.", {
          ...(cause === undefined ? {} : { cause }),
        }),
      );
    }
  };
  const signals: readonly NodeJS.Signals[] =
    process.platform === "win32"
      ? ["SIGINT", "SIGTERM", "SIGBREAK"]
      : ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const signal of signals) {
    process.once(signal, cancel);
  }
  const monitor = monitorPipelineCancellation(
    task,
    remoteToken,
    controller,
    () => finished,
  );

  try {
    return await action(controller.signal);
  } finally {
    finished = true;
    for (const signal of signals) {
      process.off(signal, cancel);
    }
    await monitor;
    if (!controller.signal.aborted) {
      await task.completeTask({
        cancellationToken: remoteToken,
        completionMessage: "Deployment step completed.",
      });
    }
  }
}

async function monitorPipelineCancellation(
  task: ReportingTask,
  remoteToken: CancellationToken,
  controller: AbortController,
  isFinished: () => boolean,
): Promise<void> {
  while (!isFinished() && !controller.signal.aborted) {
    await delay(1_000);
    if (isFinished()) {
      return;
    }
    try {
      await task.updateTask("Deployment in progress.", {
        cancellationToken: remoteToken,
      });
    } catch (error) {
      controller.abort(
        new Error("Aspire deployment was cancelled.", { cause: error }),
      );
    }
  }
}

async function runPreflight(
  context: PipelineStepContext,
  options: ProductionDeploymentOptions,
  signal: AbortSignal,
): Promise<void> {
  validateDeploymentOptions(options);
  const logger = await context.logger();
  await logger.logInformation(
    "Validating immutable source, Azure access, and deployment templates.",
  );

  const status = await runCommand(
    "git",
    ["status", "--porcelain"],
    options.repositoryRoot,
    {
      captureOutput: true,
      signal,
      terminateOnAbort: true,
    },
  );
  if (status.trim()) {
    throw new Error(
      "Commit the deployment source before running aspire deploy so image tags remain immutable.",
    );
  }

  await runCommand(
    "git",
    ["rev-parse", "--verify", "HEAD"],
    options.repositoryRoot,
    {
      discardOutput: true,
      signal,
      terminateOnAbort: true,
    },
  );
  await runCommand("pwsh", ["--version"], options.repositoryRoot, {
    discardOutput: true,
    signal,
    terminateOnAbort: true,
  });
  if (!options.skipBuild) {
    await runCommand("tar", ["--version"], options.repositoryRoot, {
      discardOutput: true,
      signal,
      terminateOnAbort: true,
    });
  }
  const azureCli = await resolveAzureCliInvocation(
    options.repositoryRoot,
    signal,
  );
  await runCommand(
    azureCli.command,
    [
      ...azureCli.args,
      "account",
      "show",
      "--subscription",
      options.subscriptionId,
      "--output",
      "none",
    ],
    options.repositoryRoot,
    { discardOutput: true, signal, terminateOnAbort: true },
  );
  for (const template of ["infra/main.bicep", "infra/app.bicep"]) {
    await runCommand(
      azureCli.command,
      [
        ...azureCli.args,
        "bicep",
        "build",
        "--file",
        resolve(options.repositoryRoot, template),
        "--stdout",
      ],
      options.repositoryRoot,
      { discardOutput: true, signal, terminateOnAbort: true },
    );
  }
}

export async function resolveAzureCliInvocation(
  cwd: string,
  signal?: AbortSignal,
): Promise<CommandInvocation> {
  if (process.platform !== "win32") {
    return { args: [], command: "az" };
  }
  const output = await runCommand("where.exe", ["az.cmd"], cwd, {
    captureOutput: true,
    discardOutput: true,
    ...(signal ? { signal } : {}),
    terminateOnAbort: true,
  });
  const commandShim = output
    .split(/\r?\n/gu)
    .map((line) => line.trim())
    .find(Boolean);
  if (!commandShim) {
    throw new Error("Azure CLI was not found on PATH.");
  }
  const python = resolve(dirname(commandShim), "..", "python.exe");
  await access(python);
  return { args: ["-IBm", "azure.cli"], command: python };
}

async function runDeployment(
  context: PipelineStepContext,
  options: ProductionDeploymentOptions,
  secrets: DeploymentSecrets,
  signal: AbortSignal,
): Promise<void> {
  validateDeploymentOptions(options);
  const logger = await context.logger();
  await logger.logInformation(
    "Starting the lease-protected Aspire Discord blue/green deployment.",
  );

  const workingDirectory = await mkdtemp(
    join(tmpdir(), "aspire-discord-deploy-"),
  );
  const resultPath = join(workingDirectory, "result.json");
  const cancellationPath = join(workingDirectory, "cancel");
  try {
    const scriptPath = resolve(
      options.repositoryRoot,
      "infra",
      "deploy-production.ps1",
    );
    await runCommand(
      "pwsh",
      [
        ...buildDeploymentArguments(
          scriptPath,
          resultPath,
          cancellationPath,
          options,
        ),
      ],
      options.repositoryRoot,
      {
        env: deploymentEnvironment(secrets),
        onAbort: () => {
          writeFileSync(cancellationPath, "", { flag: "a" });
        },
        signal,
      },
    );
    const result = parseDeploymentResult(await readFile(resultPath, "utf8"));
    const summary = await context.summary();
    await summary.add("Application", result.Application);
    await summary.add("Image", result.ImageTag);
    await summary.add("Resource group", result.ResourceGroup);
    await summary.add("URL", result.Url);
    if (result.BotUser) {
      await summary.add("Discord bot", result.BotUser);
    }
  } finally {
    await rm(workingDirectory, { force: true, recursive: true });
  }
}

function deploymentEnvironment(secrets: DeploymentSecrets): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ASPIRE_DEPLOYMENT_PIPELINE: "1",
    DISCORD_ALLOWED_USER_IDS: secrets.allowedUserIds,
    DISCORD_TOKEN: secrets.discordToken,
    GITHUB_MCP_TOKEN: secrets.githubToken,
  };
}

export function parseDeploymentResult(value: string): DeploymentResult {
  const parsed = JSON.parse(
    value.replace(/^\uFEFF/u, ""),
  ) as Partial<DeploymentResult>;
  if (
    !parsed.Application ||
    !parsed.ImageTag ||
    !parsed.ResourceGroup ||
    !parsed.SearchEndpoint ||
    !parsed.SubscriptionId ||
    !parsed.Url
  ) {
    throw new Error(
      "The production deployment did not return a complete result.",
    );
  }
  return parsed as DeploymentResult;
}

export async function runCommand(
  command: string,
  args: readonly string[],
  cwd: string,
  options: RunOptions = {},
): Promise<string> {
  options.signal?.throwIfAborted();
  return await new Promise<string>((resolvePromise, reject) => {
    const child = spawn(command, [...args], {
      cwd,
      env: options.env ?? process.env,
      shell: false,
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let abortReason: Error | undefined;
    let settled = false;
    const settle = (action: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (options.signal) {
        options.signal.removeEventListener("abort", onAbort);
      }
      action();
    };
    const onAbort = (): void => {
      abortReason =
        options.signal?.reason instanceof Error
          ? options.signal.reason
          : new Error("Aspire deployment was cancelled.");
      if (options.terminateOnAbort) {
        child.kill();
      }
      void Promise.resolve(options.onAbort?.()).catch((error: unknown) => {
        abortReason = new AggregateError(
          [abortReason, error].filter((value) => value !== undefined),
          "Aspire deployment cancellation failed.",
        );
      });
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) {
      onAbort();
    }

    child.stdout.on("data", (chunk: Buffer) => {
      if (options.captureOutput) {
        stdout.push(chunk);
      } else if (!options.discardOutput) {
        process.stdout.write(chunk);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
      if (!options.discardOutput) {
        process.stderr.write(chunk);
      }
    });
    child.once("error", (error) => {
      settle(() => {
        reject(error);
      });
    });
    child.once("close", (code, signal) => {
      const cancellationError = abortReason;
      if (cancellationError) {
        settle(() => {
          reject(cancellationError);
        });
        return;
      }
      if (code === 0) {
        settle(() => {
          resolvePromise(Buffer.concat(stdout).toString("utf8"));
        });
        return;
      }
      const detail = Buffer.concat(stderr).toString("utf8").trim();
      settle(() => {
        reject(
          new Error(
            `${command} exited with ${code === null ? `signal ${signal ?? "unknown"}` : `code ${String(code)}`}${detail ? `: ${detail}` : ""}`,
          ),
        );
      });
    });
  });
}
