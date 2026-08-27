import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      include: [
        'src/citations.ts',
        'src/config.ts',
        'src/prompts.ts',
        'src/safety.ts',
        'src/server.ts',
        'src/work-limiter.ts',
        'src/agent/answer-service.ts',
        'src/agent/github-policy.ts',
        'src/agent/tool-budget.ts',
        'src/discord/ask-resolver.ts',
        'src/discord/authorizer.ts',
        'src/discord/formatter.ts',
      ],
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      thresholds: {
        branches: 70,
        functions: 80,
        lines: 80,
        statements: 80,
      },
    },
    fileParallelism: true,
    hookTimeout: 30_000,
    include: ['test/**/*.test.ts'],
    mockReset: true,
    restoreMocks: true,
    testTimeout: 30_000,
  },
});
