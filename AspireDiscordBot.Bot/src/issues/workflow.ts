import { createHash, randomUUID } from 'node:crypto';
import { metrics, SpanStatusCode, trace } from '@opentelemetry/api';
import type { Logger } from 'pino';
import { assertSafeIssueContent } from './drafting.js';
import {
  IssueConflictError,
  IssuePolicyError,
  IssuePublishError,
  type IssueActor,
  type IssueDraft,
  type IssueDraftInput,
  type IssueDraftStore,
  type IssuePolicy,
  type IssuePublisher,
  type IssueRepository,
  type PublishedIssue,
  type StoredIssueDraft,
} from './types.js';

const maximumLifetimeMs = 30 * 60 * 1_000;
const recoveryTimeoutMs = 15_000;
const identifierPattern = /^[A-Za-z0-9-]{1,100}$/;
const repositoryPattern = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?\/[a-z0-9._-]{1,100}$/;
const tracer = trace.getTracer('AspireDiscordBot.Issues');
const meter = metrics.getMeter('AspireDiscordBot.Issues');
const actions = meter.createCounter('aspire.issues.actions', { unit: '{action}' });
const duration = meter.createHistogram('aspire.issues.action.duration', { unit: 's' });

export interface IssueWorkflowOptions {
  readonly draftLifetimeMs?: number;
  readonly now?: () => Date | number;
}

export class IssueWorkflow {
  readonly #lifetimeMs: number;
  readonly #now: () => Date;

