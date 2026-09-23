import { describe, expect, it } from 'vitest';
import {
  currentIssuePolicy,
  disabledIssuePolicy,
  parseIssuePolicy,
} from '../../src/issues/policy.js';
import type { RuntimeConfigSnapshot } from '../../src/runtime-config.js';

const policy = {
  enabled: true,
  allowedUserIds: ['123', '456'],
  allowedChannelIds: ['789'],
  allowedRepositories: ['Microsoft/Aspire'],
};

describe('issue filing policy', () => {
  it('defaults to deny-all and normalizes repository names', () => {
    expect(parseIssuePolicy(undefined)).toEqual(disabledIssuePolicy);
    expect(parseIssuePolicy(JSON.stringify(policy)).allowedRepositories).toEqual([
      'microsoft/aspire',
    ]);
  });

  it('never treats an empty filing allowlist as open access', () => {
    for (const key of ['allowedUserIds', 'allowedChannelIds', 'allowedRepositories']) {
      expect(() => parseIssuePolicy({ ...policy, [key]: [] })).toThrow();
    }
  });

  it('requires fresh validated runtime configuration and existing bot access', () => {
    const snapshot: RuntimeConfigSnapshot = {
      available: true,
      allowedUserIds: new Set(['123']),
      groundingDetailsMode: 'collapsed',
      source: 'azure-app-configuration',
      revision: 'a',
      issuePolicy: parseIssuePolicy(policy),
      issuePolicyAvailable: true,
      validatedAt: 1_000,
    };
    expect(currentIssuePolicy(snapshot, 1_001).allowedUserIds).toEqual(['123']);
    expect(currentIssuePolicy(snapshot, 62_000).enabled).toBe(false);
    expect(currentIssuePolicy({ ...snapshot, issuePolicyAvailable: false }, 1_001).enabled).toBe(
      false,
    );
    expect(currentIssuePolicy({ ...snapshot, available: false }, 1_001).enabled).toBe(false);
  });
});
