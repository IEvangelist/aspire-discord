import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/client';
import type { Logger } from 'pino';
import { z } from 'zod';
import { GitHubMcpClient } from '../../src/agent/github-mcp.js';
import { ToolBudget } from '../../src/agent/tool-budget.js';
import { CitationRegistry } from '../../src/citations.js';
import type { AppConfig } from '../../src/config.js';

const mocks = vi.hoisted(() => ({
  callTool: vi.fn(),
  close: vi.fn(),
  connect: vi.fn(),
  listTools: vi.fn(),
  transport: vi.fn(),
}));

vi.mock('@modelcontextprotocol/client', () => ({
  Client: class {
    callTool = mocks.callTool;
    close = mocks.close;
    connect = mocks.connect;
    listTools = mocks.listTools;
  },
  StreamableHTTPClientTransport: class {
    constructor(
      public readonly url: URL,
      options: unknown,
    ) {
      mocks.transport(url, options);
    }
  },
}));

const config: AppConfig['githubMcp'] = {
  allowedRepositories: ['microsoft/aspire', 'microsoft/aspire.dev'],
  endpoint: 'https://api.githubcopilot.com/mcp/',
  token: 'test-secret-token',
};
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() } as unknown as Logger;

function result(repository = 'microsoft/aspire'): CallToolResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          total_count: 75,
          incomplete_results: true,
          items: [
            {
              number: 42,
              title: 'Example issue',
              html_url: `https://github.com/${repository}/issues/42#issuecomment-2`,
              created_at: '2026-09-01T00:00:00Z',
              closed_at: null,
              user: { login: 'example' },
              pull_request: {},
            },
          ],
        }),
      },
    ],
  };
}

function setup(maximum = 10, signal?: AbortSignal) {
  const client = new GitHubMcpClient(config, logger);
  const registry = new CitationRegistry();
  const budget = new ToolBudget(maximum);
  const tools = client.createTools(registry, budget, signal);
  const tool = (name: string) => {
    const found = tools.find((candidate) => candidate.name === name);
    if (!found) throw new Error(`Missing tool ${name}`);
    return found;
  };
  const run = async (name: string, input: Record<string, unknown>) => {
    const handler = tool(name).handler;
    if (!handler) throw new Error(`Missing handler ${name}`);
    return await handler(input, {
      arguments: input,
      toolCallId: 'test',
      toolName: name,
      sessionId: 'test',
    });
  };
  return { budget, client, registry, run, tool, tools };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.connect.mockResolvedValue(undefined);
  mocks.close.mockResolvedValue(undefined);
  mocks.listTools.mockResolvedValue({ tools: [] });
  mocks.callTool.mockImplementation(
    async (request: { arguments: { owner: string; repo: string } }) =>
      result(`${request.arguments.owner}/${request.arguments.repo}`),
  );
});

