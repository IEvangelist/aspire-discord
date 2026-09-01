import { describe, expect, it } from 'vitest';
import { buildAnswerMessages } from '../../src/discord/formatter.js';

describe('buildAnswerMessages', () => {
  it('renders a grounded answer as a full-width Markdown message', () => {
    const messages = buildAnswerMessages('How?', {
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

    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('### ❓ How?');
    expect(messages[0]).toContain('Use the documented API. [1]');
    expect(messages[0]).toContain('[API (reference)]');
    expect(messages[0]).toContain('Grounded in microsoft/aspire & aspire.dev');
  });

  it('renders an ungrounded answer without a sources section', () => {
    const [message] = buildAnswerMessages('Unknown?', {
      answer: 'Not covered.',
      citations: [],
      isGrounded: false,
      topScore: 0,
    });

    expect(message).not.toContain('**Sources**');
    expect(message).toContain('No matching coverage found');
  });

  it('escapes user-controlled Markdown in the echoed question', () => {
    const [message] = buildAnswerMessages('**bold** [link](https://example.com)', {
      answer: 'Answer.',
      citations: [],
      isGrounded: false,
      topScore: 0,
    });

    expect(message).toContain('\\*\\*bold\\*\\*');
    expect(message).not.toContain('### ❓ **bold**');
  });

  it('redacts credentials from the echoed question', () => {
    const [message] = buildAnswerMessages('password=super-secret-value', {
      answer: 'Answer.',
      citations: [],
      isGrounded: false,
      topScore: 0,
    });

    expect(message).not.toContain('super-secret-value');
    expect(message).toContain('[REDACTED]');
  });

  it('surfaces bounded context degradation notices', () => {
    const [message] = buildAnswerMessages('Why?', {
      answer: 'Use AddRedis. [1]',
      citations: [],
      isGrounded: true,
      notices: [
        'An optional image could not be read safely and was omitted.',
        'Thread history could not be read and was omitted from this answer.',
      ],
      topScore: 0.9,
    });

    expect(message).toContain('Context note: An optional image');
    expect(message).toContain('Context note: Thread history');
  });

  it('summarizes notice overflow instead of silently dropping it', () => {
    const [message] = buildAnswerMessages('Why?', {
      answer: 'Answer.',
      citations: [],
      isGrounded: false,
      notices: Array.from({ length: 7 }, (_, index) => `Limitation ${String(index + 1)}`),
      topScore: 0,
    });

    expect(message).toContain('Limitation 5');
    expect(message).toContain('2 additional context limitations were also applied');
  });

  it('splits long answers within Discord limits and balances code fences', () => {
    const code = Array.from(
      { length: 180 },
      (_, index) => `const value${String(index)} = ${String(index)};`,
    ).join('\n');
    const messages = buildAnswerMessages('Show a long example', {
      answer: `Start here.\n\n\`\`\`ts\n${code}\n\`\`\`\n\nFinished.`,
      citations: [],
      isGrounded: true,
      topScore: 0.9,
    });

    expect(messages.length).toBeGreaterThan(1);
    expect(messages.at(-1)).toContain('Finished.');
    for (const message of messages) {
      expect(message.length).toBeLessThanOrEqual(2_000);
      expect((message.match(/```/gu) ?? []).length % 2).toBe(0);
    }
  });
});
