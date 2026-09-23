import { SpanStatusCode, trace } from '@opentelemetry/api';
import { readBoundedBody } from '../agent/bounded-body.js';
import {
  IssuePublishError,
  type ExistingIssue,
  type IssuePublisher,
  type IssueRepository,
  type PublishedIssue,
} from './types.js';

const apiOrigin = 'https://api.github.com';
const requestTimeoutMs = 15_000;
const maximumCachedRepositories = 20;
const tokenExpiryMarginMs = 30_000;
const maximumResponseBytes = 8 * 1024 * 1024;
const tracer = trace.getTracer('aspire-discord-bot.issues');

export interface GitHubAppSigner {
  sign(data: Uint8Array, signal?: AbortSignal): Promise<Uint8Array>;
}

export interface GitHubAppConfig {
  readonly appId: string;
  readonly signer: GitHubAppSigner;
  readonly installationId?: number;
}

interface RepositoryName {
  readonly fullName: string;
  readonly name: string;
}

interface CachedToken {
  readonly token: string;
  readonly expiresAt: number;
}

interface ApiResult<T> {
  readonly value: T;
  readonly status: number;
  readonly requestId: string | undefined;
}

class InvalidResponseError extends Error {}

export class GitHubAppIssuePublisher implements IssuePublisher {
  readonly #appId: string;
  readonly #signer: GitHubAppSigner;
  readonly #installationId: number | undefined;
  readonly #fetch: typeof fetch;
  readonly #tokens = new Map<string, CachedToken>();

  public constructor(config: GitHubAppConfig, fetchImpl: typeof fetch = fetch) {
    if (
      !/^[1-9]\d{0,19}$/u.test(config.appId) ||
      (config.installationId !== undefined && !isPositiveInteger(config.installationId))
    ) {
      throw new IssuePublishError('Invalid GitHub App configuration.', false);
    }
    this.#appId = config.appId;
    this.#signer = config.signer;
    this.#installationId = config.installationId;
    this.#fetch = fetchImpl;
  }

  public async inspect(repository: string, signal?: AbortSignal): Promise<IssueRepository> {
    return await withIssueSpan('inspect', async () => {
      const access = await this.#access(parseRepository(repository), signal);
      return access.repository;
    });
  }

