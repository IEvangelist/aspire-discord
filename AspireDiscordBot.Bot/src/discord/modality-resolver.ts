import {
  needsConversationReferent,
  referencesThread,
} from './context-reference.js';
import type { ThreadContextResult } from './context-reader.js';
import type { DiscordImageCandidate } from './image-context.js';
import type { MessageObservation } from './reply-context.js';
import type { DiscordTextCandidate } from './text-context.js';

export type QuestionSource = 'current' | 'forwarded' | 'none' | 'reply' | 'thread';

export interface ModalityResolutionInput {
  readonly directFiles?: readonly DiscordTextCandidate[];
  readonly directImages?: readonly DiscordImageCandidate[];
  readonly directNotices?: readonly string[];
  readonly forwarded?: MessageObservation;
  readonly reply?: MessageObservation;
  readonly thread: ThreadContextResult;
  readonly typed: string;
}

export interface ResolvedModalityRequest {
  readonly allowIssueDraft?: boolean;
  readonly context?: string;
  readonly displayQuestion?: string;
  readonly fileCandidates?: readonly DiscordTextCandidate[];
  readonly imageCandidates?: readonly DiscordImageCandidate[];
  readonly notices?: readonly string[];
  readonly problem: string;
  readonly question?: string;
  readonly questionSource: QuestionSource;
  readonly referencedQuestion?: string;
  readonly referenceSource?: 'forwarded' | 'reply' | 'thread';
  readonly requiresProcessedAttachment?: boolean;
}

export function resolveModalities(input: ModalityResolutionInput): ResolvedModalityRequest {
  const directFiles = input.directFiles ?? [];
  const directImages = input.directImages ?? [];
  const directNotices = input.directNotices ?? [];
  const forwarded = input.forwarded ?? emptyObservation();
  const reply = input.reply ?? emptyObservation();
  const typed = input.typed.trim();

  const replyContext =
    reply.context && (!reply.messageId || !input.thread.messageIds?.has(reply.messageId))
      ? reply.context
      : '';
  const context = [input.thread.context, replyContext, forwarded.context]
    .filter(Boolean)
    .join('\n\n');
  const imageCandidates = [
    ...directImages,
    ...forwarded.images,
    ...reply.images,
    ...(input.thread.images ?? []),
  ];
  const fileCandidates = [
    ...directFiles,
    ...forwarded.files,
    ...reply.files,
    ...(input.thread.files ?? []),
  ];
  const notices = [
    ...directNotices,
    ...forwarded.notices,
    ...reply.notices,
    ...(input.thread.notices ?? []),
    ...threadReadNotices(input.thread.status),
  ];
  const reference = [
    { question: forwarded.question, source: 'forwarded' as const },
    { question: reply.question, source: 'reply' as const },
    {
      question: input.thread.starterQuestion ?? input.thread.referenceQuestion,
      source: 'thread' as const,
    },
  ].find((candidate) => candidate.question?.trim() &&
    !needsConversationReferent(candidate.question));
  const dependsOnContext = needsConversationReferent(typed);
  // Supplying a topic must not erase the current requester's action verb. The model still
  // decides which capability, if any, that request is allowed to use.
  const hasActionVerb =
    /\b(?:approve|cancel|change|close|create|delete|deploy|draft|edit|file|fix|merge|publish|remove|run|update)\b/iu.test(
      typed,
    );
  const answerOnly = !typed || (dependsOnContext && Boolean(reference?.question) && !hasActionVerb);
  if (dependsOnContext && reply.status === 'error' && directImages.length === 0 &&
      directFiles.length === 0 && forwarded.status === 'none') {
    return unresolved(reply.notices[0] ?? 'The replied-to message could not be read.');
  }

  const selection = selectQuestion(
    typed && answerOnly && reference?.question
      ? 'Please answer the referenced Aspire question.'
      : typed,
    directFiles,
    directImages,
    directNotices,
    forwarded,
    reply,
    input.thread,
  );
  if (typed && dependsOnContext && !reference && !context && imageCandidates.length === 0 &&
      fileCandidates.length === 0 && referencesThread(typed)) {
    return unresolved(notices[0] ?? threadContextProblem(input.thread.status));
  }
  if (selection.problem) {
    return unresolved(selection.problem);
  }
  const { question, questionSource } = selection;
  if (
    question &&
    (!referencesThread(typed) || context || imageCandidates.length > 0 || fileCandidates.length > 0)
  ) {
    const display = dependsOnContext && reference?.question
      ? reference.question.trim()
      : displayQuestion(question, questionSource);
    return {
      ...(context ? { context } : {}),
      ...(fileCandidates.length > 0 ? { fileCandidates } : {}),
      ...(imageCandidates.length > 0 ? { imageCandidates } : {}),
      ...(notices.length > 0 ? { notices: [...new Set(notices)] } : {}),
      displayQuestion: display,
      problem: '',
      question,
      questionSource,
      ...(reference?.question
        ? {
            referencedQuestion: reference.question.trim(),
            referenceSource: reference.source,
          }
        : {}),
      ...(answerOnly ? { allowIssueDraft: false } : {}),
      ...(selection.requiresProcessedAttachment ? { requiresProcessedAttachment: true } : {}),
    };
  }

  function displayQuestion(question: string, source: QuestionSource): string {
    switch (source) {
      case 'forwarded':
        return 'Question from forwarded message';
      case 'reply':
        return 'Question from replied-to message';
      case 'current':
      case 'thread':
        return question;
      case 'none':
        return 'Aspire question';
    }
  }

  if (typed && !referencesThread(typed)) {
    return unresolved("Please include an Aspire question and I'll answer from official sources.");
  }
  return unresolved(notices[0] ?? threadContextProblem(input.thread.status));
}

