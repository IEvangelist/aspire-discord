import { z } from 'zod';
import type { RuntimeConfigSnapshot } from '../runtime-config.js';
import type { IssuePolicy } from './types.js';

export const disabledIssuePolicy: IssuePolicy = Object.freeze({
  enabled: false,
  allowedUserIds: Object.freeze([]),
  allowedChannelIds: Object.freeze([]),
  allowedRepositories: Object.freeze([]),
});

const identifiers = z.array(z.string().regex(/^[1-9]\d*$/u)).max(500);
const policySchema = z
  .strictObject({
    enabled: z.boolean(),
    allowedUserIds: identifiers,
    allowedChannelIds: identifiers,
    allowedRepositories: z
      .array(
        z
          .string()
          .regex(/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/iu)
          .transform((value) => value.toLowerCase()),
      )
      .max(20),
  })
  .refine(
    (value) =>
      !value.enabled ||
      (value.allowedUserIds.length > 0 &&
        value.allowedChannelIds.length > 0 &&
        value.allowedRepositories.length > 0),
    'Enabled issue filing requires explicit users, channels, and repositories.',
  );

export function parseIssuePolicy(value: unknown): IssuePolicy {
  if (value === undefined) {
    return disabledIssuePolicy;
  }
  return policySchema.parse(typeof value === 'string' ? JSON.parse(value) : value);
}

export function currentIssuePolicy(snapshot: RuntimeConfigSnapshot, now = Date.now()): IssuePolicy {
  if (!snapshot.available || snapshot.issuePolicyAvailable !== true) {
    return disabledIssuePolicy;
  }
  if (
    snapshot.source === 'azure-app-configuration' &&
    (snapshot.validatedAt === undefined || now - snapshot.validatedAt > 60_000)
  ) {
    return disabledIssuePolicy;
  }
  const policy = snapshot.issuePolicy ?? disabledIssuePolicy;
  return {
    ...policy,
    allowedUserIds: policy.allowedUserIds.filter(
      (id) => snapshot.allowedUserIds.size === 0 || snapshot.allowedUserIds.has(id),
    ),
  };
}
