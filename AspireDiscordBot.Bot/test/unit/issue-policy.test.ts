import { describe, expect, it } from 'vitest';
import {
  currentIssuePolicy,
  disabledIssuePolicy,
  parseIssuePolicy,
  isIssueLocationAllowed,
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
  it('allows every current and future channel or thread only in explicitly approved servers', () => {
    const guildPolicy = parseIssuePolicy({
      ...policy,
      allowedChannelIds: [],
      allowedGuildIds: ['123456'],
    });
    for (const channel of ['789', '998877', '554433']) {
      expect(isIssueLocationAllowed(guildPolicy, '123456', channel)).toBe(true);
      expect(isIssueLocationAllowed(guildPolicy, '654321', channel)).toBe(false);
      expect(isIssueLocationAllowed(guildPolicy, null, channel)).toBe(false);
    }
    expect(isIssueLocationAllowed(guildPolicy, '', '789')).toBe(false);
    expect(isIssueLocationAllowed(guildPolicy, '123456', '')).toBe(false);
    expect(isIssueLocationAllowed(parseIssuePolicy(policy), '123456', '789')).toBe(true);
    expect(isIssueLocationAllowed(parseIssuePolicy(policy), '123456', '998877')).toBe(false);
    for (const invalid of [[], ['*'], [''], [123456], ['not-a-server']]) {
      expect(() =>
        parseIssuePolicy({ ...policy, allowedChannelIds: [], allowedGuildIds: invalid }),
      ).toThrow();
    }
    expect(() =>
      parseIssuePolicy({
        ...policy,
        allowedChannelIds: [],
        allowedGuildIds: ['123456'],
        allowedUserIds: [],
      }),
    ).toThrow();
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