  public constructor(
    private readonly store: IssueDraftStore,
    private readonly publisher: IssuePublisher,
    private readonly getPolicy: () => IssuePolicy,
    private readonly logger: Pick<Logger, 'info' | 'error'>,
    options: IssueWorkflowOptions = {},
  ) {
    const lifetime = options.draftLifetimeMs ?? maximumLifetimeMs;
    if (!Number.isSafeInteger(lifetime) || lifetime <= 0 || lifetime > maximumLifetimeMs) {
      throw new Error('Issue draft lifetime must be between 1 millisecond and 30 minutes.');
    }
    this.#lifetimeMs = lifetime;
    const clock = options.now ?? Date.now;
    this.#now = () => {
      const value = clock();
      return value instanceof Date ? value : new Date(value);
    };
  }

  public create(
    actor: IssueActor,
    input: IssueDraftInput,
    signal?: AbortSignal,
  ): Promise<IssueDraft> {
    actor = { ...actor };
    return this.#observe('create', async () => {
      this.#authorize(actor);
      const content = normalizeInput(input);
      this.#authorize(actor, content.repository);
      const draft = await this.#prepare(actor, content, randomUUID(), 1, undefined, signal);
      this.#authorize(actor, draft.repository);
      signal?.throwIfAborted();
      return (await this.store.create(draft, signal)).draft;
    });
  }

  public get(
    actor: IssueActor,
    id: string,
    options: { allowExpired?: boolean; signal?: AbortSignal } = {},
  ): Promise<IssueDraft> {
    actor = { ...actor };
    const { allowExpired = false, signal } = options;
    return this.#observe(
      'get',
      async () => (await this.#load(actor, id, allowExpired, signal)).draft,
    );
  }

  public revise(
    actor: IssueActor,
    id: string,
    version: number,
    input: IssueDraftInput,
    signal?: AbortSignal,
  ): Promise<IssueDraft> {
    actor = { ...actor };
    return this.#observe('revise', async () => {
      const previous = await this.#load(actor, id, false, signal);
      assertVersion(previous.draft, version);
      assertEditable(previous.draft);
      if (!Number.isSafeInteger(version + 1)) {
        throw new IssueConflictError();
      }
      const content = normalizeInput(input);
      this.#authorize(actor, content.repository);
      const draft = await this.#prepare(actor, content, id, version + 1, previous.draft, signal);
      this.#authorize(actor, draft.repository);
      this.#assertFresh(draft);
      signal?.throwIfAborted();
      return (await this.store.replace(previous, draft, signal)).draft;
    });
  }

  public attachPreview(
    actor: IssueActor,
    id: string,
    version: number,
    previewMessageId: string,
    signal?: AbortSignal,
  ): Promise<IssueDraft> {
    actor = { ...actor };
    return this.#observe('attach_preview', async () => {
      const previous = await this.#load(actor, id, false, signal);
      assertVersion(previous.draft, version);
      if (previous.draft.state !== 'draft' || !identifierPattern.test(previewMessageId)) {
        throw new IssueConflictError();
      }
      return (
        await this.store.replace(
          previous,
          {
            ...previous.draft,
            state: 'awaiting_confirmation',
            previewMessageId,
          },
          signal,
        )
      ).draft;
    });
  }

  public confirm(
    actor: IssueActor,
    id: string,
    version: number,
    previewMessageId: string,
    signal?: AbortSignal,
  ): Promise<IssueDraft> {
    actor = { ...actor };
    return this.#observe('confirm', async () => {
      const previous = await this.#load(actor, id, true, signal);
      const draft = previous.draft;
      assertVersion(draft, version);
      if (
        !identifierPattern.test(previewMessageId) ||
        draft.previewMessageId !== previewMessageId
      ) {
        throw new IssueConflictError();
      }
      if (
        draft.state === 'published' ||
        draft.state === 'publishing' ||
        draft.state === 'unknown'
      ) {
        return draft;
      }
      if (draft.state !== 'awaiting_confirmation') {
        throw new IssueConflictError();
      }
      this.#assertFresh(draft);
      signal?.throwIfAborted();
      const repository = await this.publisher.inspect(draft.repository, signal);
      this.#authorize(actor, draft.repository);
      this.#assertFresh(draft);
      assertRepository(repository, draft.repository);
      if (repository.visibility !== draft.visibility) {
        throw new IssuePolicyError(
          'Repository visibility changed. Revise the draft and approve a new preview.',
        );
      }
      signal?.throwIfAborted();
      let claimed: StoredIssueDraft;
      try {
        claimed = await this.store.replace(
          previous,
          {
            ...draft,
            state: 'publishing',
            approvedAt: this.#now().toISOString(),
          },
          signal,
        );
      } catch (error) {
        if (error instanceof IssueConflictError) {
          throw error;
        }
        throw unknownPersistenceError();
      }

      // A policy update or expiry during the durable claim must still prevent the POST.
      try {
        this.#authorize(actor, draft.repository);
        this.#assertFresh(draft);
        signal?.throwIfAborted();
      } catch {
        return await this.#saveOutcome(claimed, { ...claimed.draft, state: 'failed' });
      }

      const approvedHash = draft.contentHash;
      const authorize = (freshRepository: IssueRepository): void => {
        try {
          this.#authorize(actor, draft.repository);
          this.#assertFresh(draft);
          assertRepository(freshRepository, draft.repository);
          if (
            freshRepository.visibility !== draft.visibility ||
            draft.version !== version ||
            claimed.draft.version !== version ||
            draft.contentHash !== approvedHash ||
            claimed.draft.contentHash !== approvedHash ||
            contentHash(draft) !== approvedHash ||
            contentHash(claimed.draft) !== approvedHash
          ) {
            throw new IssueConflictError();
          }
          signal?.throwIfAborted();
        } catch {
          throw new IssuePublishError(
            'Authorization, repository visibility, or the approved draft changed before publication. No issue was created.',
            false,
          );
        }
      };
      let result: PublishedIssue;
      try {
        result = await this.publisher.create(
          draft.repository,
          draft.title,
          draft.body,
          signal,
          authorize,
        );
        assertPublishedIssue(result, draft.repository);
      } catch (error) {
        const state =
          error instanceof IssuePublishError && !error.outcomeUnknown ? 'failed' : 'unknown';
        const status = error instanceof IssuePublishError ? error.status : undefined;
        this.logger.error(
          {
            action: 'publish',
            outcome: state,
            ...(status !== undefined && Number.isInteger(status) && status >= 100 && status <= 599
              ? { httpStatus: status }
              : {}),
          },
          'GitHub issue publication failed.',
        );
        return await this.#saveOutcome(claimed, { ...claimed.draft, state });
      }
      return await this.#saveOutcome(claimed, { ...claimed.draft, state: 'published', result });
    });
  }

  public cancel(
    actor: IssueActor,
    id: string,
    version: number,
    signal?: AbortSignal,
  ): Promise<IssueDraft> {
    actor = { ...actor };
    return this.#observe('cancel', async () => {
      const previous = await this.#load(actor, id, false, signal);
      assertVersion(previous.draft, version);
      assertEditable(previous.draft);
      return (await this.store.replace(previous, { ...previous.draft, state: 'cancelled' }, signal))
        .draft;
    });
  }

  public reconcile(actor: IssueActor, id: string, signal?: AbortSignal): Promise<IssueDraft> {
    actor = { ...actor };
    return this.#observe('reconcile', async () => {
      const previous = await this.#load(actor, id, true, signal);
      const draft = previous.draft;
      if (draft.state === 'published') {
        return draft;
      }
      if (draft.state !== 'publishing' && draft.state !== 'unknown') {
        throw new IssueConflictError();
      }
      signal?.throwIfAborted();
      const result = await this.publisher.reconcile(
        draft.repository,
        draft.marker,
        draft.approvedAt ?? draft.createdAt,
        signal,
      );
      this.#authorize(actor, draft.repository);
      if (result) {
        assertPublishedIssue(result, draft.repository);
        return await this.#saveOutcome(previous, { ...draft, state: 'published', result });
      }
      return draft.state === 'unknown'
        ? draft
        : await this.#saveOutcome(previous, { ...draft, state: 'unknown' });
    });
  }

  async #prepare(
    actor: IssueActor,
    input: IssueDraftInput,
    id: string,
    version: number,
    previous: IssueDraft | undefined,
    signal?: AbortSignal,
  ): Promise<IssueDraft> {
    signal?.throwIfAborted();
    const repository = await this.publisher.inspect(input.repository, signal);
    this.#authorize(actor, input.repository);
    assertRepository(repository, input.repository);
    const duplicates = await this.publisher.findDuplicates(input.repository, input.title, signal);
    this.#authorize(actor, input.repository);
    const boundedDuplicates = duplicates.slice(0, 10).map((issue) => {
      assertPublishedIssue(issue, input.repository);
      return { number: issue.number, url: issue.url, title: issue.title.slice(0, 256) };
    });
    const createdAt = previous?.createdAt ?? this.#now().toISOString();
    const marker = `<!-- aspire-discord-issue:${id}:${version} -->`;
    const body = `${input.body}\n\n${marker}`;
    return {
      ...input,
      id,
      version,
      actor,
      body,
      visibility: repository.visibility,
      contentHash: contentHash({
        repository: input.repository,
        title: input.title,
        body,
        visibility: repository.visibility,
      }),
      marker,
      duplicates: boundedDuplicates,
      createdAt,
      expiresAt:
        previous?.expiresAt ?? new Date(Date.parse(createdAt) + this.#lifetimeMs).toISOString(),
      state: 'draft',
    };
  }

  async #load(
    actor: IssueActor,
    id: string,
    allowExpired = false,
    signal?: AbortSignal,
  ): Promise<StoredIssueDraft> {
    this.#authorize(actor);
    signal?.throwIfAborted();
    const stored = await this.store.get(actor, id, signal);
    signal?.throwIfAborted();
    if (!stored) {
      throw new IssuePolicyError('Issue draft not found in this channel.');
    }
    const draft = stored.draft;
    if (
      draft.id !== id ||
      draft.actor.userId !== actor.userId ||
      draft.actor.guildId !== actor.guildId ||
      draft.actor.channelId !== actor.channelId
    ) {
      throw new IssuePolicyError(
        'Only the draft owner in its original server and channel can use this draft.',
      );
    }
    this.#authorize(actor, draft.repository);
    if (!allowExpired) {
      this.#assertFresh(draft);
    }
    return stored;
  }

  #authorize(actor: IssueActor, repository?: string): void {
    const policy = this.getPolicy();
    if (
      !identifierPattern.test(actor.userId) ||
      !identifierPattern.test(actor.guildId) ||
      !identifierPattern.test(actor.channelId) ||
      !policy.enabled ||
      policy.allowedUserIds.length === 0 ||
      policy.allowedChannelIds.length === 0 ||
      policy.allowedRepositories.length === 0 ||
      !policy.allowedUserIds.every((id) => identifierPattern.test(id)) ||
      !policy.allowedChannelIds.every((id) => identifierPattern.test(id)) ||
      !policy.allowedUserIds.includes(actor.userId) ||
      !policy.allowedChannelIds.includes(actor.channelId)
    ) {
      throw new IssuePolicyError('Issue creation is not enabled for this user and channel.');
    }
    const repositories = policy.allowedRepositories.map(normalizeRepository);
    if (repository !== undefined && !repositories.includes(repository)) {
      throw new IssuePolicyError('This repository is not allowed for issue creation.');
    }
  }

  #assertFresh(draft: IssueDraft): void {
    if (this.#now().getTime() >= Date.parse(draft.expiresAt)) {
      throw new IssuePolicyError('This draft has expired. Create and approve a new draft.');
    }
  }

  async #saveOutcome(previous: StoredIssueDraft, draft: IssueDraft): Promise<IssueDraft> {
    // Once claimed, save known outcomes with an independent bounded signal even if the caller left.
    const recovery = new AbortController();
    const timer = setTimeout(() => {
      recovery.abort();
    }, recoveryTimeoutMs);
    timer.unref();
    const aborted = Promise.withResolvers<never>();
    const onAbort = () => {
      aborted.reject(unknownPersistenceError());
    };
    recovery.signal.addEventListener('abort', onAbort, { once: true });
    try {
      return (
        await Promise.race([this.store.replace(previous, draft, recovery.signal), aborted.promise])
      ).draft;
    } catch {
      // Never retry creation: GitHub may have committed even when durable status could not be saved.
      throw unknownPersistenceError();
    } finally {
      clearTimeout(timer);
      recovery.signal.removeEventListener('abort', onAbort);
    }
  }

  #observe(action: string, execute: () => Promise<IssueDraft>): Promise<IssueDraft> {
    return tracer.startActiveSpan(`issue ${action}`, async (span) => {
      const started = performance.now();
      let outcome = 'error';
      try {
        const draft = await execute();
        outcome = draft.state;
        if (outcome === 'failed' || outcome === 'unknown') {
          this.logger.error(
            { action, outcome },
            'Issue workflow action did not complete publication.',
          );
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: 'Issue publication not confirmed.',
          });
        } else {
          this.logger.info({ action, outcome }, 'Issue workflow action completed.');
          span.setStatus({ code: SpanStatusCode.OK });
        }
        return draft;
      } catch (error) {
        outcome =
          error instanceof IssueConflictError
            ? 'conflict'
            : error instanceof IssuePolicyError
              ? 'denied'
              : error instanceof IssuePublishError && error.outcomeUnknown
                ? 'unknown'
                : 'error';
        this.logger.error({ action, outcome }, 'Issue workflow action failed.');
        span.setStatus({ code: SpanStatusCode.ERROR, message: 'Issue workflow action failed.' });
        throw error;
      } finally {
        const attributes = { 'aspire.issues.action': action, 'aspire.issues.outcome': outcome };
        span.setAttributes(attributes);
        actions.add(1, attributes);
        duration.record((performance.now() - started) / 1_000, attributes);
        span.end();
      }
    });
  }
}