export function emptyObservation(): MessageObservation {
  return {
    files: [],
    images: [],
    notices: [],
    status: 'none',
  };
}

function selectQuestion(
  typed: string,
  directFiles: readonly DiscordTextCandidate[],
  directImages: readonly DiscordImageCandidate[],
  directNotices: readonly string[],
  forwarded: MessageObservation,
  reply: MessageObservation,
  thread: ThreadContextResult,
): {
  readonly problem?: string;
  readonly question?: string;
  readonly questionSource: QuestionSource;
  readonly requiresProcessedAttachment?: boolean;
} {
  if (typed) {
    return { question: typed, questionSource: 'current' };
  }
  if (directImages.length > 0 || directFiles.length > 0) {
    return syntheticQuestion('current', true);
  }
  if (directNotices.length > 0) {
    return {
      problem: directNotices[0] ?? 'The current attachment could not be processed.',
      questionSource: 'none',
    };
  }
  let problem: string | undefined;
  for (const [observation, source] of [
    [forwarded, 'forwarded'],
    [reply, 'reply'],
  ] as const) {
    const question = observation.question?.trim();
    if (question) {
      return {
        question: 'Please help answer the referenced Aspire question.',
        questionSource: source,
      };
    }
    if (observation.context || observation.images.length > 0 || observation.files.length > 0) {
      return syntheticQuestion(source, observation.requiresAttachment === true);
    }
    problem ??= observationProblem(observation, source);
  }
  if (problem) {
    return { problem, questionSource: 'none' };
  }
  const threadQuestion = thread.question?.trim();
  if (threadQuestion) {
    return {
      question: 'Please help answer the question in this Aspire thread.',
      questionSource: 'thread',
      ...(thread.questionRequiresAttachment ? { requiresProcessedAttachment: true } : {}),
    };
  }
  return { questionSource: 'none' };
}

function observationProblem(
  observation: MessageObservation,
  source: 'forwarded' | 'reply',
): string | undefined {
  if (observation.status === 'none') {
    return undefined;
  }
  if (observation.notices[0]) {
    return observation.notices[0];
  }
  switch (source) {
    case 'forwarded':
      return 'The forwarded message did not contain readable text or a supported attachment.';
    case 'reply':
      return observation.status === 'error'
        ? 'The replied-to message could not be read. Include the question directly.'
        : 'The replied-to message did not contain readable text or a supported attachment.';
  }
}

function syntheticQuestion(
  source: Exclude<QuestionSource, 'none' | 'thread'>,
  requiresProcessedAttachment: boolean,
): {
  readonly question: string;
  readonly questionSource: QuestionSource;
  readonly requiresProcessedAttachment?: boolean;
} {
  return {
    question: 'What does the provided context show about this issue in the Aspire application?',
    questionSource: source,
    ...(requiresProcessedAttachment ? { requiresProcessedAttachment: true } : {}),
  };
}

function unresolved(problem: string): ResolvedModalityRequest {
  return {
    problem,
    questionSource: 'none',
  };
}

function threadReadNotices(status: ThreadContextResult['status']): readonly string[] {
  switch (status) {
    case 'forbidden':
      return ['Thread history was unavailable because Read Message History is missing.'];
    case 'error':
      return ['Thread history could not be read and was omitted from this answer.'];
    case 'empty':
    case 'found':
    case 'not-a-thread':
      return [];
  }
}

function threadContextProblem(status: ThreadContextResult['status']): string {
  switch (status) {
    case 'forbidden':
      return (
        "I couldn't read the thread history because I'm missing **Read Message History**. " +
        'Grant that permission or paste the question here.'
      );
    case 'empty':
      return "The thread doesn't contain a readable user question. Paste the question here.";
    case 'not-a-thread':
      return 'Reply to a message, mention me inside a forum post/thread, or include a question with the mention.';
    case 'error':
      return "I couldn't read the thread history. Paste the question here.";
    case 'found':
      return 'Please include a question.';
  }
}
