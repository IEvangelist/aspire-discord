import { describe, expect, it } from 'vitest';
import type { AnswerService } from '../../src/domain.js';
import { DiscordGateway } from '../../src/discord/gateway.js';
import { buildServer } from '../../src/server.js';
import { createTestConfig } from '../helpers/config.js';
import { testLogger } from '../helpers/logger.js';

describe('service composition', () => {
  it('runs HTTP readiness with the real disabled Discord gateway lifecycle', async () => {
    const config = createTestConfig();
    const answers: AnswerService = {
      answer: async () => ({
        answer: 'unused',
        citations: [],
        isGrounded: false,
        topScore: 0,
      }),
    };
    const discord = new DiscordGateway(config, answers, testLogger);
    const server = await buildServer({
      config,
      discord,
      logger: testLogger,
      vectorStore: { isReady: async () => true },
    });

    try {
      await discord.start();
      expect(discord.status().state).toBe('disabled');
      expect((await server.inject('/ready')).statusCode).toBe(200);
    } finally {
      await server.close();
      await discord.stop();
    }
  });
});
