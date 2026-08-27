import { describe, expect, it } from 'vitest';
import { GitHubRepositoryPolicy } from '../../src/agent/github-policy.js';

const policy = new GitHubRepositoryPolicy(['microsoft/aspire', 'microsoft/aspire.dev']);

describe('GitHubRepositoryPolicy', () => {
  it('adds a server-controlled repository qualifier', () => {
    expect(policy.scopeCodeQuery('DistributedApplicationBuilder')).toBe(
      'DistributedApplicationBuilder repo:microsoft/aspire',
    );
  });

  it('preserves an allowed explicit repository and splits it safely', () => {
    expect(policy.scopeCodeQuery('term repo:microsoft/aspire.dev')).toBe(
      'term repo:microsoft/aspire.dev',
    );
    expect(policy.split('microsoft/aspire.dev')).toEqual({
      owner: 'microsoft',
      repo: 'aspire.dev',
    });
  });

  it('rejects invalid or empty policy configuration', () => {
    expect(() => new GitHubRepositoryPolicy([])).toThrow();
    expect(() => new GitHubRepositoryPolicy(['invalid'])).toThrow();
    expect(() => policy.ensureAllowed('other/repo')).toThrow();
  });

  it.each([
    'term repo:microsoft/aspire OR org:private',
    'term | repo:private/repo',
    'term user:someone',
    'term repo:private/repo',
  ])('rejects scope expansion: %s', (query) => {
    expect(() => policy.scopeCodeQuery(query)).toThrow();
  });

  it('accepts URLs only for configured repositories', () => {
    expect(policy.isAllowedUrl('https://github.com/microsoft/aspire/issues/1')).toBe(true);
    expect(policy.isAllowedUrl('https://github.com/other/repo/issues/1')).toBe(false);
  });
});
