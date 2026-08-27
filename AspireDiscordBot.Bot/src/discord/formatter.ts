import { EmbedBuilder } from 'discord.js';
import type { GroundedAnswer } from '../domain.js';

const groundedColor = 0x512bd4;
const notFoundColor = 0x9e9e9e;

export function buildAnswerEmbed(question: string, answer: GroundedAnswer): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(answer.isGrounded ? groundedColor : notFoundColor)
    .setTitle(truncate(`❓ ${question}`, 256))
    .setDescription(truncate(answer.answer, 4_000))
    .setFooter({ text: 'Grounded in microsoft/aspire & aspire.dev' })
    .setTimestamp();

  if (answer.isGrounded && answer.citations.length > 0) {
    const sources = answer.citations
      .slice(0, 5)
      .map(
        (citation) =>
          `[${String(citation.number)}] [${truncate(sanitizeTitle(citation.title), 100)}](${citation.url})`,
      )
      .join('\n');
    embed.addFields({ name: 'Sources', value: truncate(sources, 1_000) });
  }

  return embed;
}

function sanitizeTitle(value: string): string {
  return value.replaceAll('[', '(').replaceAll(']', ')');
}

function truncate(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}
