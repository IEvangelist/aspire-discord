import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import type { PipelineStep } from "../.aspire/modules/aspire.mjs";
import {
  configureExistingOnlyStorageSteps,
  deployStorageIntoExistingGroup,
} from "../issue-storage.mjs";
import {
  buildDeploymentArguments,
  parseDeploymentResult,
  rejectSharedResourceGroupDestroy,
  resolveAzureCliInvocation,
  runCommand,
  validateDeploymentOptions,
  type ProductionDeploymentOptions,
} from "../deployment-pipeline.mjs";

const validOptions: ProductionDeploymentOptions = {
  allowedUserIds: "",
  appHostPath: "D:\\repo\\AspireDiscordBot.AppHost\\apphost.mts",
  discordToken: "discord-secret",
  environmentName: "Production",
  githubToken: "github-secret",
  location: "centralus",
  repositoryRoot: "D:\\repo",
  resourceGroup: "aspire-discord-prod",
  resourceSuffix: "ffccd7",
  skipBuild: false,
  subscriptionId: "11aa9ca6-306a-4ea9-b614-2d413efd04a8",
};

await describe("production deployment pipeline", async () => {
  await it("removes both native deployment edges and blocks direct native storage context execution", async () => {
    function step(
      name: string,
      dependencies: string[] = [],
      requiredBy: string[] = [],
    ) {
      const list = (values: string[]) => ({
        toArray: () => Promise.resolve([...values]),
        removeAt: (index: number) => {
          values.splice(index, 1);
          return Promise.resolve();
        },
      });
      const handle = {
        name: () => Promise.resolve(name),
        dependsOnSteps: () => Promise.resolve(list(dependencies)),
        requiredBySteps: () => Promise.resolve(list(requiredBy)),
        dependsOn: (dependency: string): Promise<PipelineStep> => {
          dependencies.push(dependency);
          return Promise.resolve(handle as unknown as PipelineStep);
        },
      } as unknown as PipelineStep;
      return { handle, dependencies, requiredBy };
    }
    const context = step(
      "create-provisioning-context",
      ["deploy-prereq"],
      ["deploy"],
    );
    const module = step("provision-issue-storage", [
      "create-provisioning-context",
    ]);
    const aggregate = step(
      "provision-azure-bicep-resources",
      ["provision-issue-storage"],
      ["deploy"],
    );
    const deploy = step("deploy", [
      "deploy-prereq",
      "validate-azure-login",
      "create-provisioning-context",
      "provision-azure-bicep-resources",
    ]);
    const steps = [
      context,
      module,
      aggregate,
      deploy,
      step("issue-storage-existing-group"),
      step("block-native-storage-context"),
    ];
    await configureExistingOnlyStorageSteps(steps.map((item) => item.handle));
    assert.deepEqual(deploy.dependencies, [
      "deploy-prereq",
      "validate-azure-login",
      "issue-storage-existing-group",
    ]);
    assert.ok(context.dependencies.includes("block-native-storage-context"));
    assert.deepEqual(context.requiredBy, []);
    assert.deepEqual(aggregate.requiredBy, []);
    deploy.dependencies.push("unexpected-resource-writer");
    await assert.rejects(
      configureExistingOnlyStorageSteps(steps.map((item) => item.handle)),
      /Unexpected storage deployment dependency/u,
    );
  });

  await it("never deploys or recreates the shared group when a second metadata read fails after preflight", async () => {
    let reads = 0;
    let deployments = 0;
    const read = () => {
      if (++reads === 1) return Promise.resolve();
      return Promise.reject(new Error("resource-group lookup unavailable"));
    };
    await read();
    await assert.rejects(
      deployStorageIntoExistingGroup(read, () => {
        deployments++;
        return Promise.resolve("{}");
      }),
      /lookup unavailable/u,
    );
    assert.equal(deployments, 0);
    await deployStorageIntoExistingGroup(
      () => Promise.resolve(),
      (args) => {
        assert.deepEqual(args.slice(0, 3), ["deployment", "group", "create"]);
        assert.ok(args.includes("Incremental"));
        assert.equal(
          args[args.indexOf("--resource-group") + 1],
          "aspire-discord-prod",
        );
        assert.ok(
          args.includes(
            "managedIdentityPrincipalId=16d6bfa3-79e5-4da5-b2d8-b76672588040",
          ),
        );
        return Promise.resolve("{}");
      },
    );
  });
  await it("keeps foundation reuse explicit and passes only nonsecret issue identifiers", () => {
    const keyId =
      "https://aspire-issues-ffccd7.vault.azure.net/keys/github-issues/b4ee9c33666f4abe90b3d9c17d2008bf";
    assert.throws(() => {
      validateDeploymentOptions({
        ...validOptions,
        githubIssuesKeyId: keyId,
      });
    }, /UseExistingFoundation/u);
    const options = {
      ...validOptions,
      useExistingFoundation: true,
      githubIssuesKeyId: keyId,
    };
    assert.doesNotThrow(() => {
      validateDeploymentOptions(options);
    });
    assert.throws(() => {
      validateDeploymentOptions({
        ...options,
        githubIssuesKeyId: keyId + "?secret=x",
      });
    }, /versioned HTTPS/u);
    const args = buildDeploymentArguments(
      "deploy.ps1",
      "result.json",
      "cancel",
      options,
    );
    assert.ok(args.includes("-UseExistingFoundation"));
    assert.ok(args.includes(keyId));
    assert.ok(
      !buildDeploymentArguments(
        "deploy.ps1",
        "result.json",
        "cancel",
        validOptions,
      ).includes("-UseExistingFoundation"),
    );
    assert.throws(
      rejectSharedResourceGroupDestroy,
      /shared production resource group/u,
    );
  });

  await it("validates foundation reuse and secret handling with PowerShell AST mocks", async () => {
    await runCommand(
      "pwsh",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-File",
        resolve(import.meta.dirname, "existing-foundation.test.ps1"),
      ],
      resolve(import.meta.dirname, "..", ".."),
      { captureOutput: true },
    );
  });

  await it("keeps the issue scope isolated and storage roles table-scoped", async () => {
    const root = resolve(import.meta.dirname, "..", "..");
    const storage = await readFile(
      resolve(root, "infra", "issue-storage.bicep"),
      "utf8",
    );
    assert.match(storage, /scope: drafts/u);
    assert.match(storage, /allowSharedKeyAccess: false/u);
    assert.match(storage, /defaultToOAuthAuthentication: true/u);
    assert.match(storage, /0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3/u);
    assert.doesNotMatch(
      storage,
      /roleDefinitions@\S+|Microsoft.Network|Microsoft.KeyVault|fileServices/u,
    );
    const apphost = await readFile(
      resolve(root, "AspireDiscordBot.AppHost", "apphost.mts"),
      "utf8",
    );
    assert.ok(
      apphost.indexOf('deploymentScope === "issue-storage"') <
        apphost.indexOf('builder.addParameter("DiscordToken"'),
    );
    assert.match(apphost, /"Parameters:UseExistingFoundation",\s+false/u);
    const script = await readFile(
      resolve(root, "infra", "deploy-production.ps1"),
      "utf8",
    );
    assert.ok(
      script.indexOf(
        "Wait-Application -ApplicationUrl $applicationUrl -ExpectDiscord $false",
      ) <
        script.indexOf(
          "-Active $false",
          script.indexOf("$stage = Invoke-AppDeployment"),
        ),
    );
    assert.doesNotMatch(
      script,
      /Wait-PrivateEndpointValidation|RestrictSearchPublicNetworkAccess|IssuePolicy/u,
    );
    assert.match(script, /'If-None-Match' = '\*'/u);
  });
  await it("accepts the configured production target", () => {
    assert.doesNotThrow(() => {
      validateDeploymentOptions(validOptions);
    });
  });

  await it("rejects non-production environments and missing AppHost paths", () => {
    assert.throws(() => {
      validateDeploymentOptions({
        ...validOptions,
        environmentName: "Staging",
      });
    }, /only targets Production/u);
    assert.throws(() => {
      validateDeploymentOptions({
        ...validOptions,
        appHostPath: "",
      });
    }, /AppHost path/u);
  });

  await it("builds PowerShell arguments without putting secrets on the command line", () => {
    const args = buildDeploymentArguments(
      "D:\\repo\\infra\\deploy-production.ps1",
      "D:\\temp\\result.json",
      "D:\\temp\\cancel",
      { ...validOptions, skipBuild: true },
    );

    assert.ok(args.includes("-SkipBuild"));
    assert.ok(args.includes("-CancellationPath"));
    assert.ok(args.includes("D:\\temp\\cancel"));
    assert.ok(args.includes(validOptions.subscriptionId));
    assert.ok(!args.includes(validOptions.discordToken));
    assert.ok(!args.includes(validOptions.githubToken));
  });

  await it("accepts only complete deployment results", () => {
    const result = parseDeploymentResult(
      JSON.stringify({
        Application: "aspire-discord-green",
        ImageTag: "0123456789ab",
        ResourceGroup: "aspire-discord-prod",
        SearchEndpoint: "https://example.search.windows.net",
        SubscriptionId: validOptions.subscriptionId,
        Url: "https://example.azurecontainerapps.io",
      }),
    );

    assert.equal(result.Application, "aspire-discord-green");
    assert.throws(() => {
      parseDeploymentResult("{}");
    }, /complete result/u);
  });

  await it("propagates cancellation to child command hooks", async () => {
    const controller = new AbortController();
    let cancellationObserved = false;
    const operation = runCommand(
      process.execPath,
      ["-e", "setTimeout(() => process.exit(0), 100)"],
      import.meta.dirname,
      {
        onAbort: () => {
          cancellationObserved = true;
        },
        signal: controller.signal,
      },
    );

    setTimeout(() => {
      controller.abort(new Error("test cancellation"));
    }, 10);

    await assert.rejects(operation, /test cancellation/u);
    assert.equal(cancellationObserved, true);
  });

  await it("resolves Azure CLI to a directly spawnable command", async () => {
    const invocation = await resolveAzureCliInvocation(
      resolve(import.meta.dirname, "..", ".."),
    );
    const version = await runCommand(
      invocation.command,
      [...invocation.args, "version", "--output", "json"],
      import.meta.dirname,
      { captureOutput: true, discardOutput: true },
    );

    assert.match(version, /"azure-cli"/u);
  });

  await it("gates source restoration on confirmed target shutdown", async () => {
    const script = await readFile(
      resolve(
        import.meta.dirname,
        "..",
        "..",
        "infra",
        "deploy-production.ps1",
      ),
      "utf8",
    );
    const targetShutdownFailure = script.indexOf(
      "The source bot was not reactivated because that could run two bots",
    );
    const sourceRestoration = script.indexOf("$sourceRestored =");

    assert.ok(targetShutdownFailure >= 0);
    assert.ok(sourceRestoration > targetShutdownFailure);
  });

  await it("returns the lease token before observing cancellation again", async () => {
    const script = await readFile(
      resolve(
        import.meta.dirname,
        "..",
        "..",
        "infra",
        "deploy-production.ps1",
      ),
      "utf8",
    );
    const leasePatch = script.indexOf("-Method Patch");
    const leaseReturn = script.indexOf("return $leaseToken", leasePatch);
    const protectedBlock = script.indexOf(
      "$deploymentLease = Enter-DeploymentLease",
      leaseReturn,
    );

    assert.ok(leasePatch >= 0);
    assert.ok(leaseReturn > leasePatch);
    assert.ok(protectedBlock > leaseReturn);
    assert.ok(
      !script
        .slice(leasePatch, leaseReturn)
        .includes("Assert-DeploymentNotCancelled"),
    );
  });

  await it("retries HTTP readiness timeouts unless deployment was cancelled", async () => {
    const script = await readFile(
      resolve(
        import.meta.dirname,
        "..",
        "..",
        "infra",
        "deploy-production.ps1",
      ),
      "utf8",
    );
    const waitStart = script.indexOf("function Wait-Application");
    const waitEnd = script.indexOf("function Get-ActiveRevision", waitStart);
    const waitFunction = script.slice(waitStart, waitEnd);

    assert.ok(waitStart >= 0);
    assert.ok(waitEnd > waitStart);
    assert.doesNotMatch(
      waitFunction,
      /catch\s+\[OperationCanceledException\]/u,
    );
    assert.match(
      waitFunction,
      /catch\s*\{\s*Assert-DeploymentNotCancelled\s+Write-Host/su,
    );
  });

  await it("handles inactive applications with no active revision output", async () => {
    const script = await readFile(
      resolve(
        import.meta.dirname,
        "..",
        "..",
        "infra",
        "deploy-production.ps1",
      ),
      "utf8",
    );
    const revisionStart = script.indexOf("function Get-ActiveRevision");
    const revisionEnd = script.indexOf(
      "function Set-RevisionActive",
      revisionStart,
    );
    const revisionFunction = script.slice(revisionStart, revisionEnd);

    assert.match(
      revisionFunction,
      /if \(\$null -eq \$revision\)\s*\{\s*return ''\s*\}/su,
    );
    assert.ok(
      revisionFunction.indexOf("$null -eq $revision") <
        revisionFunction.indexOf(".Trim()"),
    );
  });
});
