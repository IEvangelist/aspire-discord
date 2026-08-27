import { DiscordAPIError, type TextBasedChannel } from 'discord.js';
import type { Logger } from 'pino';

export type OriginalPostStatus = 'empty' | 'error' | 'forbidden' | 'found' | 'not-a-thread';

export interface OriginalPostResult {
  readonly question?: string;
  readonly status: OriginalPostStatus;
}

export async function readOriginalPost(
  channel: TextBasedChannel,
  maxLength: number,
  logger: Logger,
): Promise<OriginalPostResult> {
  if (!channel.isThread()) {
    return { status: 'not-a-thread' };
  }

  try {
    const starter = await channel.fetchStarterMessage();
    const cleanContent = starter?.cleanContent.trim();
    const rawContent = starter?.content.trim();
    const content = cleanContent ? cleanContent : rawContent;
    if (!content) {
      return { status: 'empty' };
    }
    return {
      question: content.slice(0, maxLength),
      status: 'found',
    };
  } catch (error) {
    if (isForbidden(error)) {
      logger.warn({ threadId: channel.id }, 'Discord denied access to the thread starter.');
      return { status: 'forbidden' };
    }
    logger.warn({ err: error, threadId: channel.id }, 'Unable to read the thread starter.');
    return { status: 'error' };
  }
}

function isForbidden(error: unknown): boolean {
  return error instanceof DiscordAPIError && (error.status === 403 || error.code === 50_013);
}
