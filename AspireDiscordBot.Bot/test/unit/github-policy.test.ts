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

  it('clamps repository searches while preserving useful qualifiers and quoted text', () => {
    const query =
      '"exact quoted text" author:someone commenter:someone involves:someone reviewed-by:someone created:>=2026-01-01 updated:<2026-09-23 is:open label:"good first issue" sort:updated-desc';
    expect(policy.scopeRepositoryQuery(query, 'microsoft/aspire.dev')).toBe(
      `${query} repo:microsoft/aspire.dev`,
    );
    expect(policy.scopeRepositoryQuery('term repo:"Microsoft/Aspire"', 'microsoft/aspire')).toBe(
      'term repo:microsoft/aspire',
    );
  });

  it.each([
    'term OR repo:outside/repo',
    'term or term',
    'term NOT term',
    'term | repo:outside/repo',
    '(term) repo:outside/repo',
    'term repo:outside/repo',
    'term repo:microsoft/aspire.dev',
    'term -repo:microsoft/aspire',
    'term repo:microsoft/aspire,repo:outside/repo',
    'term repo:microsoft/aspire*',
    'term org:outside',
    'term -org:outside',
    'term user:outside',
    'term owner:outside',
    '"term OR repo:outside/repo"',
    '"repo:outside/repo"',
    '"term repo:outside/repo"',
    '"term org:outside"',
    '"term )"',
    'term "unterminated',
    'term \\',
  ])('rejects repository scope escapes: %s', (query) => {
    expect(() => policy.scopeRepositoryQuery(query, 'microsoft/aspire')).toThrow();
  });

  it.each([
    'http://github.com/microsoft/aspire/issues/1',
    'https://user:secret@github.com/microsoft/aspire/issues/1',
    'https://github.com:444/microsoft/aspire/issues/1',
    'https://github.com/microsoft/aspire/issues/1?token=secret',
    'https://github.com.evil.example/microsoft/aspire/issues/1',
  ])('rejects unsafe citation and linked URLs: %s', (url) => {
    expect(policy.isAllowedUrl(url)).toBe(false);
    expect(policy.parseLinkedResource(url)).toBeUndefined();
  });

  it('allows HTTPS default ports, API URLs and issue-comment fragments', () => {
    expect(policy.isAllowedUrl('https://github.com:443/microsoft/aspire/issues/1')).toBe(true);
    expect(policy.isAllowedUrl('https://api.github.com/repos/microsoft/aspire/issues/1')).toBe(
      true,
    );
    expect(policy.isAllowedUrl('https://github.com/microsoft/aspire/issues/1#issuecomment-2')).toBe(
      true,
    );
  });

  it('parses only bounded read-only resources from allowed GitHub URLs', () => {
    expect(
      policy.parseLinkedResource('https://github.com/microsoft/aspire/issues/123#issuecomment-1'),
    ).toEqual({
      issueNumber: 123,
      kind: 'issue',
      repository: 'microsoft/aspire',
    });
    expect(
      policy.parseLinkedResource(
        'https://github.com/microsoft/aspire/blob/main/src/Aspire.Hosting/README.md',
      ),
    ).toEqual({
      kind: 'file',
      path: 'src/Aspire.Hosting/README.md',
      ref: 'main',
      repository: 'microsoft/aspire',
    });
    expect(policy.parseLinkedResource('https://github.com/other/repo/issues/123')).toBeUndefined();
    expect(
      policy.parseLinkedResource('https://github.com/microsoft/aspire/settings'),
    ).toBeUndefined();
  });
});
