import { describe, expect, it } from 'vitest';
import { buildAnswerThread } from '../../src/discord/formatter.js';

describe('buildAnswerThread', () => {
  it('renders a follow-up question as conversation rather than missing documentation', () => {
    const result = buildAnswerThread('create issue', {
      answer: 'Which repository?',
      citations: [],
      isGrounded: false,
      topScore: 0,
      source: 'conversation',
      requiresReply: true,
    });
    expect(result.answerMessages).toEqual(['Which repository?']);
    expect(result.detailMessages).toEqual([]);
  });
  it('never labels a failed or clarification-only GitHub lookup as missing documentation coverage', () => {
    const formatted = buildAnswerThread('Issues from a user?', {
      answer: 'Which GitHub username?',
      citations: [],
      isGrounded: false,
      topScore: 0,
      source: 'github',
    });
    expect(formatted.detailMessages[0]?.content).toContain('GitHub lookup');
    expect(formatted.detailMessages[0]?.content).not.toContain('No matching coverage');
  });
  it('keeps GitHub report citations in valid five-button rows', () => {
    const formatted = buildAnswerThread('Issue reports', {
      answer: 'Reported issues.',
      isGrounded: true,
      topScore: 0,
      source: 'github',
      citations: Array.from({ length: 22 }, (_, index) => ({
        number: index + 1,
        title: `Issue ${String(index + 1)}`,
        repo: 'microsoft/aspire',
        url: `https://github.com/microsoft/aspire/issues/${String(index + 1)}`,
      })),
    });
    expect(formatted.detailMessages[0]?.components).toHaveLength(5);
    expect(formatted.detailMessages[0]?.components?.map((row) => row.components.length)).toEqual([
      5, 5, 5, 5, 2,
    ]);
  });
  it('renders grounded sources as compact link buttons by default', () => {
    const formatted = buildAnswerThread('How?', {
      answer: 'Use the documented API. [1]',
      citations: [
        {
          number: 1,
          repo: 'microsoft/aspire',
          title: 'API [reference]',
          url: 'https://github.com/microsoft/aspire/blob/main/a.cs',
        },
      ],
      isGrounded: true,
      topScore: 0.9,
    });

    expect(formatted.answerMessages).toHaveLength(1);
    expect(formatted.answerMessages[0]).toContain('### ❓ How?');
    expect(formatted.answerMessages[0]).toContain('Use the documented API. [1]');
    expect(formatted.answerMessages[0]).not.toContain('Grounded sources');
    expect(formatted.detailMessages[0]?.content).toContain('1 grounded source');
    expect(formatted.detailMessages[0]?.content).not.toContain('[API (reference)]');
    expect(formatted.detailMessages[0]?.content).toContain(
      'Grounded in microsoft/aspire & aspire.dev',
    );
    expect(formatted.detailMessages[0]?.components?.[0]?.toJSON()).toMatchObject({
      components: [
        {
          label: '[1] API [reference]',
          style: 5,
          url: 'https://github.com/microsoft/aspire/blob/main/a.cs',
        },
      ],
      type: 1,
    });
  });

  it('supports expanded and hidden grounding details', () => {
    const answer = {
      answer: 'Use the documented API. [1]',
      citations: [
        {
          number: 1,
          repo: 'microsoft/aspire' as const,
          title: 'API reference',
          url: 'https://github.com/microsoft/aspire/blob/main/a.cs',
        },
      ],
      isGrounded: true,
      topScore: 0.9,
    };

    const expanded = buildAnswerThread('How?', answer, 'expanded');
    const hidden = buildAnswerThread('How?', answer, 'hidden');

    expect(expanded.detailMessages[0]?.content).toContain('**Grounded sources**');
    expect(expanded.detailMessages[0]?.content).toContain('[API reference]');
    expect(expanded.detailMessages[0]?.components).toBeUndefined();
    expect(hidden.detailMessages[0]?.content).not.toContain('Grounded sources');
    expect(hidden.detailMessages[0]?.components).toBeUndefined();
  });

  it('does not let an invalid citation URL break a collapsed answer', () => {
    const formatted = buildAnswerThread('How?', {
      answer: 'Use the documented API. [1]',
      citations: [
        {
          number: 1,
          repo: 'microsoft/aspire',
          title: 'Invalid source',
          url: 'javascript:alert(1)',
        },
      ],
      isGrounded: true,
      topScore: 0.9,
    });

    expect(formatted.answerMessages[0]).toContain('Use the documented API. [1]');
    expect(formatted.detailMessages[0]?.content).toContain('source links unavailable');
    expect(formatted.detailMessages[0]?.components).toBeUndefined();
  });

  it('renders ungrounded status as a separate reply without a sources section', () => {
    const formatted = buildAnswerThread('Unknown?', {
      answer: 'Not covered.',
      citations: [],
      isGrounded: false,
      topScore: 0,
    });

    expect(formatted.answerMessages[0]).not.toContain('Grounded sources');
    expect(formatted.detailMessages[0]?.content).not.toContain('Grounded sources');
    expect(formatted.detailMessages[0]?.content).toContain('No matching coverage found');
  });

  it('escapes user-controlled Markdown in the echoed question', () => {
    const { answerMessages } = buildAnswerThread('**bold** [link](https://example.com)', {
      answer: 'Answer.',
      citations: [],
      isGrounded: false,
      topScore: 0,
    });

    expect(answerMessages[0]).toContain('\\*\\*bold\\*\\*');
    expect(answerMessages[0]).not.toContain('### ❓ **bold**');
  });

  it('redacts credentials from the echoed question', () => {
    const { answerMessages } = buildAnswerThread('password = example-sensitive-value', {
      answer: 'Answer.',
      citations: [],
      isGrounded: false,
      topScore: 0,
    });

    expect(answerMessages[0]).not.toContain('example-sensitive-value');
    expect(answerMessages[0]).toContain('[REDACTED]');
  });

  it('surfaces bounded context degradation notices in the detail reply', () => {
    const { answerMessages, detailMessages } = buildAnswerThread('Why?', {
      answer: 'Use AddRedis. [1]',
      citations: [],
      isGrounded: true,
      notices: [
        'An optional image could not be read safely and was omitted.',
        'Thread history could not be read and was omitted from this answer.',
      ],
      topScore: 0.9,
    });

    expect(answerMessages[0]).not.toContain('Context note:');
    expect(detailMessages[0]?.content).toContain('Context note: An optional image');
    expect(detailMessages[0]?.content).toContain('Context note: Thread history');
  });

  it('summarizes notice overflow instead of silently dropping it', () => {
    const { detailMessages } = buildAnswerThread('Why?', {
      answer: 'Answer.',
      citations: [],
      isGrounded: false,
      notices: Array.from({ length: 7 }, (_, index) => `Limitation ${String(index + 1)}`),
      topScore: 0,
    });

    expect(detailMessages[0]?.content).toContain('Limitation 5');
    expect(detailMessages[0]?.content).toContain(
      '2 additional context limitations were also applied',
    );
  });

  it('splits long answers within Discord limits and balances code fences', () => {
    const code = Array.from(
      { length: 180 },
      (_, index) => `const value${String(index)} = ${String(index)};`,
    ).join('\n');
    const formatted = buildAnswerThread('Show a long example', {
      answer: `Start here.\n\n\`\`\`ts\n${code}\n\`\`\`\n\nFinished.`,
      citations: [],
      isGrounded: true,
      topScore: 0.9,
    });

    expect(formatted.answerMessages.length).toBeGreaterThan(1);
    expect(formatted.answerMessages.at(-1)).toContain('Finished.');
    const messages = [
      ...formatted.answerMessages,
      ...formatted.detailMessages.map((message) => message.content),
    ];
    for (const message of messages) {
      expect(message.length).toBeLessThanOrEqual(2_000);
      expect((message.match(/```/gu) ?? []).length % 2).toBe(0);
    }
  });
});