function normalizeRepository(repository: string): string {
  const normalized = repository.trim().toLowerCase();
  if (!repositoryPattern.test(normalized) || ['.', '..'].includes(normalized.split('/')[1] ?? '')) {
    throw new IssuePolicyError('Specify a valid, explicitly allowed GitHub owner/repository.');
  }
  return normalized;
}

function normalizeInput(input: IssueDraftInput): IssueDraftInput {
  assertSafeIssueContent(input.title, input.body);
  const repository = normalizeRepository(input.repository);
  const title = input.title.trim();
  const body = input.body.trim();
  if (
    title.length === 0 ||
    title.length > 180 ||
    /\p{Cc}/u.test(title) ||
    body.length === 0 ||
    body.length > 3_500 ||
    body.includes('\0') ||
    /aspire-discord-issue:/i.test(`${title}\n${body}`) ||
    input.sourceMessageIds.length > 100 ||
    !input.sourceMessageIds.every((id) => identifierPattern.test(id)) ||
    input.notices.length > 10 ||
    !input.notices.every((notice) => notice.length > 0 && notice.length <= 500)
  ) {
    throw new IssuePolicyError(
      'Issue draft content or source context exceeds its supported limits.',
    );
  }
  return {
    repository,
    title,
    body,
    sourceMessageIds: [...input.sourceMessageIds],
    notices: [...input.notices],
  };
}