  public async findDuplicates(
    repository: string,
    title: string,
    signal?: AbortSignal,
  ): Promise<readonly ExistingIssue[]> {
    return await withIssueSpan('find_duplicates', async () => {
      const name = parseRepository(repository);
      const query = duplicateQuery(name, title);
      if (!query) {
        return [];
      }
      const access = await this.#access(name, signal);
      const response = await this.#request(
        `/search/issues?q=${encodeURIComponent(query)}&per_page=20&sort=updated&order=desc`,
        access.token,
        'GET',
        200,
        (data) => {
          if (!isRecord(data) || !Array.isArray(data.items)) {
            throw new InvalidResponseError('GitHub returned an invalid duplicate search response.');
          }
          const issues = new Map<number, ExistingIssue>();
          for (const item of data.items.slice(0, 20)) {
            const issue = publishedIssue(item, name);
            if (issue && isRecord(item) && typeof item.title === 'string') {
              issues.set(issue.number, { ...issue, title: item.title });
            }
            if (issues.size === 5) {
              break;
            }
          }
          return [...issues.values()];
        },
        signal,
      );
      return response.value;
    });
  }

  public async create(
    repository: string,
    title: string,
    body: string,
    signal?: AbortSignal,
    authorize?: (repository: IssueRepository) => void,
  ): Promise<PublishedIssue> {
    return await withIssueSpan('create', async () => {
      const name = parseRepository(repository);
      const access = await this.#access(name, signal);
      if (!access.repository.issuesEnabled) {
        throw new IssuePublishError('This GitHub repository does not accept new issues.', false);
      }
      try {
        authorize?.(access.repository);
      } catch {
        throw new IssuePublishError('GitHub issue publication authorization failed.', false);
      }
      const response = await this.#request(
        `/repos/${name.fullName}/issues`,
        access.token,
        'POST',
        201,
        (data) => {
          const issue = publishedIssue(data, name);
          if (!issue) {
            throw new InvalidResponseError('GitHub returned an invalid issue creation response.');
          }
          return issue;
        },
        signal,
        { title, body },
        true,
      );
      return response.value;
    });
  }

  public async reconcile(
    repository: string,
    marker: string,
    since: string,
    signal?: AbortSignal,
  ): Promise<PublishedIssue | undefined> {
    return await withIssueSpan('reconcile', async () => {
      const name = parseRepository(repository);
      const sinceMs = Date.parse(since);
      if (marker.length === 0 || marker.length > 1024 || !Number.isFinite(sinceMs)) {
        throw new IssuePublishError('Invalid GitHub reconciliation parameters.', false);
      }
      const access = await this.#access(name, signal);
      const query = new URLSearchParams({
        since: new Date(sinceMs).toISOString(),
        state: 'all',
        sort: 'created',
        direction: 'desc',
        per_page: '100',
      });
      const matches = new Map<number, PublishedIssue>();
      for (let page = 1; page <= 5; page += 1) {
        const response = await this.#request(
          `/repos/${name.fullName}/issues?${query.toString()}&page=${page}`,
          access.token,
          'GET',
          200,
          (data) => {
            if (!Array.isArray(data) || data.length > 100) {
              throw new InvalidResponseError('GitHub returned an invalid issue listing.');
            }
            const found: PublishedIssue[] = [];
            for (const item of data) {
              if (
                !isRecord(item) ||
                'pull_request' in item ||
                typeof item.body !== 'string' ||
                !item.body.includes(marker)
              ) {
                continue;
              }
              const issue = publishedIssue(item, name);
              if (!issue) {
                throw new InvalidResponseError('GitHub returned an invalid matching issue.');
              }
              found.push(issue);
            }
            return { found, count: data.length };
          },
          signal,
        );
        for (const issue of response.value.found) {
          matches.set(issue.number, issue);
        }
        if (matches.size > 1) {
          throw new IssuePublishError(
            'Multiple GitHub issues match this publication marker. Manual review is required.',
            false,
            response.status,
            response.requestId,
          );
        }
        if (response.value.count < 100) {
          break;
        }
      }
      return matches.values().next().value;
    });
  }

  async #access(
    name: RepositoryName,
    signal?: AbortSignal,
  ): Promise<CachedToken & { readonly repository: IssueRepository }> {
    for (const [key, value] of this.#tokens) {
      if (value.expiresAt <= Date.now() + tokenExpiryMarginMs) {
        this.#tokens.delete(key);
      }
    }
    let token = this.#tokens.get(name.fullName);
    if (!token) {
      const jwt = await this.#jwt(signal);
      const installationId =
        this.#installationId ??
        (
          await this.#request(
            `/repos/${name.fullName}/installation`,
            jwt,
            'GET',
            200,
            (data) => {
              if (!isRecord(data) || !isPositiveInteger(data.id)) {
                throw new InvalidResponseError('GitHub returned an invalid installation.');
              }
              return data.id;
            },
            signal,
          )
        ).value;
      token = (
        await this.#request(
          `/app/installations/${installationId}/access_tokens`,
          jwt,
          'POST',
          201,
          (data) => parseToken(data, name),
          signal,
          { repositories: [name.name], permissions: { issues: 'write' } },
        )
      ).value;
    }
    // A configured installation can belong to another owner; verify using the scoped token.
    const repository = (
      await this.#request(
        `/repos/${name.fullName}`,
        token.token,
        'GET',
        200,
        (data) => parseMetadata(data, name),
        signal,
      )
    ).value;
    this.#tokens.delete(name.fullName);
    while (this.#tokens.size >= maximumCachedRepositories) {
      const oldest = this.#tokens.keys().next().value;
      if (oldest !== undefined) {
        this.#tokens.delete(oldest);
      }
    }
    this.#tokens.set(name.fullName, token);
    return { ...token, repository };
  }

  async #jwt(signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) {
      throw new IssuePublishError('GitHub App authentication failed.', false);
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, requestTimeoutMs);
    timeout.unref();
    const requestSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
    let abort: (() => void) | undefined;
    try {
      const now = Math.floor(Date.now() / 1000);
      const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString(
        'base64url',
      );
      const claims = Buffer.from(
        JSON.stringify({ iat: now - 60, exp: now + 9 * 60, iss: this.#appId }),
      ).toString('base64url');
      const content = `${header}.${claims}`;
      const cancelled = new Promise<never>((_resolve, reject) => {
        abort = () => {
          reject(new Error('GitHub App signing cancelled.'));
        };
        requestSignal.addEventListener('abort', abort, { once: true });
      });
      const signature = await Promise.race([
        this.#signer.sign(Buffer.from(content), requestSignal),
        cancelled,
      ]);
      if (
        requestSignal.aborted ||
        !(signature instanceof Uint8Array) ||
        signature.byteLength < 256 ||
        signature.byteLength > 1024
      ) {
        throw new Error('Invalid GitHub App signature.');
      }
      return `${content}.${Buffer.from(signature).toString('base64url')}`;
    } catch {
      throw new IssuePublishError('GitHub App authentication failed.', false);
    } finally {
      clearTimeout(timeout);
      if (abort) {
        requestSignal.removeEventListener('abort', abort);
      }
    }
  }

  async #request<T>(
    path: string,
    credential: string,
    method: 'GET' | 'POST',
    expectedStatus: number,
    parse: (data: unknown) => T,
    signal?: AbortSignal,
    body?: unknown,
    publication = false,
  ): Promise<ApiResult<T>> {
    if (signal?.aborted) {
      throw new IssuePublishError('GitHub request was cancelled before sending.', false);
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, requestTimeoutMs);
    timeout.unref();
    const requestSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
    let response: Response | undefined;
    let abort: (() => void) | undefined;
    try {
      const cancelled = new Promise<never>((_resolve, reject) => {
        abort = () => {
          reject(new Error('GitHub request cancelled.'));
        };
        requestSignal.addEventListener('abort', abort, { once: true });
      });
      const request = async (): Promise<ApiResult<T>> => {
        response = await this.#fetch(`${apiOrigin}${path}`, {
          method,
          headers: {
            accept: 'application/vnd.github+json',
            authorization: `Bearer ${credential}`,
            'content-type': 'application/json',
            'user-agent': 'aspire-discord-bot',
            'x-github-api-version': '2022-11-28',
          },
          redirect: 'error',
          signal: requestSignal,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        if (response.status !== expectedStatus) {
          void response.body?.cancel().catch(() => undefined);
          throw new InvalidResponseError('GitHub request was rejected.');
        }
        const bytes = await readBoundedBody(
          response,
          maximumResponseBytes,
          'GitHub response exceeded the size limit.',
        );
        const data: unknown = JSON.parse(Buffer.from(bytes).toString('utf8'));
        return {
          value: parse(data),
          status: response.status,
          requestId: safeRequestId(response),
        };
      };
      return await Promise.race([request(), cancelled]);
    } catch (error) {
      const status = response?.status;
      const definitelyRejected =
        status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429;
      throw new IssuePublishError(
        error instanceof InvalidResponseError ? error.message : 'GitHub request failed.',
        publication && !definitelyRejected,
        status,
        response ? safeRequestId(response) : undefined,
      );
    } finally {
      clearTimeout(timeout);
      if (abort) {
        requestSignal.removeEventListener('abort', abort);
      }
    }
  }
}

