import { afterEach, describe, expect, it } from 'vitest';
import { buildServer } from '../../src/server.js';
import { createTestConfig } from '../helpers/config.js';
import { testLogger } from '../helpers/logger.js';

const servers: Awaited<ReturnType<typeof buildServer>>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => await server.close()));
});

describe('HTTP service', () => {
  it('reports health, readiness, and gateway status', async () => {
    const server = await buildServer({
      config: createTestConfig(),
      discord: {
        ready: true,
        status: () => ({
          access: {
            allowedUsers: 0,
            configurationReady: true,
            groundingDetailsMode: 'collapsed',
            mode: 'open',
            revision: 'environment',
            source: 'environment',
          },
          guilds: 0,
          mentionEnabled: false,
          pingMilliseconds: 0,
          state: 'disabled',
          work: { active: 0, queued: 0 },
        }),
      },
      logger: testLogger,
      vectorStore: { isReady: async () => true },
    });
    servers.push(server);

    expect((await server.inject('/health')).statusCode).toBe(200);
    expect((await server.inject('/ready')).statusCode).toBe(200);
    const status = await server.inject('/status');
    expect(status.statusCode).toBe(200);
    expect(status.json().state).toBe('disabled');
  });

  it('returns 503 when the index is unavailable', async () => {
    const server = await buildServer({
      config: createTestConfig(),
      discord: {
        ready: true,
        status: () => ({
          access: {
            allowedUsers: 0,
            configurationReady: true,
            groundingDetailsMode: 'collapsed',
            mode: 'open',
            revision: 'environment',
            source: 'environment',
          },
          guilds: 0,
          mentionEnabled: false,
          pingMilliseconds: 0,
          state: 'disabled',
          work: { active: 0, queued: 0 },
        }),
      },
      logger: testLogger,
      vectorStore: { isReady: async () => false },
    });
    servers.push(server);

    expect((await server.inject('/ready')).statusCode).toBe(503);
  });

  it('returns 503 when Qdrant cannot be reached', async () => {
    const server = await buildServer({
      config: createTestConfig(),
      discord: {
        ready: true,
        status: () => ({
          access: {
            allowedUsers: 0,
            configurationReady: true,
            groundingDetailsMode: 'collapsed',
            mode: 'open',
            revision: 'environment',
            source: 'environment',
          },
          guilds: 0,
          mentionEnabled: false,
          pingMilliseconds: 0,
          state: 'disabled',
          work: { active: 0, queued: 0 },
        }),
      },
      logger: testLogger,
      vectorStore: {
        isReady: async () => {
          throw new Error('offline');
        },
      },
    });
    servers.push(server);

    expect((await server.inject('/ready')).statusCode).toBe(503);
  });
});
