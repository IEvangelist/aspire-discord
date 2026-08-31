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

  it('reads authoritative latest-release context', async () => {
    const config = createTestConfig({
      githubMcp: {
        allowedRepositories: ['microsoft/aspire', 'microsoft/aspire.dev'],
        endpoint: 'https://api.githubcopilot.com/mcp/',
        token: token!,
      },
    });
    const client = new GitHubMcpClient(config.githubMcp, testLogger);
    const citations = new CitationRegistry();
    try {
      const result = await client.readLatestReleaseContext(citations, new ToolBudget(1));

      expect(result?.context).toMatch(/Aspire \d+\.\d+\.\d+/u);
      expect(result?.releaseVersion).toMatch(/^\d+\.\d+\.\d+/u);
      expect(citations.all[0]?.url).toBe('https://github.com/microsoft/aspire/releases/latest');
    } finally {
      await client.close();
    }
  });

  it('routes a linked issue through the bounded read-only issue tools', async () => {
    const config = createTestConfig({
      githubMcp: {
        allowedRepositories: ['microsoft/aspire', 'microsoft/aspire.dev'],
        endpoint: 'https://api.githubcopilot.com/mcp/',
        token: token!,
      },
    });
    const client = new GitHubMcpClient(config.githubMcp, testLogger);
    const citations = new CitationRegistry();
    try {
      const result = await client.readLinkedContext(
        'https://github.com/microsoft/aspire/issues/19815',
        citations,
        new ToolBudget(1),
      );

      expect(result?.context).toContain('WithTerminal');
      expect(citations.all[0]?.url).toBe('https://github.com/microsoft/aspire/issues/19815');
    } finally {
      await client.close();
    }
  });
});
