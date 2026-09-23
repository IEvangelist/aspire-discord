import { describe, expect, it, vi } from 'vitest';
import { createIssueController } from '../../src/issues/setup.js';
import type { RuntimeConfig } from '../../src/runtime-config.js';
import { disabledIssuePolicy } from '../../src/issues/policy.js';
import { createTestConfig } from '../helpers/config.js';
import { testLogger } from '../helpers/logger.js';

const mocks = vi.hoisted(() => ({
  managedIdentity: vi.fn(),
  defaultCredential: vi.fn(),
  signer: vi.fn(),
  publisher: vi.fn(),
  table: vi.fn(),
}));
vi.mock('@azure/identity', () => ({
  ManagedIdentityCredential: class {
    constructor(public readonly options: unknown) {
      mocks.managedIdentity(options);
    }
  },
  DefaultAzureCredential: class {
    public readonly kind = 'developer-credential';
    constructor() {
      mocks.defaultCredential();
    }
  },
}));
vi.mock('../../src/issues/keyvault-signer.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    KeyVaultGitHubAppSigner: class {
      constructor(
        public readonly keyId: string,
        public readonly credential: unknown,
      ) {
        mocks.signer(keyId, credential);
      }
    },
  };
});
vi.mock('../../src/issues/github-app.js', () => ({
  GitHubAppIssuePublisher: class {
    constructor(public readonly config: unknown) {
      mocks.publisher(config);
    }
  },
}));
vi.mock('../../src/issues/table-store.js', () => ({
  AzureTableIssueDraftStore: class {
    constructor(
      public readonly endpoint: string,
      public readonly credential: unknown,
      public readonly tableName: string,
    ) {
      mocks.table(endpoint, credential, tableName);
    }
  },
}));

const runtime: RuntimeConfig = {
  current: () => ({
    available: true,
    allowedUserIds: new Set(),
    groundingDetailsMode: 'collapsed',
    source: 'environment',
    revision: 'test',
    issuePolicy: disabledIssuePolicy,
    issuePolicyAvailable: true,
  }),
  refresh: async () => undefined,
  stop: () => undefined,
};
const copilot = { complete: async () => 'unused' };
const keyId =
  'https://aspire-signing.vault.azure.net/keys/github-app/0123456789abcdef0123456789abcdef';

describe('issue signing composition', () => {
  it('stays unavailable without both a Key Vault URI and durable storage', () => {
    for (const issues of [
      createTestConfig().issues,
      createTestConfig({ issues: { keyId } }).issues,
      createTestConfig({ issues: { tableEndpoint: 'https://example.table.core.windows.net' } })
        .issues,
    ]) {
      const controller = createIssueController(issues, runtime, copilot, testLogger, {
        NODE_ENV: 'production',
      });
      expect(controller.status()).toEqual({ configured: false, enabled: false });
    }
    expect(mocks.signer).not.toHaveBeenCalled();
    expect(mocks.publisher).not.toHaveBeenCalled();
  });

  it('uses only managed identity in production and passes a signer instead of a private key', () => {
    const config = createTestConfig({
      issues: {
        keyId,
        tableEndpoint: 'https://example.table.core.windows.net',
        installationId: 42,
      },
    });
    const controller = createIssueController(config.issues, runtime, copilot, testLogger, {
      NODE_ENV: 'production',
      AZURE_CLIENT_ID: 'production-managed-identity',
    });
    expect(mocks.managedIdentity).toHaveBeenCalledWith({ clientId: 'production-managed-identity' });
    expect(mocks.defaultCredential).not.toHaveBeenCalled();
    expect(mocks.signer).toHaveBeenCalledWith(keyId, expect.any(Object));
    expect(mocks.publisher).toHaveBeenCalledWith({
      appId: '4968096',
      installationId: 42,
      signer: expect.any(Object),
    });
    expect(mocks.table).toHaveBeenCalledWith(
      'https://example.table.core.windows.net',
      expect.any(Object),
      'IssueDrafts',
    );
    expect(controller.status()).toEqual({ configured: true, enabled: false });
  });

  it('supports developer Azure credentials without providing a PEM fallback', () => {
    const config = createTestConfig({
      issues: { keyId, tableEndpoint: 'https://example.table.core.windows.net' },
    });
    createIssueController(config.issues, runtime, copilot, testLogger, { NODE_ENV: 'development' });
    expect(mocks.defaultCredential).toHaveBeenCalledOnce();
    expect(mocks.managedIdentity).not.toHaveBeenCalled();
    expect(mocks.signer).toHaveBeenCalledWith(keyId, expect.any(Object));
  });
});
