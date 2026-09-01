import { describe, expect, it } from 'vitest';
import { buildAnswerThread } from '../../src/discord/formatter.js';

describe('buildAnswerThread', () => {
  it('separates a grounded answer from its source reply', () => {
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
    expect(formatted.detailMessages[0]).toContain('**Grounded sources**');
    expect(formatted.detailMessages[0]).toContain('[API (reference)]');
    expect(formatted.detailMessages[0]).toContain('Grounded in microsoft/aspire & aspire.dev');
  });

  it('renders ungrounded status as a separate reply without a sources section', () => {
    const formatted = buildAnswerThread('Unknown?', {
      answer: 'Not covered.',
      citations: [],
      isGrounded: false,
      topScore: 0,
    });

    expect(formatted.answerMessages[0]).not.toContain('Grounded sources');
    expect(formatted.detailMessages[0]).not.toContain('Grounded sources');
    expect(formatted.detailMessages[0]).toContain('No matching coverage found');
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
    expect(detailMessages[0]).toContain('Context note: An optional image');
    expect(detailMessages[0]).toContain('Context note: Thread history');
  });

  it('summarizes notice overflow instead of silently dropping it', () => {
    const { detailMessages } = buildAnswerThread('Why?', {
      answer: 'Answer.',
      citations: [],
      isGrounded: false,
      notices: Array.from({ length: 7 }, (_, index) => `Limitation ${String(index + 1)}`),
      topScore: 0,
    });

    expect(detailMessages[0]).toContain('Limitation 5');
    expect(detailMessages[0]).toContain('2 additional context limitations were also applied');
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
    for (const message of [...formatted.answerMessages, ...formatted.detailMessages]) {
      expect(message.length).toBeLessThanOrEqual(2_000);
      expect((message.match(/```/gu) ?? []).length % 2).toBe(0);
    }
  });
});
