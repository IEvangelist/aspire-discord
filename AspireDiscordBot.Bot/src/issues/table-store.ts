import { createHash } from 'node:crypto';
import { TableClient } from '@azure/data-tables';
import type { TokenCredential } from '@azure/identity';
import { z } from 'zod';
import {
  IssueConflictError,
  type IssueActor,
  type IssueDraft,
  type IssueDraftStore,
  type StoredIssueDraft,
} from './types.js';

const maximumPropertyBytes = 64 * 1_024;
const requestTimeoutMs = 15_000;
const identifier = z.string().regex(/^[A-Za-z0-9-]{1,100}$/);
const actorSchema = z
  .object({ userId: identifier, guildId: identifier, channelId: identifier })
  .strict();
const locationSchema = actorSchema.pick({ guildId: true, channelId: true });
const idSchema = z.uuid().refine((id) => id === id.toLowerCase());
const repositorySchema = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?\/[a-z0-9._-]{1,100}$/)
  .refine((repository) => !['.', '..'].includes(repository.split('/')[1] ?? ''));
const issueSchema = z
  .object({ number: z.number().int().positive(), url: z.url().max(512) })
  .strict();
const draftSchema = z
  .object({
    id: idSchema,
    version: z.number().int().positive(),
    actor: actorSchema,
    repository: repositorySchema,
    visibility: z.enum(['public', 'private']),
    title: z
      .string()
      .min(1)
      .max(180)
      .refine(
        (title) =>
          title === title.trim() && !/\p{Cc}/u.test(title) && !/aspire-discord-issue:/i.test(title),
      ),
    body: z.string().min(1).max(3_600),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    marker: z.string().max(100),
    sourceMessageIds: z.array(identifier).max(100),
    notices: z.array(z.string().min(1).max(500)).max(10),
    duplicates: z.array(issueSchema.extend({ title: z.string().max(256) }).strict()).max(10),
    createdAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    state: z.enum([
      'draft',
      'awaiting_confirmation',
      'publishing',
      'published',
      'unknown',
      'failed',
      'cancelled',
    ]),
    previewMessageId: identifier.optional(),
    approvedAt: z.iso.datetime().optional(),
    result: issueSchema.optional(),
  })
  .strict()
  .refine((draft) => {
    const marker = `<!-- aspire-discord-issue:${draft.id}:${draft.version} -->`;
    const originalBody = draft.body.slice(0, -(marker.length + 2));
    const created = Date.parse(draft.createdAt);
    const expires = Date.parse(draft.expiresAt);
    const approved = draft.approvedAt === undefined ? undefined : Date.parse(draft.approvedAt);
    const approvalRequired = ['publishing', 'published', 'unknown', 'failed'].includes(draft.state);
    const previewRequired = approvalRequired || draft.state === 'awaiting_confirmation';
    const references = [...draft.duplicates, ...(draft.result ? [draft.result] : [])];
    return (
      draft.marker === marker &&
      draft.body.endsWith(`\n\n${marker}`) &&
      originalBody.length > 0 &&
      originalBody.length <= 3_500 &&
      originalBody === originalBody.trim() &&
      !/aspire-discord-issue:|\0/i.test(originalBody) &&
      draft.contentHash ===
        createHash('sha256')
          .update(JSON.stringify([draft.repository, draft.title, draft.body, draft.visibility]))
          .digest('hex') &&
      expires > created &&
      expires - created <= 30 * 60 * 1_000 &&
      (approved === undefined || (approved >= created && approved < expires)) &&
      (draft.approvedAt !== undefined) === approvalRequired &&
      (!previewRequired || draft.previewMessageId !== undefined) &&
      (draft.state !== 'draft' || draft.previewMessageId === undefined) &&
      (draft.result !== undefined) === (draft.state === 'published') &&
      references.every(
        (issue) =>
          issue.url.toLowerCase() ===
          `https://github.com/${draft.repository}/issues/${issue.number}`,
      )
    );
  });

export class AzureTableIssueDraftStore implements IssueDraftStore {
  readonly #client: TableClient;

