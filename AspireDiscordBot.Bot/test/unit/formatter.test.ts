import { describe, expect, it } from 'vitest';
import { buildAnswerEmbed } from '../../src/discord/formatter.js';

describe('buildAnswerEmbed', () => {
  it('renders grounded citations within Discord limits', () => {
    const embed = buildAnswerEmbed('How?', {
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
    }).toJSON();

    expect(embed.color).toBe(0x512bd4);
    expect(embed.fields?.[0]?.value).toContain('[API (reference)]');
    expect(embed.footer?.text).toContain('microsoft/aspire');
  });

  it('renders an ungrounded answer without a sources field', () => {
    const embed = buildAnswerEmbed('Unknown?', {
      answer: 'Not covered.',
      citations: [],
      isGrounded: false,
      topScore: 0,
    }).toJSON();

    expect(embed.color).toBe(0x9e9e9e);
    expect(embed.fields).toBeUndefined();
  });
});
