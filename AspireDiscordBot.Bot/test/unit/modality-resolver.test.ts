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
    display: string;
    source: QuestionSource;
    title: string;
    value: Parameters<typeof resolveModalities>[0];
  }>([
    {
      expected: 'Current question',
      display: 'Current question',
      source: 'current',
      title: 'substantive current text outranks every context source',
      value: {
        forwarded: observation('Forwarded question', 'Forwarded'),
        reply: observation('Reply question', 'Reply'),
        thread: { question: 'Thread question', referenceQuestion: 'Thread question', status: 'found' },
        typed: 'Current question',
      },
    },
    {
      expected: 'Please help answer the referenced Aspire question.',
      display: 'Forwarded question',
      source: 'forwarded',
      title: 'forwarded current content outranks a reply and thread',
      value: {
        forwarded: observation('Forwarded question', 'Forwarded'),
        reply: observation('Reply question', 'Reply'),
        thread: { question: 'Thread question', referenceQuestion: 'Thread question', status: 'found' },
        typed: '',
      },
    },
    {
      expected: 'Please answer the referenced Aspire question.',
      display: 'Reply question',
      source: 'current',
      title: 'reply target outranks thread history',
      value: {
        reply: observation('Reply question', 'Reply'),
        thread: { question: 'Thread question', referenceQuestion: 'Thread question', status: 'found' },
        typed: 'answer the message above',
      },
    },
    {
      expected: 'Please help answer the question in this Aspire thread.',
      display: 'How do I add Redis?',
      source: 'thread',
      title: 'bare mention resolves to latest thread question',
      value: {
        thread: { context: 'Thread context', question: 'How do I add Redis?', referenceQuestion: 'How do I add Redis?', status: 'found' },
        typed: '',
      },
    },
  ])('$title', ({ expected, display, source, value }) => {
    const result = resolveModalities(value);

    expect(result.question).toBe(expected);
    expect(result.questionSource).toBe(source);
    expect(result.displayQuestion).toBe(display);
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

  it('uses a forwarded snapshot before thread history', () => {
    const result = resolveModalities({
      forwarded: observation('Forwarded question', 'Forwarded'),
      thread: { context: 'Old context', question: 'Old question', status: 'found' },
      typed: '',
    });

    expect(result.question).toBe('Please help answer the referenced Aspire question.');
    expect(result.referencedQuestion).toBe('Forwarded question');
    expect(result.questionSource).toBe('forwarded');
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
    expect(result.question).toBe('Please help answer the referenced Aspire question.');
    expect(result.referencedQuestion).toBe('Reply question');
    expect(result.displayQuestion).toBe('Reply question');
  });

  it('uses the original question for a vague mention despite a later complaint in the thread', () => {
    const original = 'How can I keep custom Container Apps health probes across Aspire deployments?';
    const result = resolveModalities({
      typed: 'can you help',
      thread: {
        context: `[Original poster]\n${original}\n\n[Participant 1]\nThe bot was confused.`,
        question: 'The bot was confused.',
        starterQuestion: original,
        status: 'found',
      },
    });
    expect(result).toMatchObject({
      question: 'Please answer the referenced Aspire question.',
      displayQuestion: original,
      referencedQuestion: original,
      referenceSource: 'thread',
      questionSource: 'current',
      allowIssueDraft: false,
    });
  });

  it('anchors "this" to the replied-to question without inheriting its intent', () => {
    const original = 'How do I configure health-probe timings in Aspire?';
    const result = resolveModalities({
      typed: 'this',
      reply: observation(original, 'Replied-to user message'),
      thread: {
        context: '[Original poster]\nOther question',
        question: 'Other question',
        starterQuestion: 'Other question',
        status: 'found',
      },
    });
    expect(result).toMatchObject({
      question: 'Please answer the referenced Aspire question.',
      displayQuestion: original,
      referencedQuestion: original,
      referenceSource: 'reply',
      questionSource: 'current',
      allowIssueDraft: false,
    });
    const issue = resolveModalities({
      typed: 'create an issue about this',
      reply: observation(original, 'Replied-to user message'),
      thread: { status: 'not-a-thread' },
    });
    expect(issue.question).toBe('create an issue about this');
    expect(issue.displayQuestion).toBe('create an issue about this');
    expect(issue.allowIssueDraft).toBeUndefined();
    const fix = resolveModalities({
      typed: 'fix this',
      reply: observation(original, 'Replied-to user message'),
      thread: { status: 'not-a-thread' },
    });
    expect(fix.question).toBe('fix this');
    expect(fix.referencedQuestion).toBe(original);
    expect(fix.allowIssueDraft).toBeUndefined();
  });

  it('does not treat an old poster request to file an issue as the current request', () => {
    const result = resolveModalities({
      typed: '',
      thread: {
        context: '[Original poster]\nPlease file an issue about the failing health check.',
        question: 'Please file an issue about the failing health check.',
        referenceQuestion: 'Please file an issue about the failing health check.',
        starterQuestion: 'Please file an issue about the failing health check.',
        status: 'found',
      },
    });
    expect(result.question).toBe('Please help answer the question in this Aspire thread.');
    expect(result.allowIssueDraft).toBe(false);
    expect(result.referenceSource).toBe('thread');
    expect(result.referencedQuestion).toContain('Please file an issue');
  });

  it('does not elevate a vague forwarded message above a clear thread question', () => {
    const threadQuestion = 'How do I configure the Aspire health check?';
    const result = resolveModalities({
      typed: 'can you help',
      forwarded: observation('yeah', 'Forwarded'),
      thread: {
        context: `[Original poster]\n${threadQuestion}`,
        starterQuestion: threadQuestion,
        status: 'found',
      },
    });
    expect(result.displayQuestion).toBe(threadQuestion);
    expect(result.referenceSource).toBe('thread');
    expect(result.referencedQuestion).toBe(threadQuestion);
  });

  it('refuses to guess what "this" meant when its explicit reply cannot be fetched', () => {
    const result = resolveModalities({
      typed: 'this',
      reply: {
        ...emptyObservation(),
        notices: ['The replied-to message could not be read.'],
        status: 'error',
      },
      thread: {
        context: '[Original poster]\nAnother Aspire question',
        referenceQuestion: 'Another Aspire question',
        status: 'found',
      },
    });
    expect(result.question).toBeUndefined();
    expect(result.problem).toContain('replied-to message');
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
    ['not-a-thread', 'Reply to a message'],
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
