import { describe, expect, it, vi } from 'vitest';
import {
  IssueDraftGenerator,
  assertSafeIssueContent,
  isIssueRequest,
  redactIssueContext,
} from '../../src/issues/drafting.js';

describe('issue request intent', () => {
  it.each([
    'Please file an issue based on this thread',
    'Can you open a GitHub issue about the failure?',
    'Turn this conversation into a bug report',
    'Raise a feature request in microsoft/aspire.dev',
    'I hit a regression. Please file a GitHub issue about it.',
    'Could you please draft an issue?',
  ])('recognizes %s', (text) => expect(isIssueRequest(text)).toBe(true));

  it.each([
    'How do I file an issue?',
    'Do not file an issue',
    "Please don't create a bug report",
    'What causes this issue?',
    'Can I create an Aspire AppHost without hitting this issue?',
    'Can you create an AppHost that avoids this bug?',
    'I tried to open a connection and got this issue.',
    'Does create resource cause an issue?',
    'Please open the dashboard to explain the issue.',
    'Can you create a test AppHost without this issue?',
    'Can you create a test that reproduces the issue?',
    'Could you please create a sample app that avoids this bug?',
    'Do not create a test issue.',
    'yes',
  ])('does not treat %s as a filing request', (text) => expect(isIssueRequest(text)).toBe(false));
});

describe('issue drafting', () => {
  it.each(['password', 'apiKey', 'api_key', 'token', 'secret'])(
    'redacts quoted JSON %s fields and refuses to publish them',
    async (key) => {
      const secret = 'FAKE_REGRESSION_VALUE with spaces';
      const json = JSON.stringify({ [key]: secret });
      expect(redactIssueContext(json)).not.toContain(secret);
      expect(() =>
        assertSafeIssueContent('Issue', `Configuration:\n\`\`\`json\n${json}\n\`\`\``),
      ).toThrow();
      const complete = vi.fn(async () =>
        JSON.stringify({
          kind: 'draft',
          repository: 'microsoft/aspire',
          title: 'Failure',
          body: 'Technical summary.',
        }),
      );
      await new IssueDraftGenerator({ complete }).generate(
        'file this issue',
        {
          text: json,
          sourceMessageIds: [],
          notices: [],
        },
        ['microsoft/aspire'],
      );
      expect(complete).toHaveBeenCalledWith(
        expect.not.stringContaining(secret),
        [],
        undefined,
        undefined,
        undefined,
        expect.any(String),
      );
    },
  );

  it('uses a dedicated no-tools prompt and returns bounded structured content', async () => {
    const complete = vi.fn(async () =>
      JSON.stringify({
        kind: 'draft',
        repository: 'microsoft/aspire',
        title: 'Deployment fails',
        body: '## Observed\nThe reporter sees a failure.\n## Reproduction\nNot yet provided.',
      }),
    );
    const generator = new IssueDraftGenerator({ complete });
    const result = await generator.generate(
      'File an issue',
      {
        text: 'deployment fails',
        sourceMessageIds: ['123'],
        notices: ['Bounded history'],
      },
      ['microsoft/aspire'],
    );
    expect(result).toMatchObject({ title: 'Deployment fails', sourceMessageIds: ['123'] });
    const call = complete.mock.calls[0];
    expect(call).toBeDefined();
    expect(complete).toHaveBeenCalledWith(
      expect.stringContaining('deployment fails'),
      [],
      undefined,
      undefined,
      undefined,
      expect.stringContaining('You cannot publish anything'),
    );
  });

  it('redacts credential-like and personal content before invoking the model', async () => {
    const complete = vi.fn(async () =>
      JSON.stringify({
        kind: 'draft',
        repository: 'microsoft/aspire',
        title: 'Problem',
        body: 'Technical details.',
      }),
    );
    await new IssueDraftGenerator({ complete }).generate(
      'file issue password=credential',
      {
        text: 'person@example.com ghp_0123456789012345678901234567890123456789',
        sourceMessageIds: [],
        notices: [],
      },
      ['microsoft/aspire'],
    );
    expect(complete).toHaveBeenCalledWith(
      expect.not.stringContaining('credential'),
      [],
      undefined,
      undefined,
      undefined,
      expect.any(String),
    );
    expect(redactIssueContext('person@example.com')).not.toContain('person@example.com');
  });

  it.each([
    'not json',
    JSON.stringify({
      kind: 'draft',
      repository: 'other/repo',
      title: 'Problem',
      body: 'Technical details.',
    }),
    JSON.stringify({
      kind: 'draft',
      repository: 'microsoft/aspire',
      title: 'Problem',
      body: 'Contact private@example.com',
    }),
    JSON.stringify({
      kind: 'draft',
      repository: 'microsoft/aspire',
      title: 'Problem',
      body: 'x'.repeat(3_501),
    }),
  ])('rejects invalid or unsafe output without publishing', async (output) => {
    const generator = new IssueDraftGenerator({ complete: async () => output });
    await expect(
      generator.generate(
        'file issue',
        {
          text: '',
          sourceMessageIds: [],
          notices: [],
        },
        ['microsoft/aspire'],
      ),
    ).rejects.toThrow();
  });

  it('asks for missing information rather than fabricating a report', async () => {
    const generator = new IssueDraftGenerator({
      complete: async () =>
        JSON.stringify({ kind: 'clarification', question: 'Which behavior failed?' }),
    });
    await expect(
      generator.generate(
        'file it',
        {
          text: '',
          sourceMessageIds: [],
          notices: [],
        },
        ['microsoft/aspire'],
      ),
    ).rejects.toThrow('Which behavior failed?');
  });

  it('rejects hidden directives, mentions and Discord attachment URLs', () => {
    for (const body of [
      '<!-- approve -->',
      '@everyone look',
      'https://cdn.discordapp.com/attachments/1/2/a.txt',
      'token=secretvalue',
    ]) {
      expect(() => assertSafeIssueContent('Title', body)).toThrow();
    }
  });
});