describe('GitHubMcpClient repository searches', () => {
  it.each([
    ['search_issues', 'issue'],
    ['search_pull_requests', 'pr'],
  ])('searches BOTH configured repositories using %s', async (name, kind) => {
    const { budget, run, registry } = setup();
    const output = await run(name, { query: 'author:example updated:>=2026-09-01' });
    expect(mocks.callTool).toHaveBeenCalledTimes(2);
    for (const [index, repo] of ['aspire', 'aspire.dev'].entries()) {
      expect(mocks.callTool.mock.calls[index]?.[0]).toEqual({
        name,
        arguments: {
          fields: expect.arrayContaining([
            'created_at',
            'updated_at',
            'closed_at',
            'user',
            'pull_request',
          ]),
          owner: 'microsoft',
          repo,
          query: `author:example updated:>=2026-09-01 repo:microsoft/${repo} is:${kind}`,
          page: 1,
          perPage: 20,
        },
      });
      expect(output).toContain(`Repository: microsoft/${repo}; page: 1; limit: 20`);
    }
    expect(output).toContain('Partial evidence window');
    expect(output).toContain('"total_count":75');
    expect(output).toContain('"incomplete_results":true');
    expect(registry.all.map((citation) => citation.repo)).toEqual(config.allowedRepositories);
    expect(budget.used).toBe(2);
  });

  it('uses one explicit repository with bounded pagination', async () => {
    const { run, tool } = setup();
    await run('search_issues', {
      query: 'is:open repo:"microsoft/aspire.dev"',
      repository: 'microsoft/aspire.dev',
      page: 10,
      perPage: 50,
    });
    expect(mocks.callTool).toHaveBeenCalledTimes(1);
    expect(mocks.callTool.mock.calls[0]?.[0].arguments).toMatchObject({
      repo: 'aspire.dev',
      page: 10,
      perPage: 50,
      query: 'is:open repo:microsoft/aspire.dev is:issue',
    });
    expect(z.toJSONSchema(tool('search_issues').parameters as z.ZodObject)).toMatchObject({
      properties: {
        page: { minimum: 1, maximum: 10, default: 1 },
        perPage: { minimum: 1, maximum: 50, default: 20 },
      },
    });
  });

  it.each([
    { page: 0 },
    { page: 11 },
    { page: 1.5 },
    { perPage: 0 },
    { perPage: 51 },
    { repository: 'outside/repo' },
    { query: 'term OR repo:outside/repo' },
    { query: 'repo:outside/repo' },
    { query: '"term OR repo:outside/repo"' },
    { query: '"repo:outside/repo"' },
    { query: 'owner:outside' },
    { query: 'org:outside' },
    { query: 'user:outside' },
    { query: 'is:pr' },
    { query: 'is:"pr"' },
    { query: '"is:pr"' },
    { query: 'type:pr' },
    { query: 'is:issue,pr' },
    { query: '-is:issue' },
    { query: 'repo:microsoft/aspire' },
  ])('rejects unsafe input before any remote call: %j', async (input) => {
    const { run, budget } = setup();
    await expect(run('search_issues', { query: 'term', ...input })).rejects.toThrow();
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(mocks.callTool).not.toHaveBeenCalled();
    expect(budget.used).toBe(0);
  });

  it('does not cross the per-remote-call budget and identifies the unexecuted repository', async () => {
    const { run, budget } = setup(1);
    const output = await run('search_issues', { query: 'is:open' });
    expect(mocks.callTool).toHaveBeenCalledTimes(1);
    expect(budget.used).toBe(1);
    expect(output).toContain('Repository: microsoft/aspire.dev');
    expect(output).toContain('budget exhausted');
  });

  it('retains structured search metadata even alongside text content', async () => {
    mocks.callTool.mockResolvedValue({
      content: [{ type: 'text', text: 'No matches in this window.' }],
      structuredContent: { total_count: 100, incomplete_results: false },
    });
    const { run } = setup();
    expect(await run('search_issues', { query: 'term' })).toContain(
      '"total_count":100,"incomplete_results":false',
    );
  });

  it.each([
    ['search_issues', 'issues'],
    ['search_pull_requests', 'pulls'],
  ])(
    'grounds successful empty %s windows in both canonical repository search URLs',
    async (name, path) => {
      mocks.callTool.mockResolvedValue({
        content: [
          {
            type: 'text',
            text: '{"items":[],"total_count":0,"incomplete_results":false}',
          },
        ],
      });
      const { run, registry, budget } = setup();
      const output = await run(name, { query: 'author:example', page: 2, perPage: 30 });
      expect(budget.used).toBe(2);
      expect(registry.all).toHaveLength(2);
      for (const [index, repository] of config.allowedRepositories.entries()) {
        const citation = registry.all[index];
        expect(citation?.repo).toBe(repository);
        const url = new URL(citation?.url ?? '');
        expect(`${url.origin}${url.pathname}`).toBe(`https://github.com/${repository}/${path}`);
        expect(url.searchParams.get('q')).toContain(`repo:${repository}`);
        expect(url.searchParams.get('page')).toBe('2');
        expect(output).toContain(`[${String(index + 1)}] GitHub search evidence:`);
        expect(output).toContain(`Repository: ${repository}; page: 2; limit: 30`);
      }
      expect(output).toContain('"total_count":0,"incomplete_results":false');
      expect(output).toContain('No matching items in this page');
      expect(output).not.toContain('NOT_COVERED');
    },
  );

  it('labels unknown coverage explicitly without claiming an empty page is exhaustive', async () => {
    mocks.callTool.mockResolvedValue({
      content: [],
      structuredContent: { items: [] },
    });
    const { run, registry } = setup();
    const output = await run('search_issues', { query: 'term', repository: 'microsoft/aspire' });
    expect(output).toContain('"total_count":"unknown","incomplete_results":"unknown"');
    expect(output).toContain('not an exhaustive report');
    expect(registry.all).toHaveLength(1);
  });

  it('does not manufacture empty-search evidence for malformed successful results', async () => {
    mocks.callTool.mockResolvedValue({ content: [{ type: 'text', text: 'Unrecognized result' }] });
    const { run, registry } = setup();
    const output = await run('search_issues', { query: 'term' });
    expect(output).toContain('"total_count":"unknown","incomplete_results":"unknown"');
    expect(registry.all).toHaveLength(0);
  });

  it('registers no zero-result citation when the call fails or its budget is exhausted', async () => {
    mocks.callTool.mockResolvedValue({
      isError: true,
      content: [{ type: 'text', text: '{"items":[],"total_count":0}' }],
    });
    const { run, registry } = setup(1);
    await expect(run('search_issues', { query: 'term' })).rejects.toThrow(
      'GitHub MCP tool failed.',
    );
    expect(registry.all).toHaveLength(0);
    expect(await run('search_issues', { query: 'term' })).toContain('budget exhausted');
    expect(registry.all).toHaveLength(0);
  });

  it('does not cache or expose error payloads and permits a subsequent successful retry', async () => {
    mocks.callTool.mockResolvedValueOnce({
      isError: true,
      content: [{ type: 'text', text: 'Authorization failed: test-secret-token' }],
    });
    const { run } = setup();
    const input = { query: 'term', repository: 'microsoft/aspire' };
    await expect(run('search_issues', input)).rejects.toThrow(/^GitHub MCP tool failed\.$/u);
    expect(await run('search_issues', input)).toContain('Example issue');
    expect(mocks.callTool).toHaveBeenCalledTimes(2);
    await run('search_issues', input);
    expect(mocks.callTool).toHaveBeenCalledTimes(2);
  });

  it('keeps transport read-only and restricts its existing tool allowlist', async () => {
    const { run } = setup();
    await run('search_issues', { query: 'term' });
    const options = mocks.transport.mock.calls[0]?.[1] as {
      requestInit: { headers: Record<string, string> };
      onInsufficientScope: string;
      authProvider: { token: () => Promise<string> };
    };
    expect(options.requestInit.headers).toEqual({
      'X-MCP-Readonly': 'true',
      'X-MCP-Tools':
        'get_commit,get_file_contents,get_latest_release,get_repository_tree,issue_read,list_releases,pull_request_read,search_code,search_issues,search_pull_requests',
    });
    expect(options.onInsufficientScope).toBe('throw');
    expect(await options.authProvider.token()).toBe(config.token);
  });

  it('returns no tools when no token is configured', () => {
    const client = new GitHubMcpClient({ ...config, token: '' }, logger);
    expect(client.createTools(new CitationRegistry(), new ToolBudget(5))).toEqual([]);
    expect(mocks.transport).not.toHaveBeenCalled();
  });
});

