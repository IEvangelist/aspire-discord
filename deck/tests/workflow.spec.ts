import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const deckRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(deckRoot, '..');
const workflowPath = resolve(repoRoot, '.github', 'workflows', 'deck.yml');
const excerptsPath = resolve(deckRoot, 'excerpts.json');

function indentOf(line: string) {
  return line.length - line.trimStart().length;
}

function findLineIndex(lines: string[], value: string, indent?: number) {
  return lines.findIndex((line) => {
    if (line.trim() !== value) {
      return false;
    }
    return indent === undefined ? true : indentOf(line) === indent;
  });
}

function captureBlock(lines: string[], startIndex: number) {
  const baseIndent = indentOf(lines[startIndex]);
  const block: string[] = [];
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === '') {
      block.push(line);
      continue;
    }
    if (indentOf(line) <= baseIndent) {
      break;
    }
    block.push(line);
  }
  return block;
}

test('workflow pins actions, tracks excerpt sources, and avoids secrets', ({}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-light', 'The workflow checks run once.');

  const workflow = readFileSync(workflowPath, 'utf8').replace(/\r\n/g, '\n');
  const lines = workflow.split('\n');
  const excerpts = JSON.parse(readFileSync(excerptsPath, 'utf8')) as Record<string, { file: string }>;
  const excerptFiles = [...new Set(Object.values(excerpts).map((entry) => entry.file))];

  const usesLines = lines.filter((line) => line.includes('uses:'));
  expect(usesLines.length).toBeGreaterThan(0);
  for (const line of usesLines) {
    expect(line.trim()).toMatch(/^(-\s+)?uses:\s+[^@\s]+@[0-9a-f]{40}\s+#\s+v[\w.-]+$/);
  }

  const permissionsIndex = findLineIndex(lines, 'permissions:', 0);
  expect(permissionsIndex).toBeGreaterThanOrEqual(0);
  const permissionsBlock = captureBlock(lines, permissionsIndex);
  expect(permissionsBlock.map((line) => line.trim()).filter(Boolean)).toEqual(['contents: read']);

  const pullRequestIndex = findLineIndex(lines, 'pull_request:', 2);
  expect(pullRequestIndex).toBeGreaterThanOrEqual(0);
  const pullRequestBlock = captureBlock(lines, pullRequestIndex).map((line) => line.trim());
  expect(pullRequestBlock).toContain('paths:');
  const expectedPaths = ['- deck/**', '- docs/deck/**', '- .github/workflows/deck.yml', ...excerptFiles.map((file) => `- ${file}`)];
  for (const expectedPath of expectedPaths) {
    expect(pullRequestBlock).toContain(expectedPath);
  }

  const deckIndex = findLineIndex(lines, 'deck:', 2);
  expect(deckIndex).toBeGreaterThanOrEqual(0);
  const deckBlock = captureBlock(lines, deckIndex).join('\n');
  expect(deckBlock).toContain("node-version: '24'");
  expect(deckBlock).toContain('npm ci --prefix deck --registry=https://registry.npmjs.org --no-fund --no-audit');

  const deployIndex = findLineIndex(lines, 'deploy:', 2);
  expect(deployIndex).toBeGreaterThanOrEqual(0);
  const deployBlock = captureBlock(lines, deployIndex).join('\n');
  expect(deployBlock).toContain("if: github.ref == 'refs/heads/main' && github.event_name != 'pull_request'");
  expect(deployBlock).toContain('uses: actions/deploy-pages@368f82528645a54fb793d4d04e342629a3f51346 # v5.0.1');

  expect(workflow).not.toMatch(/\bsecrets\./);
});
