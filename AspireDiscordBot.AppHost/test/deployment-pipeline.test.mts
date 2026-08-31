import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import {
  buildDeploymentArguments,
  parseDeploymentResult,
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
});
