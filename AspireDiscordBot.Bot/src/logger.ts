import pino, { type Logger } from 'pino';
import type { AppConfig } from './config.js';

const redactedPaths = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.apiKey',
  '*.token',
  '*.privateKey',
  'privateKey',
  'GITHUB_ISSUES_APP_PRIVATE_KEY',
  'apiKey',
  'token',
];

export function createLogger(config: Pick<AppConfig, 'logLevel' | 'nodeEnvironment'>): Logger {
  return pino({
    base: {
      service: 'aspire-discord-bot',
    },
    level: config.logLevel,
    redact: {
      paths: redactedPaths,
      censor: '[redacted]',
    },
    serializers: {
      err: pino.stdSerializers.err,
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}
