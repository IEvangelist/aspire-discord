// Evaluated from the staged bot's working directory; never logs retrieved content.
const fail = () => { console.log('ASPIRE_STAGED_FEATURES_FAILED'); process.exit(1); };
setTimeout(fail, 90_000);
(async () => {
  const { loadConfig } = await import('./dist/src/config.js');
  const { GitHubActivityReader } = await import('./dist/src/agent/github-activity.js');
  const { GitHubReadService } = await import('./dist/src/agent/github-read-service.js');
  const config = loadConfig();
  if (config.discord.token || !config.githubMcp.token || !config.issues.keyId || !config.issues.tableEndpoint) throw Error();
  const logger = Object.fromEntries(['info', 'warn', 'error', 'debug', 'trace', 'fatal'].map(k => [k, () => {}]));
  const boundedFetch = (url, options = {}) => fetch(url, {
    ...options,
    signal: AbortSignal.any([AbortSignal.timeout(10_000), ...(options.signal ? [options.signal] : [])]),
  });
  const reader = new GitHubActivityReader(config.githubMcp, logger, boundedFetch);
  const forbidden = () => { throw Error(); };
  const service = new GitHubReadService(reader, { createTools: forbidden }, { complete: forbidden }, logger, 1);
  const answer = await service.tryAnswer('look at issue reports from afscrome this month', AbortSignal.timeout(65_000));
  if (answer?.source !== 'github' || !answer.isGrounded || /NOT_COVERED|partial:/i.test(answer.answer)) throw Error();
  for (const repo of ['microsoft/aspire', 'microsoft/aspire.dev']) {
    if (!answer.answer.includes(repo) || !answer.citations.some(c => c.repo === repo)) throw Error();
  }
  const { GitHubMcpClient } = await import('./dist/src/agent/github-mcp.js');
  const { CitationRegistry } = await import('./dist/src/citations.js');
  const { ToolBudget } = await import('./dist/src/agent/tool-budget.js');
  const mcp = new GitHubMcpClient(config.githubMcp, logger);
  try {
    const citations = new CitationRegistry();
    const tool = mcp.createTools(citations, new ToolBudget(2), AbortSignal.timeout(30_000))
      .find(t => t.name === 'search_issues');
    const evidence = await tool.handler({ query: 'author:afscrome', page: 1, perPage: 1 }, {});
    for (const repo of ['microsoft/aspire', 'microsoft/aspire.dev']) {
      if (!evidence.includes(repo) || !citations.all.some(c => c.repo === repo)) throw Error();
    }
  } finally { await mcp.close(); }
  if (config.issues.tableEndpoint) {
    if (!process.env.AZURE_CLIENT_ID) throw Error();
    const { TableClient } = await import('@azure/data-tables');
    const { ManagedIdentityCredential } = await import('@azure/identity');
    const table = new TableClient(config.issues.tableEndpoint, config.issues.tableName,
      new ManagedIdentityCredential({ clientId: process.env.AZURE_CLIENT_ID }),
      { retryOptions: { maxRetries: 0 }, allowInsecureConnection: false });
    await table.listEntities({
      queryOptions: { top: 1, select: ['PartitionKey', 'RowKey'] },
      abortSignal: AbortSignal.timeout(10_000),
    }).next();
  }
  console.log('ASPIRE_STAGED_FEATURES_OK');
  process.exit(0);
})().catch(fail);
