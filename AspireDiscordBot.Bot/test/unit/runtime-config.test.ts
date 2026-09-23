import { beforeEach, describe, expect, it, vi } from 'vitest';
import { startRuntimeConfig, runtimeConfigKeys } from '../../src/runtime-config.js';
import { createTestConfig } from '../helpers/config.js';
import { testLogger } from '../helpers/logger.js';
import { currentIssuePolicy } from '../../src/issues/policy.js';

class FakeConfigurationClient {
  public constructor(readonly values: Map<string, string | undefined>) {}

  public async *listSettings(): AsyncIterable<{
    key: string;
    value?: string;
  }> {
    for (const [key, value] of this.values) {
      yield {
        key,
        ...(value === undefined ? {} : { value }),
      };
    }
  }
}

beforeEach(() => {
  vi.useRealTimers();
});

describe('runtime configuration', () => {
  it('fails issue writes closed on refresh errors and restores them after a valid refresh', async () => {
    const remote = new FakeConfigurationClient(
      new Map([
        [runtimeConfigKeys.allowedUserIds, '123'],
        [runtimeConfigKeys.groundingDetailsMode, 'collapsed'],
        [
          runtimeConfigKeys.issuePolicy,
          JSON.stringify({
            enabled: true,
            allowedUserIds: ['123'],
            allowedChannelIds: ['456'],
            allowedRepositories: ['microsoft/aspire'],
          }),
        ],
      ]),
    );
    const runtime = await startRuntimeConfig(
      createTestConfig({ runtimeConfig: { endpoint: 'https://example.azconfig.io' } }),
      testLogger,
      { client: remote },
    );
    expect(currentIssuePolicy(runtime.current()).enabled).toBe(true);
    remote.values.set(runtimeConfigKeys.issuePolicy, '{bad json');
    await runtime.refresh();
    expect(runtime.current().available).toBe(true);
    expect(currentIssuePolicy(runtime.current()).enabled).toBe(false);
    remote.values.set(
      runtimeConfigKeys.issuePolicy,
      JSON.stringify({
        enabled: true,
        allowedUserIds: ['123'],
        allowedChannelIds: ['456'],
        allowedRepositories: ['microsoft/aspire'],
      }),
    );
    await runtime.refresh();
    expect(currentIssuePolicy(runtime.current()).enabled).toBe(true);
    remote.values.delete(runtimeConfigKeys.issuePolicy);
    await runtime.refresh();
    expect(currentIssuePolicy(runtime.current()).enabled).toBe(false);
    runtime.stop();
  });

  it('uses environment values when Azure App Configuration is not configured', async () => {
    const runtime = await startRuntimeConfig(
      createTestConfig({
        discord: {
          allowedUserIds: new Set(['123']),
          groundingDetailsMode: 'expanded',
        },
      }),
      testLogger,
    );

    expect(runtime.current()).toMatchObject({
      available: true,
      groundingDetailsMode: 'expanded',
      source: 'environment',
    });
    expect([...runtime.current().allowedUserIds]).toEqual(['123']);
  });

  it('loads and applies refreshed Azure App Configuration values', async () => {
    const remote = new FakeConfigurationClient(
      new Map([
        [runtimeConfigKeys.allowedUserIds, '123,456'],
        [runtimeConfigKeys.groundingDetailsMode, 'collapsed'],
      ]),
    );
    const runtime = await startRuntimeConfig(
      createTestConfig({
        runtimeConfig: { endpoint: 'https://example.azconfig.io' },
      }),
      testLogger,
      { client: remote },
    );

    expect(runtime.current()).toMatchObject({
      available: true,
      groundingDetailsMode: 'collapsed',
      source: 'azure-app-configuration',
    });
    expect([...runtime.current().allowedUserIds]).toEqual(['123', '456']);

    remote.values.set(runtimeConfigKeys.allowedUserIds, '456,789');
    remote.values.set(runtimeConfigKeys.groundingDetailsMode, 'hidden');
    await runtime.refresh();

    expect(runtime.current()).toMatchObject({
      available: true,
      groundingDetailsMode: 'hidden',
      source: 'azure-app-configuration',
    });
    expect([...runtime.current().allowedUserIds]).toEqual(['456', '789']);
    runtime.stop();
  });

  it('retains the environment fallback when the initial remote load fails', async () => {
    const runtime = await startRuntimeConfig(
      createTestConfig({
        discord: { allowedUserIds: new Set(['999']) },
        runtimeConfig: { endpoint: 'https://example.azconfig.io' },
      }),
      testLogger,
      {
        client: {
          listSettings: () => {
            throw new Error('offline');
          },
        },
      },
    );

    expect(runtime.current()).toMatchObject({
      available: false,
      source: 'unavailable',
    });
    expect([...runtime.current().allowedUserIds]).toEqual([]);
    runtime.stop();
  });

  it('retains the last valid snapshot when a refreshed value is invalid', async () => {
    const remote = new FakeConfigurationClient(
      new Map([
        [runtimeConfigKeys.allowedUserIds, '123'],
        [runtimeConfigKeys.groundingDetailsMode, 'collapsed'],
      ]),
    );
    const runtime = await startRuntimeConfig(
      createTestConfig({
        runtimeConfig: { endpoint: 'https://example.azconfig.io' },
      }),
      testLogger,
      { client: remote },
    );

    remote.values.set(runtimeConfigKeys.allowedUserIds, 'not-a-discord-id');
    await runtime.refresh();

    expect([...runtime.current().allowedUserIds]).toEqual(['123']);
    expect(runtime.current().groundingDetailsMode).toBe('collapsed');
    runtime.stop();
  });
});