describe('GitHubMcpClient cancellation', () => {
  const requests = [
    ['search_code', { query: 'term' }],
    ['search_issues', { query: 'term' }],
    ['search_pull_requests', { query: 'term' }],
    ['get_file_contents', { path: 'README.md', repository: 'microsoft/aspire' }],
    ['issue_read', { issueNumber: 42, includeComments: true, repository: 'microsoft/aspire' }],
    ['pull_request_read', { pullNumber: 42, method: 'get', repository: 'microsoft/aspire' }],
    ['get_commit', { sha: 'abcdef123', repository: 'microsoft/aspire' }],
    ['get_repository_tree', { repository: 'microsoft/aspire' }],
    ['get_latest_release', { repository: 'microsoft/aspire' }],
  ] as const;

  it.each(requests)('aborts %s before consuming budget or connecting', async (name, input) => {
    const controller = new AbortController();
    controller.abort();
    const { run, budget } = setup(0, controller.signal);
    await expect(run(name, input)).rejects.toThrow();
    expect(budget.used).toBe(0);
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it.each(requests)(
    'propagates cancellation through every %s call and connect',
    async (name, input) => {
      const controller = new AbortController();
      const { run } = setup(10, controller.signal);
      await run(name, input);
      controller.abort();
      expect(mocks.connect.mock.calls[0]?.[1].signal.aborted).toBe(true);
      expect(mocks.listTools.mock.calls[0]?.[1].signal.aborted).toBe(true);
      for (const call of mocks.callTool.mock.calls) {
        expect(call[1].signal.aborted).toBe(true);
      }
    },
  );

  it('does not return cached results after cancellation', async () => {
    const controller = new AbortController();
    const { run } = setup(10, controller.signal);
    const input = { query: 'term', repository: 'microsoft/aspire' };
    await run('search_issues', input);
    controller.abort();
    await expect(run('search_issues', input)).rejects.toThrow();
    expect(mocks.callTool).toHaveBeenCalledTimes(1);
  });

  it('does not execute the second repository after cancellation during the first call', async () => {
    const controller = new AbortController();
    mocks.callTool.mockImplementationOnce(async () => {
      controller.abort();
      return result();
    });
    const { run } = setup(10, controller.signal);
    await expect(run('search_issues', { query: 'term' })).rejects.toThrow();
    expect(mocks.callTool).toHaveBeenCalledTimes(1);
  });

  it('aborts linked and latest-release helpers before their budget handlers', async () => {
    const controller = new AbortController();
    controller.abort();
    const { client, registry, budget } = setup(0);
    await expect(
      client.readLinkedContext(
        'https://github.com/microsoft/aspire/issues/42',
        registry,
        budget,
        controller.signal,
      ),
    ).rejects.toThrow();
    await expect(
      client.readLatestReleaseContext(registry, budget, controller.signal),
    ).rejects.toThrow();
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it('keeps latest-release version and citation behavior unchanged', async () => {
    mocks.callTool.mockResolvedValue({
      content: [{ type: 'text', text: '{"tag_name":"v13.4.0"}' }],
    });
    const { client, registry, budget } = setup();
    const context = await client.readLatestReleaseContext(registry, budget);
    expect(context?.releaseVersion).toBe('13.4.0');
    expect(context?.releaseCitationNumber).toBe(1);
    expect(registry.all[0]?.url).toBe('https://github.com/microsoft/aspire/releases/latest');
  });
});