  public constructor(endpoint: string, credential: TokenCredential, tableName = 'IssueDrafts') {
    const url = new URL(endpoint);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !/^[A-Za-z][A-Za-z0-9]{2,62}$/.test(tableName)
    ) {
      throw new Error('Invalid issue draft table configuration.');
    }
    // The table is provisioned by infrastructure. Ambiguous writes must not be retried.
    this.#client = new TableClient(endpoint, tableName, credential, {
      retryOptions: { maxRetries: 0 },
    });
  }

  public async create(draft: IssueDraft, signal?: AbortSignal): Promise<StoredIssueDraft> {
    signal?.throwIfAborted();
    const validated = validateDraft(draft);
    const entity = toEntity(validated);
    try {
      const response = await boundedRequest(signal, (options) =>
        this.#client.createEntity(entity, options),
      );
      return { draft: validated, etag: validateEtag(response.etag) };
    } catch (error) {
      rethrowConflict(error);
    }
  }

  public async get(
    actor: Pick<IssueActor, 'guildId' | 'channelId'>,
    id: string,
    signal?: AbortSignal,
  ): Promise<StoredIssueDraft | undefined> {
    signal?.throwIfAborted();
    const location = locationSchema.safeParse({
      guildId: actor.guildId,
      channelId: actor.channelId,
    });
    if (!location.success || !idSchema.safeParse(id).success) {
      throw new Error('Invalid issue draft key.');
    }
    const partitionKey = partition(location.data);
    let entity;
    try {
      entity = await boundedRequest(signal, (options) =>
        this.#client.getEntity<{ draftJson: unknown }>(partitionKey, id, options),
      );
    } catch (error) {
      if (!signal?.aborted && statusCode(error) === 404) {
        return undefined;
      }
      throw error;
    }
    if (
      entity.partitionKey !== partitionKey ||
      entity.rowKey !== id ||
      typeof entity.draftJson !== 'string'
    ) {
      throw new Error('Stored issue draft is invalid.');
    }
    assertPropertySize(entity.draftJson);
    let parsed: unknown;
    try {
      parsed = JSON.parse(entity.draftJson);
    } catch {
      throw new Error('Stored issue draft is invalid.');
    }
    const draft = validateDraft(parsed);
    if (draft.id !== id || partition(draft.actor) !== partitionKey) {
      throw new Error('Stored issue draft does not match its key.');
    }
    return { draft, etag: validateEtag(entity.etag) };
  }

  public async replace(
    previous: StoredIssueDraft,
    draft: IssueDraft,
    signal?: AbortSignal,
  ): Promise<StoredIssueDraft> {
    signal?.throwIfAborted();
    const oldDraft = validateDraft(previous.draft);
    const validated = validateDraft(draft);
    const etag = validateEtag(previous.etag);
    if (
      oldDraft.id !== validated.id ||
      oldDraft.actor.userId !== validated.actor.userId ||
      partition(oldDraft.actor) !== partition(validated.actor)
    ) {
      throw new Error('An issue draft replacement cannot change its key or owner.');
    }
    const entity = toEntity(validated);
    try {
      const response = await boundedRequest(signal, (options) =>
        this.#client.updateEntity(entity, 'Replace', { ...options, etag }),
      );
      return { draft: validated, etag: validateEtag(response.etag) };
    } catch (error) {
      rethrowConflict(error);
    }
  }
}

async function boundedRequest<T>(
  signal: AbortSignal | undefined,
  execute: (options: {
    abortSignal: AbortSignal;
    requestOptions: { timeout: number };
  }) => Promise<T>,
): Promise<T> {
  signal?.throwIfAborted();
  const deadline = new AbortController();
  const timeoutError = new Error('Issue draft storage operation timed out.');
  const timer = setTimeout(() => {
    deadline.abort(timeoutError);
  }, requestTimeoutMs);
  timer.unref();
  const abortSignal = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  const completion = Promise.withResolvers<T>();
  const onAbort = () => {
    completion.reject(
      deadline.signal.aborted
        ? timeoutError
        : new Error('Issue draft storage operation was cancelled.'),
    );
  };
  abortSignal.addEventListener('abort', onAbort, { once: true });
  try {
    if (abortSignal.aborted) {
      onAbort();
    } else {
      try {
        // The explicit race also releases callers if credential providers or transports ignore abort.
        void execute({ abortSignal, requestOptions: { timeout: requestTimeoutMs } }).then(
          completion.resolve,
          completion.reject,
        );
      } catch (error) {
        completion.reject(error);
      }
    }
    return await completion.promise;
  } finally {
    clearTimeout(timer);
    abortSignal.removeEventListener('abort', onAbort);
  }
}

function validateDraft(value: unknown): IssueDraft {
  const parsed = draftSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error('Stored issue draft is invalid.');
  }
  // Zod's optional fields include undefined; the contract uses exact optional properties.
  const { previewMessageId, approvedAt, result, ...required } = parsed.data;
  return {
    ...required,
    ...(previewMessageId === undefined ? {} : { previewMessageId }),
    ...(approvedAt === undefined ? {} : { approvedAt }),
    ...(result === undefined ? {} : { result }),
  };
}

function toEntity(draft: IssueDraft) {
  const draftJson = JSON.stringify(draft);
  assertPropertySize(draftJson);
  return { partitionKey: partition(draft.actor), rowKey: draft.id, draftJson };
}

function partition(actor: Pick<IssueActor, 'guildId' | 'channelId'>): string {
  return `${actor.guildId}_${actor.channelId}`;
}

function assertPropertySize(json: string): void {
  if (
    Buffer.byteLength(json, 'utf8') > maximumPropertyBytes ||
    Buffer.byteLength(json, 'utf16le') > maximumPropertyBytes
  ) {
    throw new Error('Issue draft exceeds the Azure Table property size limit.');
  }
}

function validateEtag(etag: unknown): string {
  if (typeof etag !== 'string' || !/^(?:W\/)?"[^"\r\n]+"$/.test(etag) || etag.includes('*')) {
    throw new Error('Issue draft requires an exact ETag.');
  }
  return etag;
}

function statusCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'statusCode' in error
    ? error.statusCode
    : undefined;
}

function rethrowConflict(error: unknown): never {
  if (statusCode(error) === 409 || statusCode(error) === 412) {
    throw new IssueConflictError();
  }
  throw error;
}
