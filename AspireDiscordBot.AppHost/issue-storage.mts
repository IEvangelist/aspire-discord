import { resolve } from "node:path";
import type {
  DistributedApplicationBuilder,
  PipelineStep,
} from "./.aspire/modules/aspire.mjs";
import {
  rejectSharedResourceGroupDestroy,
  resolveAzureCliInvocation,
  runCommand,
  withPipelineCancellation,
} from "./deployment-pipeline.mjs";

export const issueStorageTarget = {
  subscriptionId: "11aa9ca6-306a-4ea9-b614-2d413efd04a8",
  resourceGroup: "aspire-discord-prod",
  location: "centralus",
  storageAccountName: "aspireissuesffccd7",
  managedIdentityName: "aspire-discord-production-id",
  managedIdentityPrincipalId: "16d6bfa3-79e5-4da5-b2d8-b76672588040",
} as const;

const existingOnlyStep = "issue-storage-existing-group";
const nativeProvisioningSteps = [
  "create-provisioning-context",
  "provision-issue-storage",
  "provision-azure-bicep-resources",
] as const;

async function removeStepReference(
  list: Awaited<ReturnType<PipelineStep["dependsOnSteps"]>>,
  name: string,
): Promise<void> {
  const values = await list.toArray();
  for (let index = values.length - 1; index >= 0; index--) {
    if (values[index] === name) await list.removeAt(index);
  }
}

export async function configureExistingOnlyStorageSteps(
  steps: readonly PipelineStep[],
): Promise<void> {
  const byName = new Map<string, PipelineStep>();
  for (const step of steps) byName.set(await step.name(), step);
  for (const name of [
    ...nativeProvisioningSteps,
    "deploy",
    existingOnlyStep,
    "block-native-storage-context",
  ]) {
    if (!byName.has(name))
      throw new Error(
        `Unexpected Azure storage pipeline: required step ${name} is missing.`,
      );
  }
  const deploy = byName.get("deploy");
  if (!deploy) throw new Error("The storage deploy step is missing.");
  const dependencies = await deploy.dependsOnSteps();
  for (const name of nativeProvisioningSteps) {
    await removeStepReference(dependencies, name);
    const native = byName.get(name);
    if (!native) throw new Error(`The native storage step ${name} is missing.`);
    await removeStepReference(await native.requiredBySteps(), "deploy");
  }
  for (const name of await dependencies.toArray()) {
    if (
      !["deploy-prereq", "validate-azure-login", existingOnlyStep].includes(
        name,
      )
    ) {
      throw new Error(`Unexpected storage deployment dependency: ${name}.`);
    }
  }
  const provision = byName.get("create-provisioning-context");
  if (!provision)
    throw new Error("The native storage context step is missing.");
  await provision.dependsOn("block-native-storage-context");
  await deploy.dependsOn(existingOnlyStep);
}

export async function deployStorageIntoExistingGroup(
  readPrerequisites: () => Promise<void>,
  deploy: (args: readonly string[]) => Promise<string>,
): Promise<unknown> {
  // Re-read immediately before applying. A read failure must never fall back to a resource-group PUT.
  await readPrerequisites();
  const target = issueStorageTarget;
  const output = await deploy([
    "deployment",
    "group",
    "create",
    "--subscription",
    target.subscriptionId,
    "--resource-group",
    target.resourceGroup,
    "--name",
    `issue-storage-${String(Date.now())}`,
    "--mode",
    "Incremental",
    "--template-file",
    resolve(import.meta.dirname, "..", "infra", "issue-storage.bicep"),
    "--parameters",
    `location=${target.location}`,
    `storageAccountName=${target.storageAccountName}`,
    `managedIdentityName=${target.managedIdentityName}`,
    `managedIdentityPrincipalId=${target.managedIdentityPrincipalId}`,
    "--query",
    "properties.outputs",
    "--only-show-errors",
    "--output",
    "json",
  ]);
  const outputs: unknown = JSON.parse(output);
  if (!outputs || typeof outputs !== "object" || Array.isArray(outputs)) {
    throw new Error("Storage deployment returned malformed outputs.");
  }
  return outputs;
}

