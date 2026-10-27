import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { scanDirectory, scanText } from '../scripts/scan-public-output.mjs';

const deckRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const buildDirectory = resolve(deckRoot, process.env.DECK_OUT_DIR ?? 'dist');

const positiveCases = [
  { name: 'guid', file: 'sample.html', text: '01234567-89ab-cdef-0123-456789abcdef', expectedRule: 'guid' },
  { name: 'discord-snowflake', file: 'sample.md', text: '123456789012345678', expectedRule: 'discord-snowflake' },
  { name: 'private-hostname', file: 'sample.ts', text: 'https://demo.openai.azure.com', expectedRule: 'private-hostname' },
  { name: 'resource-name-fragment literal', file: 'sample.json', text: 'aspire-discord-prod', expectedRule: 'resource-name-fragment' },
  { name: 'resource-name-fragment hashed', file: 'sample.txt', text: 'aspirediscorda1b2c3d4', expectedRule: 'resource-name-fragment' },
  { name: 'github-token', file: 'sample.js', text: 'ghp_1234567890abcdEFGHijkl', expectedRule: 'github-token' },
  { name: 'github-pat', file: 'sample.js', text: 'github_pat_1234567890abcdefghijkLMNOP', expectedRule: 'github-pat' },
  { name: 'aws-access-key-id', file: 'sample.txt', text: 'AKIA1234567890ABCDEF', expectedRule: 'aws-access-key-id' },
  { name: 'jwt', file: 'sample.json', text: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signaturePart123', expectedRule: 'jwt' },
  { name: 'pem-header', file: 'sample.md', text: '-----BEGIN PRIVATE KEY-----', expectedRule: 'pem-header' },
  { name: 'discord-bot-token', file: 'sample.txt', text: 'abcdefghijklmnopqrstuvwx.abcdef.abcdefghijklmnopqrstuvwxyzABCDEF', expectedRule: 'discord-bot-token' },
  { name: 'sensitive-assignment', file: 'sample.ts', text: 'const token = "superSecretValue";', expectedRule: 'sensitive-assignment' },
  { name: 'specific-id', file: 'sample.svg', text: '<metadata>163850423</metadata>', expectedRule: 'specific-id' },
  { name: 'private-repo-link', file: 'sample.html', text: 'https://github.com/IEvangelist/aspire-discord', expectedRule: 'private-repo-link' },
];

const negativeCases = [
  { name: 'guid ignored in js', file: 'safe.js', text: '01234567-89ab-cdef-0123-456789abcdef' },
  { name: 'snowflake ignored in css', file: 'safe.css', text: '123456789012345678' },
  { name: 'descriptive tokenScope is safe', file: 'safe.ts', text: 'const tokenScope = "https://example.test/.default";' },
  { name: 'profile link is allowed', file: 'safe.html', text: 'https://github.com/IEvangelist' },
  { name: 'reference repo link is allowed', file: 'safe.html', text: 'https://github.com/IEvangelist/inside-aspire' },
  { name: 'copilot sdk link is allowed', file: 'safe.html', text: 'https://github.com/github/copilot-sdk' },
  { name: 'published deck url is allowed', file: 'safe.md', text: 'https://ievangelist.github.io/aspire-discord/' },
  { name: 'base path is allowed', file: 'safe.txt', text: '/aspire-discord/' },
  { name: 'social links are allowed', file: 'safe.md', text: 'https://x.com/davidpine7 https://bsky.app/profile/davidpine.dev https://www.linkedin.com/in/dpine/' },
  { name: 'short secret value stays below threshold', file: 'safe.ts', text: 'const token = "short";' },
];

test('public-safety rules detect each banned shape exactly once', ({}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-light', 'The source-only scanner tests run once.');
  for (const fixture of positiveCases) {
    const findings = scanText(fixture.text, fixture.file);
    expect(findings.map((finding) => finding.rule), fixture.name).toContain(fixture.expectedRule);
  }
});

test('public-safety rules keep approved public links and low-risk text', ({}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-light', 'The source-only scanner tests run once.');
  for (const fixture of negativeCases) {
    expect(scanText(fixture.text, fixture.file), fixture.name).toEqual([]);
  }
});

test('scan results never echo the matched secret value', ({}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-light', 'The source-only scanner tests run once.');
  const secret = 'github_pat_1234567890abcdefghijkLMNOP';
  const findings = scanText(secret, 'secret.txt');
  expect(findings).toEqual([{ rule: 'github-pat', file: 'secret.txt', line: 1 }]);
  expect(JSON.stringify(findings)).not.toContain(secret);
});

test('real built output and real deck sources stay public-safe', ({}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-light', 'The source-only scanner tests run once.');
  expect(scanDirectory(buildDirectory)).toEqual([]);
  expect(scanDirectory(undefined, { sources: true })).toEqual([]);
});
