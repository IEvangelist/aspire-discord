import { describe, expect, it } from 'vitest';
import {
  emptyObservation,
  resolveModalities,
  type QuestionSource,
} from '../../src/discord/modality-resolver.js';
import type { DiscordImageCandidate } from '../../src/discord/image-context.js';
import type { MessageObservation } from '../../src/discord/reply-context.js';
import type { DiscordTextCandidate } from '../../src/discord/text-context.js';

function observation(
  question: string | undefined,
  label: string,
  overrides: Partial<MessageObservation> = {},
): MessageObservation {
  return {
    ...emptyObservation(),
    context: `[${label}]\nContext`,
    ...(question ? { question } : {}),
    status: 'found',
    ...overrides,
  };
}

describe('modality resolver scenario matrix', () => {
  it.each<{
    expected: string;
    source: QuestionSource;
    title: string;
    value: Parameters<typeof resolveModalities>[0];
  }>([
    {
      expected: 'Current question',
      source: 'current',
      title: 'substantive current text outranks every context source',
      value: {
        forwarded: observation('Forwarded question', 'Forwarded'),
        reply: observation('Reply question', 'Reply'),
        selected: observation('Selected question', 'Selected'),
        thread: { question: 'Thread question', status: 'found' },
        typed: 'Current question',
      },
    },
    {
      expected: 'Selected question',
      source: 'selected',
      title: 'message context-menu selection outranks other fallbacks',
      value: {
        forwarded: observation('Forwarded question', 'Forwarded'),
        reply: observation('Reply question', 'Reply'),
        selected: observation('Selected question', 'Selected'),
        thread: { question: 'Thread question', status: 'found' },
        typed: '',
      },
    },
    {
      expected: 'Forwarded question',
      source: 'forwarded',
      title: 'forwarded current content outranks a reply and thread',
      value: {
        forwarded: observation('Forwarded question', 'Forwarded'),
        reply: observation('Reply question', 'Reply'),
        thread: { question: 'Thread question', status: 'found' },
        typed: '',
      },
    },
    {
      expected: 'Reply question',
      source: 'reply',
      title: 'reply target outranks thread history',
      value: {
        reply: observation('Reply question', 'Reply'),
        thread: { question: 'Thread question', status: 'found' },
        typed: 'answer the message above',
      },
    },
    {
      expected: 'Thread question',
      source: 'thread',
      title: 'bare slash command resolves to latest thread question',
      value: {
        thread: { context: 'Thread context', question: 'Thread question', status: 'found' },
        typed: '',
      },
    },
  ])('$title', ({ expected, source, value }) => {
    const result = resolveModalities(value);

    expect(result.question).toBe(expected);
    expect(result.questionSource).toBe(source);
    expect(result.displayQuestion).toBe(
      source === 'current' || source === 'thread'
        ? expected
        : `Question from ${source === 'reply' ? 'replied-to' : source} message`,
    );
  });

  it('fails closed when explicit current media is unsupported instead of falling back', () => {
    const result = resolveModalities({
      directNotices: ['Audio attachments are not transcribed.'],
      thread: { context: 'Old context', question: 'Old question', status: 'found' },
      typed: '',
    });

    expect(result.question).toBeUndefined();
    expect(result.problem).toContain('Audio attachments');
  });

  it('treats current media-only input as the active question instead of stale thread text', () => {
    const image: DiscordImageCandidate = {
      attachment: {
        contentType: 'image/png',
        height: 10,
        id: '10',
        name: 'error.png',
        size: 10,
        url: 'https://cdn.discordapp.com/attachments/1/10/error.png',
        width: 10,
      },
      explicit: true,
      source: 'current question',
    };
    const result = resolveModalities({
      directImages: [image],
      thread: { context: 'Old context', question: 'Old question', status: 'found' },
      typed: '',
    });

    expect(result.questionSource).toBe('current');
    expect(result.question).toContain('provided context');
    expect(result.requiresProcessedAttachment).toBe(true);
  });

  it('fails closed when an explicit reply target cannot be loaded', () => {
    const result = resolveModalities({
      reply: {
        ...emptyObservation(),
        notices: ['The replied-to message could not be read.'],
        status: 'error',
      },
      thread: { context: 'Old context', question: 'Old question', status: 'found' },
      typed: '',
    });

    expect(result.question).toBeUndefined();
    expect(result.problem).toContain('replied-to message');
  });

  it('uses current media even when a lower-precedence reply cannot be loaded', () => {
    const file: DiscordTextCandidate = {
      attachment: {
        contentType: 'text/plain',
        height: null,
        id: '11',
        name: 'trace.log',
        size: 10,
        url: 'https://cdn.discordapp.com/attachments/1/11/trace.log',
        width: null,
      },
      explicit: true,
      source: 'current question',
    };
    const result = resolveModalities({
      directFiles: [file],
      reply: {
        ...emptyObservation(),
        notices: ['The replied-to message could not be read.'],
        status: 'error',
      },
      thread: { context: 'Old context', question: 'Old question', status: 'found' },
      typed: '',
    });

    expect(result.questionSource).toBe('current');
    expect(result.requiresProcessedAttachment).toBe(true);
  });

  it('uses a forwarded snapshot when its selected wrapper is empty', () => {
    const result = resolveModalities({
      forwarded: observation('Forwarded question', 'Forwarded'),
      selected: { ...emptyObservation(), status: 'empty' },
      thread: { context: 'Old context', question: 'Old question', status: 'found' },
      typed: '',
    });

    expect(result.question).toBe('Forwarded question');
    expect(result.questionSource).toBe('forwarded');
  });

  it('does not fall back to thread history for an unsupported selected message', () => {
    const result = resolveModalities({
      selected: {
        ...emptyObservation(),
        notices: ['Audio attachments are not transcribed.'],
        status: 'found',
      },
      thread: { context: 'Old context', question: 'Old question', status: 'found' },
      typed: '',
    });

    expect(result.question).toBeUndefined();
    expect(result.problem).toContain('Audio attachments');
  });

  it('deduplicates reply text already present in thread history', () => {
    const result = resolveModalities({
      reply: observation('Reply question', 'Reply', { messageId: 'message-1' }),
      thread: {
        context: '[Thread]\nReply context already present',
        messageIds: new Set(['message-1']),
        status: 'found',
      },
      typed: '',
    });

    expect(result.context).not.toContain('[Reply]');
    expect(result.question).toBe('Reply question');
  });

  it('orders media deterministically by source precedence and merges notices', () => {
    const image = (id: string, source: DiscordImageCandidate['source']) =>
      ({
        attachment: {
          contentType: 'image/png',
          height: 10,
          id,
          name: `${id}.png`,
          size: 10,
          url: `https://cdn.discordapp.com/attachments/1/${id}/${id}.png`,
          width: 10,
        },
        explicit: source === 'current question',
        source,
      }) satisfies DiscordImageCandidate;
    const file = (id: string, source: DiscordTextCandidate['source']) =>
      ({
        attachment: {
          contentType: 'text/plain',
          height: null,
          id,
          name: `${id}.log`,
          size: 10,
          url: `https://cdn.discordapp.com/attachments/1/${id}/${id}.log`,
          width: null,
        },
        explicit: source === 'current question',
        source,
      }) satisfies DiscordTextCandidate;
    const result = resolveModalities({
      directFiles: [file('11', 'current question')],
      directImages: [image('10', 'current question')],
      reply: observation(undefined, 'Reply', {
        files: [file('21', 'replied-to message')],
        images: [image('20', 'replied-to message')],
        notices: ['Reply note'],
      }),
      thread: {
        files: [file('31', 'thread starter')],
        images: [image('30', 'thread starter')],
        notices: ['Thread note'],
        question: 'Question',
        status: 'found',
      },
      typed: '',
    });

    expect(result.imageCandidates?.map((candidate) => candidate.attachment.id)).toEqual([
      '10',
      '20',
      '30',
    ]);
    expect(result.fileCandidates?.map((candidate) => candidate.attachment.id)).toEqual([
      '11',
      '21',
      '31',
    ]);
    expect(result.notices).toEqual(['Reply note', 'Thread note']);
  });

  it('uses selected non-question content as a synthetic selected-message question', () => {
    const result = resolveModalities({
      selected: observation(undefined, 'Selected assistant answer'),
      thread: { status: 'not-a-thread' },
      typed: '',
    });

    expect(result.questionSource).toBe('selected');
    expect(result.question).toContain('provided context');
  });

  it('continues with current text and visibly degrades unavailable thread history', () => {
    const result = resolveModalities({
      thread: { status: 'forbidden' },
      typed: 'How do I add Redis?',
    });

    expect(result.questionSource).toBe('current');
    expect(result.notices?.[0]).toContain('Read Message History');
  });

  it.each([
    ['empty', "doesn't contain a readable"],
    ['error', 'could not be read'],
    ['forbidden', 'Read Message History'],
    ['not-a-thread', 'inside a forum post'],
    ['found', 'include a question'],
  ] as const)('maps unresolved %s thread state to actionable guidance', (status, expected) => {
    const result = resolveModalities({
      thread: { status },
      typed: '',
    });

    expect(result.questionSource).toBe('none');
    expect(result.problem).toContain(expected);
  });

  it('does not resolve a context-only phrase when no referenced context exists', () => {
    const result = resolveModalities({
      thread: { status: 'not-a-thread' },
      typed: 'answer the message above',
    });

    expect(result.question).toBeUndefined();
    expect(result.problem).toContain('forum post');
  });
});
