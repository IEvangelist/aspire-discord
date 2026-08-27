import { describe, expect, it } from 'vitest';
import { CitationRegistry } from '../../src/citations.js';
import { GitHubMcpClient } from '../../src/agent/github-mcp.js';
import { ToolBudget } from '../../src/agent/tool-budget.js';
import { createTestConfig } from '../helpers/config.js';
import { testLogger } from '../helpers/logger.js';

const token = process.env.GITHUB_MCP_TEST_TOKEN;
const suite = token ? describe : describe.skip;

suite('GitHub MCP integration', () => {
  it('authenticates and executes repository-scoped code search', async () => {
    const config = createTestConfig({
      githubMcp: {
        allowedRepositories: ['microsoft/aspire', 'microsoft/aspire.dev'],
        endpoint: 'https://api.githubcopilot.com/mcp/',
        token: token!,
      },
    });
    const client = new GitHubMcpClient(config.githubMcp, testLogger);
    try {
      const tool = client
        .createTools(new CitationRegistry(), new ToolBudget(1))
        .find((candidate) => candidate.name === 'search_code');
      expect(tool?.handler).toBeTypeOf('function');
      const output = await tool!.handler!(
        { query: 'DistributedApplicationBuilder' },
        {
          arguments: { query: 'DistributedApplicationBuilder' },
          sessionId: 'test',
          toolCallId: 'test',
          toolName: 'search_code',
        },
      );
      expect(String(output)).toContain('microsoft/aspire');
    } finally {
      await client.close();
    }
  });
});
