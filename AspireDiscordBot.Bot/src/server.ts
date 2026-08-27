import helmet from '@fastify/helmet';
import swagger from '@fastify/swagger';
import scalar from '@scalar/fastify-api-reference';
import Fastify, { LogController } from 'fastify';
import type { Logger } from 'pino';
import type { AppConfig } from './config.js';
import type { DiscordStatus } from './discord/gateway.js';

export interface ReadinessStore {
  isReady(): Promise<boolean>;
}

export interface DiscordServiceStatus {
  readonly ready: boolean;
  status(): DiscordStatus;
}

interface ServerDependencies {
  readonly config: AppConfig;
  readonly discord: DiscordServiceStatus;
  readonly logger: Logger;
  readonly qdrant: ReadinessStore;
}

export async function buildServer(dependencies: ServerDependencies) {
  const { config, discord, logger, qdrant } = dependencies;
  const server = Fastify({
    bodyLimit: 64 * 1_024,
    logController: new LogController({
      disableRequestLogging: config.nodeEnvironment === 'production',
    }),
    loggerInstance: logger,
    requestTimeout: 15_000,
    trustProxy: false,
  });

  await server.register(helmet, {
    contentSecurityPolicy: false,
  });
  await server.register(swagger, {
    openapi: {
      info: {
        description: 'Health and gateway status for the Aspire Discord bot.',
        title: 'Aspire Discord Bot',
        version: '1.0.0',
      },
      openapi: '3.1.0',
    },
  });
  await server.register(scalar, {
    configuration: {
      pageTitle: 'Aspire Discord Bot API',
      theme: 'default',
    },
    routePrefix: '/scalar',
  });

  server.get(
    '/health',
    {
      schema: {
        response: {
          200: {
            additionalProperties: false,
            properties: { status: { const: 'healthy', type: 'string' } },
            required: ['status'],
            type: 'object',
          },
        },
      },
    },
    async () => ({ status: 'healthy' as const }),
  );

  server.get(
    '/ready',
    {
      schema: {
        response: {
          200: {
            additionalProperties: false,
            properties: { ready: { const: true, type: 'boolean' } },
            required: ['ready'],
            type: 'object',
          },
          503: {
            additionalProperties: false,
            properties: { ready: { const: false, type: 'boolean' } },
            required: ['ready'],
            type: 'object',
          },
        },
      },
    },
    async (_request, reply) => {
      try {
        const ready = discord.ready && (await qdrant.isReady());
        if (ready) {
          return { ready: true as const };
        }
      } catch (error) {
        logger.warn({ err: error }, 'Readiness check could not reach Qdrant.');
      }
      return await reply.code(503).send({ ready: false });
    },
  );

  server.get(
    '/status',
    {
      schema: {
        response: {
          200: {
            additionalProperties: true,
            type: 'object',
          },
        },
      },
    },
    async () => discord.status(),
  );

  server.setErrorHandler(async (error, request, reply) => {
    request.log.error({ err: error }, 'HTTP request failed.');
    await reply.code(500).send({
      error: 'Internal Server Error',
      statusCode: 500,
    });
  });

  return server;
}