function parseRepository(value: string): RepositoryName {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?\/[a-z0-9_.-]{1,100}$/iu.test(value)) {
    throw new IssuePublishError('Invalid GitHub repository name.', false);
  }
  const fullName = value.toLowerCase();
  const name = fullName.split('/')[1];
  if (!name || name === '.' || name === '..') {
    throw new IssuePublishError('Invalid GitHub repository name.', false);
  }
  return { fullName, name };
}

function parseMetadata(data: unknown, name: RepositoryName): IssueRepository {
  if (
    !isRecord(data) ||
    typeof data.full_name !== 'string' ||
    data.full_name.toLowerCase() !== name.fullName ||
    (data.visibility !== 'public' && data.visibility !== 'private') ||
    typeof data.has_issues !== 'boolean' ||
    typeof data.archived !== 'boolean'
  ) {
    throw new InvalidResponseError('GitHub returned invalid or mismatched repository metadata.');
  }
  return {
    fullName: data.full_name,
    visibility: data.visibility,
    issuesEnabled: data.has_issues && !data.archived,
  };
}

function parseToken(data: unknown, name: RepositoryName): CachedToken {
  if (
    !isRecord(data) ||
    typeof data.token !== 'string' ||
    !/^[!-~]{1,4096}$/u.test(data.token) ||
    typeof data.expires_at !== 'string' ||
    ('permissions' in data &&
      (!isRecord(data.permissions) || data.permissions.issues !== 'write')) ||
    ('repositories' in data &&
      (!Array.isArray(data.repositories) ||
        data.repositories.length !== 1 ||
        !isRecord(data.repositories[0]) ||
        typeof data.repositories[0].full_name !== 'string' ||
        data.repositories[0].full_name.toLowerCase() !== name.fullName))
  ) {
    throw new InvalidResponseError('GitHub did not grant the requested repository issue access.');
  }
  const expiresAt = Math.min(Date.parse(data.expires_at), Date.now() + 60 * 60_000);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() + tokenExpiryMarginMs) {
    throw new InvalidResponseError('GitHub returned an invalid installation token expiry.');
  }
  return { token: data.token, expiresAt };
}