function assertRepository(repository: IssueRepository, expected: string): void {
  if (
    normalizeRepository(repository.fullName) !== expected ||
    !['private', 'public'].includes(repository.visibility) ||
    !repository.issuesEnabled
  ) {
    throw new IssuePolicyError(
      'The requested repository is unavailable or does not accept issues. Create a new draft.',
    );
  }
}

function assertVersion(draft: IssueDraft, version: number): void {
  if (!Number.isSafeInteger(version) || version < 1 || draft.version !== version) {
    throw new IssueConflictError();
  }
}

function assertEditable(draft: IssueDraft): void {
  if (draft.state !== 'draft' && draft.state !== 'awaiting_confirmation') {
    throw new IssueConflictError();
  }
}

function assertPublishedIssue(result: PublishedIssue, repository: string): void {
  if (
    !Number.isSafeInteger(result.number) ||
    result.number <= 0 ||
    result.url.toLowerCase() !== `https://github.com/${repository}/issues/${result.number}`
  ) {
    throw new IssuePublishError('GitHub returned an invalid issue reference.', true);
  }
}

function contentHash(
  draft: Pick<IssueDraft, 'repository' | 'title' | 'body' | 'visibility'>,
): string {
  return createHash('sha256')
    .update(JSON.stringify([draft.repository, draft.title, draft.body, draft.visibility]))
    .digest('hex');
}

function unknownPersistenceError(): IssuePublishError {
  return new IssuePublishError(
    'Publication status could not be saved. Do not resubmit; reconcile this draft to check GitHub.',
    true,
  );
}
