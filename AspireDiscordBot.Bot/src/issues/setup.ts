import { DefaultAzureCredential, ManagedIdentityCredential } from '@azure/identity';
import type { Logger } from 'pino';
import type { AppConfig } from '../config.js';
import type { RuntimeConfig } from '../runtime-config.js';
import { DiscordIssueController } from '../discord/issue-controller.js';
import { IssueDraftGenerator, type IssueDraftingRuntime } from './drafting.js';
import { GitHubAppIssuePublisher } from './github-app.js';
import { KeyVaultGitHubAppSigner } from './keyvault-signer.js';
import { currentIssuePolicy } from './policy.js';
import { AzureTableIssueDraftStore } from './table-store.js';
import { IssueWorkflow } from './workflow.js';

export function createIssueController(
  config: AppConfig['issues'],
  runtime: RuntimeConfig,
  copilot: IssueDraftingRuntime,
  logger: Logger,
  environment: NodeJS.ProcessEnv = process.env,
): DiscordIssueController {
  const getPolicy = () => currentIssuePolicy(runtime.current());
  if (!config.keyId || !config.tableEndpoint) {
    if (getPolicy().enabled) {
      logger.warn(
        'Issue filing policy is enabled but a Key Vault key URI or durable storage is missing. Publication remains unavailable.',
      );
    }
    return new DiscordIssueController(undefined, getPolicy, logger);
  }
  const credential =
    environment.NODE_ENV === 'production'
      ? new ManagedIdentityCredential(
          environment.AZURE_CLIENT_ID ? { clientId: environment.AZURE_CLIENT_ID } : {},
        )
      : new DefaultAzureCredential();
  const publisher = new GitHubAppIssuePublisher({
    appId: config.appId,
    signer: new KeyVaultGitHubAppSigner(config.keyId, credential),
    ...(config.installationId ? { installationId: config.installationId } : {}),
  });
  const store = new AzureTableIssueDraftStore(config.tableEndpoint, credential, config.tableName);
  return new DiscordIssueController(
    {
      generator: new IssueDraftGenerator(copilot),
      workflow: new IssueWorkflow(store, publisher, getPolicy, logger),
    },
    getPolicy,
    logger,
  );
}