function publishedIssue(data: unknown, name: RepositoryName): PublishedIssue | undefined {
  if (
    !isRecord(data) ||
    'pull_request' in data ||
    !isPositiveInteger(data.number) ||
    typeof data.html_url !== 'string' ||
    data.html_url.toLowerCase() !== `https://github.com/${name.fullName}/issues/${data.number}`
  ) {
    return undefined;
  }
  return {
    number: data.number,
    url: `https://github.com/${name.fullName}/issues/${data.number}`,
  };
}

function duplicateQuery(name: RepositoryName, title: string): string | undefined {
  let query = `repo:${name.fullName} is:issue in:title`;
  let count = 0;
  const words = new Set(
    (
      title
        .slice(0, 512)
        .toLowerCase()
        .match(/[\p{L}\p{N}]+/gu) ?? []
    )
      .filter((word) => word.length > 1 && !['or', 'and', 'not'].includes(word))
      .map((word) => word.slice(0, 32)),
  );
  for (const word of words) {
    const candidate = `${query} "${word}"`;
    if (candidate.length <= 256) {
      query = candidate;
      count += 1;
    }
    if (count === 6) {
      break;
    }
  }
  return count > 0 ? query : undefined;
}

function safeRequestId(response: Response): string | undefined {
  const value = response.headers.get('x-github-request-id');
  return value && /^[a-z0-9:_-]{1,128}$/iu.test(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

async function withIssueSpan<T>(
  operation: 'inspect' | 'find_duplicates' | 'create' | 'reconcile',
  action: () => Promise<T>,
): Promise<T> {
  return await tracer.startActiveSpan(`github.issues.${operation}`, async (span) => {
    try {
      const result = await action();
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      span.setAttribute('error.type', 'github_issue_request_failed');
      if (error instanceof IssuePublishError) {
        span.setAttribute('github.issues.outcome_unknown', error.outcomeUnknown);
        if (error.status !== undefined) {
          span.setAttribute('http.response.status_code', error.status);
        }
      }
      throw error;
    } finally {
      span.end();
    }
  });
}
