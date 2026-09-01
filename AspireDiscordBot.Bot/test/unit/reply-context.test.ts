import { MessageReferenceType } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import {
  readForwardedContext,
  readReplyContext,
  readSelectedMessageContext,
} from '../../src/discord/reply-context.js';
import type { ThreadMessageSnapshot } from '../../src/discord/context-reader.js';
import type { DiscordAttachmentSnapshot } from '../../src/discord/image-context.js';
import { testLogger } from '../helpers/logger.js';

function attachment(id: string, name: string, contentType: string): DiscordAttachmentSnapshot {
  return {
    contentType,
    height: contentType.startsWith('image/') ? 100 : null,
    id,
    name,
    size: 100,
    url: `https://cdn.discordapp.com/attachments/123/${id}/${name}`,
    width: contentType.startsWith('image/') ? 100 : null,
  };
}

function message(
  content: string,
  bot = false,
  attachments: readonly DiscordAttachmentSnapshot[] = [],
): ThreadMessageSnapshot {
  return {
    ...(attachments.length > 0
      ? { attachments: new Map(attachments.map((item) => [item.id, item])) }
      : {}),
    author: { bot, id: bot ? 'aspirey' : 'user' },
    cleanContent: content,
    content,
    createdTimestamp: 100,
    id: 'message-1',
  };
}

describe('reply and forwarded context', () => {
  it('returns no context when the message is not a reply or forward', async () => {
    expect(
      await readReplyContext(
        {
          fetchReference: vi.fn(async () => message('unused')),
          reference: null,
        },
        'aspirey',
        testLogger,
      ),
    ).toMatchObject({ status: 'none' });
    expect(readForwardedContext({})).toMatchObject({ status: 'none' });
  });

  it('uses a replied-to user question and its validated media as explicit context', async () => {
    const result = await readReplyContext(
      {
        fetchReference: vi.fn(async () =>
          message('Why does AddRedis fail?', false, [
            attachment('456', 'error.png', 'image/png'),
            attachment('457', 'trace.log', 'text/plain'),
          ]),
        ),
        reference: { messageId: 'message-1', type: MessageReferenceType.Default },
      },
      'aspirey',
      testLogger,
    );

    expect(result.question).toBe('Why does AddRedis fail?');
    expect(result.context).toContain('[Replied-to user message]');
    expect(result.images[0]?.explicit).toBe(true);
    expect(result.files[0]?.explicit).toBe(true);
  });

  it('uses a replied-to assistant answer as context but not as the fallback question', async () => {
    const result = await readReplyContext(
      {
        fetchReference: vi.fn(async () => message('Use AddRedis. [1]', true)),
        reference: { messageId: 'message-1', type: MessageReferenceType.Default },
      },
      'aspirey',
      testLogger,
    );

    expect(result.context).toContain('[Replied-to assistant answer]');
    expect(result.question).toBeUndefined();
  });

  it('degrades visibly when a reply target cannot be fetched', async () => {
    const result = await readReplyContext(
      {
        fetchReference: vi.fn(async () => {
          throw new Error('missing');
        }),
        reference: { messageId: 'missing', type: MessageReferenceType.Default },
      },
      'aspirey',
      testLogger,
    );

    expect(result.status).toBe('error');
    expect(result.notices[0]).toContain('could not be read');
  });

  it('captures one immutable forwarded snapshot without author attribution', () => {
    const result = readForwardedContext({
      messageSnapshots: new Map([
        [
          'snapshot',
          {
            attachments: new Map([['456', attachment('456', 'trace.log', 'text/plain')]]),
            content: 'Forwarded Aspire failure details.',
            createdTimestamp: 100,
          },
        ],
      ]),
    });

    expect(result.context).toContain('[Forwarded message]');
    expect(result.context).not.toContain('Original poster');
    expect(result.question).toContain('Forwarded Aspire failure');
    expect(result.files[0]?.source).toBe('forwarded message');
  });

  it('does not fetch a forwarded message reference when a snapshot owns the context', async () => {
    const fetchReference = vi.fn(async () => message('must not fetch'));
    const result = await readReplyContext(
      {
        fetchReference,
        reference: { messageId: 'source', type: MessageReferenceType.Forward },
      },
      'aspirey',
      testLogger,
    );

    expect(result.status).toBe('none');
    expect(fetchReference).not.toHaveBeenCalled();
  });

  it('marks media-only selected messages as requiring their attachment', () => {
    const result = readSelectedMessageContext(
      message('', false, [attachment('456', 'error.png', 'image/png')]),
      'aspirey',
    );

    expect(result.question).toBeUndefined();
    expect(result.requiresAttachment).toBe(true);
    expect(result.images[0]?.source).toBe('current question');
  });

  it('labels selected bot output without treating it as the question', () => {
    const result = readSelectedMessageContext(message('CI bot output', true), 'different-bot');

    expect(result.context).toContain('[Selected bot message]');
    expect(result.question).toBeUndefined();
  });
});
