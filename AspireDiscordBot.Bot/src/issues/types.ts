export interface IssueActor {
  readonly userId: string;
  readonly guildId: string;
  readonly channelId: string;
}

export interface IssuePolicy {
  readonly enabled: boolean;
  readonly allowedUserIds: readonly string[];
  readonly allowedChannelIds: readonly string[];
  readonly allowedGuildIds?: readonly string[];
  readonly allowedRepositories: readonly string[];
}

export interface IssueRepository {
  readonly fullName: string;
  readonly visibility: 'public' | 'private';
  readonly issuesEnabled: boolean;
}

export interface PublishedIssue {
  readonly number: number;
  readonly url: string;
}

export interface ExistingIssue extends PublishedIssue {
  readonly title: string;
}

export interface IssuePublisher {
  inspect(repository: string, signal?: AbortSignal): Promise<IssueRepository>;
  findDuplicates(
    repository: string,
    title: string,
    signal?: AbortSignal,
  ): Promise<readonly ExistingIssue[]>;
  create(
    repository: string,
    title: string,
    body: string,
    signal?: AbortSignal,
    authorize?: (repository: IssueRepository) => void,
  ): Promise<PublishedIssue>;
  reconcile(
    repository: string,
    marker: string,
    since: string,
    signal?: AbortSignal,
  ): Promise<PublishedIssue | undefined>;
}

export type IssueDraftState =
  | 'draft'
  | 'awaiting_confirmation'
  | 'publishing'
  | 'published'
  | 'unknown'
  | 'failed'
  | 'cancelled';

export interface IssueDraft {
  readonly id: string;
  readonly version: number;
  readonly actor: IssueActor;
  readonly repository: string;
  readonly visibility: IssueRepository['visibility'];
  readonly title: string;
  readonly body: string;
  readonly contentHash: string;
  readonly marker: string;
  readonly sourceMessageIds: readonly string[];
  readonly notices: readonly string[];
  readonly duplicates: readonly ExistingIssue[];
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly state: IssueDraftState;
  readonly previewMessageId?: string;
  readonly approvedAt?: string;
  readonly result?: PublishedIssue;
}

export interface StoredIssueDraft {
  readonly draft: IssueDraft;
  readonly etag: string;
}

export interface IssueDraftStore {
  create(draft: IssueDraft, signal?: AbortSignal): Promise<StoredIssueDraft>;
  get(
    actor: Pick<IssueActor, 'guildId' | 'channelId'>,
    id: string,
    signal?: AbortSignal,
  ): Promise<StoredIssueDraft | undefined>;
  replace(
    previous: StoredIssueDraft,
    draft: IssueDraft,
    signal?: AbortSignal,
  ): Promise<StoredIssueDraft>;
}

export class IssueConflictError extends Error {
  public constructor() {
    super(
      'This issue draft changed or is already being submitted. View its latest status before continuing.',
    );
    this.name = 'IssueConflictError';
  }
}

export class IssuePolicyError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'IssuePolicyError';
  }
}

export class IssuePublishError extends Error {
  public constructor(
    message: string,
    public readonly outcomeUnknown: boolean,
    public readonly status?: number,
    public readonly requestId?: string,
  ) {
    super(message);
    this.name = 'IssuePublishError';
  }
}

export interface IssueDraftInput {
  readonly repository: string;
  readonly title: string;
  readonly body: string;
  readonly sourceMessageIds: readonly string[];
  readonly notices: readonly string[];
}