export async function addIssueStorageInfrastructure(
  builder: DistributedApplicationBuilder,
): Promise<void> {
  const target = issueStorageTarget;
  for (const [setting, expected] of [
    ["SubscriptionId", target.subscriptionId],
    ["ResourceGroup", target.resourceGroup],
    ["Location", target.location],
  ] as const) {
    if (
      (await builder.getConfiguration().getConfigValue(`Azure:${setting}`)) !==
      expected
    ) {
      throw new Error(
        `Set Azure__${setting} explicitly to ${expected} for issue-storage.`,
      );
    }
  }
  const azure = await builder.addAzureEnvironment();
  await azure.withLocation(
    await builder.addParameter("issue-storage-location", {
      value: target.location,
      publishValueAsDefault: true,
    }),
  );
  await azure.withResourceGroup(
    await builder.addParameter("issue-storage-resource-group", {
      value: target.resourceGroup,
      publishValueAsDefault: true,
    }),
  );
  const storage = await builder.addBicepTemplate(
    "issue-storage",
    resolve(import.meta.dirname, "..", "infra", "issue-storage.bicep"),
  );
  for (const name of [
    "storageAccountName",
    "managedIdentityName",
    "managedIdentityPrincipalId",
  ] as const) {
    await storage.withParameter(name, { value: target[name] });
  }
  await storage.clearDefaultRoleAssignments();
  const pipeline = await builder.pipeline();
  await pipeline.addStep(
    "block-native-storage-context",
    () =>
      Promise.reject(
        new Error(
          "Native Azure provisioning is disabled for this shared resource group. Use the existing-only Aspire issue-storage deployment step.",
        ),
      ),
    { requiredBy: ["create-provisioning-context"] },
  );
  await pipeline.addStep(
    "protect-shared-resource-group",
    () => Promise.resolve().then(rejectSharedResourceGroupDestroy),
    {
      requiredBy: ["destroy-prereq"],
    },
  );
  await pipeline.addStep(
    "issue-storage-preflight",
    async (context) => {
      await withPipelineCancellation(context, async (signal) => {
        const root = resolve(import.meta.dirname, "..");
        const status = await runCommand(
          "git",
          ["status", "--porcelain"],
          root,
          {
            captureOutput: true,
            discardOutput: true,
            signal,
            terminateOnAbort: true,
          },
        );
        if (status.trim()) {
          throw new Error(
            "Commit the deployment source before deploying issue-storage.",
          );
        }
        await runCommand(
          "pwsh",
          [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-File",
            resolve(root, "infra", "existing-foundation.ps1"),
            "-StoragePreflight",
          ],
          root,
          { signal, terminateOnAbort: true },
        );
        const cli = await resolveAzureCliInvocation(root, signal);
        await runCommand(
          cli.command,
          [
            ...cli.args,
            "bicep",
            "build",
            "--file",
            resolve(root, "infra", "issue-storage.bicep"),
            "--stdout",
          ],
          root,
          { signal, discardOutput: true, terminateOnAbort: true },
        );
      });
    },
    { requiredBy: [existingOnlyStep] },
  );
  await storage.withPipelineStepFactory(
    existingOnlyStep,
    async (context) => {
      await withPipelineCancellation(context, async (signal) => {
        const root = resolve(import.meta.dirname, "..");
        const cli = await resolveAzureCliInvocation(root, signal);
        const outputs = await deployStorageIntoExistingGroup(
          async () => {
            await runCommand(
              "pwsh",
              [
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-File",
                resolve(root, "infra", "existing-foundation.ps1"),
                "-StoragePreflight",
              ],
              root,
              { signal, terminateOnAbort: true, discardOutput: true },
            );
          },
          (args) =>
            runCommand(cli.command, [...cli.args, ...args], root, {
              signal,
              terminateOnAbort: true,
              captureOutput: true,
              discardOutput: true,
            }),
        );
        const summary = await context.summary();
        await summary.add("Issue storage", JSON.stringify(outputs));
      });
    },
    {
      dependsOn: ["deploy-prereq", "issue-storage-preflight"],
    },
  );
  await storage.withPipelineConfiguration(async (context) => {
    const editor = await context.pipeline();
    await configureExistingOnlyStorageSteps(await editor.steps());
  });
}
