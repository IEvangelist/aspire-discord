const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const booleanBranchPattern = /\b(?:OR|NOT)\b|\|/u;
const disallowedScopePattern = /(?:^|\s)(?:org|user|owner):/iu;
const repositoryQualifierPattern =
  /(?:^|\s)repo:(?<repo>["']?[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+["']?)/giu;
const safeRefPattern = /^(?:main|v?\d+(?:\.\d+){1,3}|[0-9a-f]{7,64})$/iu;

export type GitHubLinkedResource =
  | {
      readonly issueNumber: number;
      readonly kind: 'issue';
      readonly repository: string;
    }
  | {
      readonly kind: 'pull-request';
      readonly pullNumber: number;
      readonly repository: string;
    }
  | {
      readonly kind: 'commit';
      readonly repository: string;
      readonly sha: string;
    }
  | {
      readonly kind: 'file';
      readonly path: string;
      readonly ref: string;
      readonly repository: string;
    }
  | {
      readonly kind: 'latest-release';
      readonly repository: string;
    };

export class GitHubRepositoryPolicy {
  readonly #allowed: ReadonlySet<string>;
  readonly #defaultRepository: string;

  public constructor(allowedRepositories: readonly string[]) {
    if (allowedRepositories.length === 0) {
      throw new Error('At least one GitHub repository must be allowed.');
    }
    for (const repository of allowedRepositories) {
      if (!repositoryPattern.test(repository)) {
        throw new Error(`Invalid GitHub repository '${repository}'.`);
      }
    }
    this.#allowed = new Set(
      allowedRepositories.map((repository) => repository.toLocaleLowerCase('en-US')),
    );
    const [defaultRepository] = allowedRepositories;
    if (!defaultRepository) {
      throw new Error('At least one GitHub repository must be allowed.');
    }
    this.#defaultRepository = defaultRepository;
  }

  public get defaultRepository(): string {
    return this.#defaultRepository;
  }

  public split(repository: string): { owner: string; repo: string } {
    this.ensureAllowed(repository);
    const [owner, repo] = repository.split('/', 2);
    if (!owner || !repo) {
      throw new Error(`Invalid GitHub repository '${repository}'.`);
    }
    return { owner, repo };
  }

  public scopeCodeQuery(query: string): string {
    if (booleanBranchPattern.test(query) || disallowedScopePattern.test(query)) {
      throw new Error(
        'GitHub code queries may not contain Boolean branches or organization/user scopes.',
      );
    }

    const repositories = [...query.matchAll(repositoryQualifierPattern)].map((match) =>
      (match.groups?.repo ?? '').replace(/^["']|["']$/gu, ''),
    );
    for (const repository of repositories) {
      this.ensureAllowed(repository);
    }
    return repositories.length > 0
      ? query.trim()
      : `${query.trim()} repo:${this.#defaultRepository}`;
  }

  public ensureAllowed(repository: string): void {
    if (!this.#allowed.has(repository.toLocaleLowerCase('en-US'))) {
      throw new Error(
        `GitHub repository '${repository}' is not allowed. Allowed: ${[...this.#allowed].join(', ')}.`,
      );
    }
  }

  public isAllowedUrl(value: string): boolean {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return false;
    }
    if (url.hostname !== 'github.com' && url.hostname !== 'api.github.com') {
      return false;
    }

    const parts = url.pathname.split('/').filter(Boolean);
    const offset = url.hostname === 'api.github.com' && parts[0] === 'repos' ? 1 : 0;
    const owner = parts[offset];
    const repo = parts[offset + 1];
    return Boolean(
      owner && repo && this.#allowed.has(`${owner}/${repo}`.toLocaleLowerCase('en-US')),
    );
  }

  public parseLinkedResource(value: string): GitHubLinkedResource | undefined {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return undefined;
    }
    if (url.protocol !== 'https:' || url.hostname !== 'github.com') {
      return undefined;
    }

    let parts: string[];
    try {
      parts = url.pathname
        .split('/')
        .filter(Boolean)
        .map((part) => decodeURIComponent(part));
    } catch {
      return undefined;
    }
    const [owner, repo, resource, identifier, ...rest] = parts;
    if (!owner || !repo || !resource) {
      return undefined;
    }
    const repository = `${owner}/${repo}`;
    if (!this.#allowed.has(repository.toLocaleLowerCase('en-US'))) {
      return undefined;
    }

    if (resource === 'issues') {
      const issueNumber = positiveInteger(identifier);
      return issueNumber ? { issueNumber, kind: 'issue', repository } : undefined;
    }
    if (resource === 'pull') {
      const pullNumber = positiveInteger(identifier);
      return pullNumber ? { kind: 'pull-request', pullNumber, repository } : undefined;
    }
    if (resource === 'commit' && identifier && /^[0-9a-f]{7,64}$/iu.test(identifier)) {
      return { kind: 'commit', repository, sha: identifier };
    }
    if (resource === 'blob' && identifier && safeRefPattern.test(identifier) && rest.length > 0) {
      return {
        kind: 'file',
        path: rest.join('/'),
        ref: identifier,
        repository,
      };
    }
    if (resource === 'releases' && identifier === 'latest') {
      return { kind: 'latest-release', repository };
    }
    return undefined;
  }
}

function positiveInteger(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}
