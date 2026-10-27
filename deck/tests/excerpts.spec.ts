import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  injectExcerpts,
  resolveExcerpt,
  type ExcerptEntry,
  type ExcerptsManifest,
} from '../plugins/excerpts';

const deckDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(deckDir, '..');
const manifestPath = resolve(deckDir, 'excerpts.json');
const skipReason = 'Node-only excerpt tests run once.';

function skipUnlessDesktopLight(projectName: string) {
  test.skip(projectName !== 'desktop-light', skipReason);
}

function dedent(lines: readonly string[]): string[] {
  const trimmed = lines.map((line) => line.replace(/[ \t]+$/gu, ''));
  const nonEmpty = trimmed.filter((line) => line.trim().length > 0);
  const minIndent =
    nonEmpty.length === 0
      ? 0
      : Math.min(...nonEmpty.map((line) => line.match(/^ */u)?.[0].length ?? 0));
  return trimmed.map((line) => (line.trim().length === 0 ? '' : line.slice(minIndent)));
}

test('resolveExcerpt handles single-line excerpts and CRLF input', async ({}, testInfo) => {
  skipUnlessDesktopLight(testInfo.project.name);
  const entry: ExcerptEntry = {
    file: 'sample.ts',
    language: 'typescript',
    parts: [{ from: 'const answer = 42;' }],
  };
  const source = 'const before = 0;\r\nconst answer = 42;  \r\nconst html = 1 < 2 && 3 > 1;\r\n';
  const resolved = await resolveExcerpt(entry, async () => source);

  expect(resolved.text).toBe('const answer = 42;');
  expect(resolved.lineCount).toBe(1);
  expect(resolved.maxColumn).toBe('const answer = 42;'.length);
});

test('resolveExcerpt handles multi-line ranges and @block extraction', async ({}, testInfo) => {
  skipUnlessDesktopLight(testInfo.project.name);
  const source = [
    'function alpha() {',
    '  const start = true;',
    '  return start;',
    '}',
    'function beta() {',
    '  if (ready) {',
    '    run();',
    '  }',
    '}',
  ].join('\n');

  const rangeEntry: ExcerptEntry = {
    file: 'range.ts',
    language: 'typescript',
    parts: [{ from: 'function alpha()', to: 'return start;' }],
  };
  const blockEntry: ExcerptEntry = {
    file: 'block.ts',
    language: 'typescript',
    parts: [{ from: 'function beta()', to: '@block' }],
  };

  const range = await resolveExcerpt(rangeEntry, async () => source);
  const block = await resolveExcerpt(blockEntry, async () => source);

  expect(range.text).toBe(['function alpha() {', '  const start = true;', '  return start;'].join('\n'));
  expect(block.text).toBe(['function beta() {', '  if (ready) {', '    run();', '  }', '}'].join('\n'));
});

test('resolveExcerpt joins multiple parts with one elision line and dedents each part independently', async ({}, testInfo) => {
  skipUnlessDesktopLight(testInfo.project.name);
  const entry: ExcerptEntry = {
    file: 'multi.ts',
    language: 'typescript',
    elision: '# cut',
    parts: [
      { from: 'const first = [', to: '];' },
      { from: 'const second = {', to: '};' },
    ],
  };
  const source = [
    'wrapper();',
    '    const first = [',
    '      one,',
    '      two,',
    '    ];',
    '',
    '  const second = {',
    '    three: true,',
    '  };',
  ].join('\n');

  const resolved = await resolveExcerpt(entry, async () => source);

  expect(resolved.text).toBe([
    'const first = [',
    '  one,',
    '  two,',
    '];',
    '# cut',
    'const second = {',
    '  three: true,',
    '};',
  ].join('\n'));
});

test('resolveExcerpt rejects tab indentation, missing anchors, unterminated blocks, and size limits', async ({}, testInfo) => {
  skipUnlessDesktopLight(testInfo.project.name);

  await expect(
    resolveExcerpt(
      { file: 'tabs.ts', language: 'typescript', parts: [{ from: 'const tabbed = {', to: '};' }] },
      async () => ['\tconst tabbed = {', '\t  ok: true,', '\t};'].join('\n'),
    ),
  ).rejects.toThrow('uses tab indentation');

  await expect(
    resolveExcerpt(
      { file: 'missing.ts', language: 'typescript', parts: [{ from: 'missing();' }] },
      async () => 'present();\n',
    ),
  ).rejects.toThrow('from anchor not found');

  await expect(
    resolveExcerpt(
      { file: 'block.ts', language: 'typescript', parts: [{ from: 'function open()', to: '@block' }] },
      async () => ['function open() {', '  if (true) {', '    run();'].join('\n'),
    ),
  ).rejects.toThrow('@block unterminated');

  await expect(
    resolveExcerpt(
      {
        file: 'size.ts',
        language: 'typescript',
        maxColumns: 10,
        maxLines: 2,
        parts: [{ from: 'const longLine =', to: 'const alsoLong = 2;' }],
      },
      async () => ['const longLine = 1234567890;', 'const alsoLong = 2;'].join('\n'),
    ),
  ).rejects.toThrow('exceeds maxColumns 10');

  await expect(
    resolveExcerpt(
      {
        file: 'lines.ts',
        language: 'typescript',
        maxLines: 1,
        parts: [{ from: 'line one', to: 'line two' }],
      },
      async () => ['line one', 'line two'].join('\n'),
    ),
  ).rejects.toThrow('exceeds maxLines 1');
});

test('injectExcerpts rejects language mismatches and escapes HTML-sensitive characters', async ({}, testInfo) => {
  skipUnlessDesktopLight(testInfo.project.name);
  const manifest: ExcerptsManifest = {
    escaped: {
      file: 'escape.ts',
      language: 'typescript',
      parts: [{ from: "const html = '<tag>&value</tag>';", to: 'const comparison = a < b && c > d;' }],
    },
  };
  const source = [
    "const html = '<tag>&value</tag>';",
    'const comparison = a < b && c > d;',
  ].join('\n');

  await expect(
    injectExcerpts(
      '<pre data-excerpt-id="escaped"><code class="language-javascript">placeholder</code></pre>',
      { manifest, readText: async () => source },
    ),
  ).rejects.toThrow('language mismatch');

  const injected = await injectExcerpts(
    '<pre data-excerpt-id="escaped"><code class="language-typescript">placeholder</code></pre>',
    { manifest, readText: async () => source },
  );

  expect(injected.html).toContain('&lt;tag&gt;&amp;value&lt;/tag&gt;');
  expect(injected.html).toContain('a &lt; b &amp;&amp; c &gt; d');
});

test('real manifest drift check resolves every excerpt and rejects obvious secret patterns', async ({}, testInfo) => {
  skipUnlessDesktopLight(testInfo.project.name);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as ExcerptsManifest;
  const obviousSecrets = [
    /\bsk-[A-Za-z0-9]{20,}\b/u,
    /\bgh[pousr]_[A-Za-z0-9]{20,}\b/u,
    /\bAIza[0-9A-Za-z\-_]{35}\b/u,
    /-----BEGIN [A-Z ]+PRIVATE KEY-----/u,
  ];

  for (const [excerptId, entry] of Object.entries(manifest)) {
    const resolved = await resolveExcerpt(entry, async (file) => {
      return await readFile(resolve(repoRoot, ...file.split('/')), 'utf8');
    });
    const lines = resolved.text.split('\n');
    const maxColumn = lines.reduce((width, line) => Math.max(width, line.length), 0);

    expect(lines.length, `${excerptId} line count`).toBeLessThanOrEqual(entry.maxLines ?? 13);
    expect(maxColumn, `${excerptId} max column`).toBeLessThanOrEqual(entry.maxColumns ?? 100);
    for (const line of lines) {
      expect(line.includes('\t'), `${excerptId} should not contain tabs`).toBe(false);
      for (const pattern of obviousSecrets) {
        expect(pattern.test(line), `${excerptId} matched ${pattern}`).toBe(false);
      }
    }
  }
});

test('injectExcerpts integrates with the real empty-mode excerpt', async ({}, testInfo) => {
  skipUnlessDesktopLight(testInfo.project.name);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as ExcerptsManifest;
  const html = '<pre data-label="Example" data-excerpt-id="empty-mode"><code class="language-typescript">legacy</code></pre>';
  const sourcePath = resolve(repoRoot, 'AspireDiscordBot.Bot', 'src', 'agent', 'copilot-runtime.ts');
  const source = await readFile(sourcePath, 'utf8');
  const lines = source.replace(/\r\n/gu, '\n').split('\n');

  const findAfter = (anchor: string, start: number) => {
    for (let index = start; index < lines.length; index++) {
      if (lines[index].trim().startsWith(anchor)) {
        return index;
      }
    }
    throw new Error(`Anchor not found in integration helper: ${anchor}`);
  };

  const modeLine = findAfter("mode: 'empty',", 0);
  const availableToolsLine = findAfter("availableTools: ['custom:*'],", modeLine + 1);
  const configStartLine = findAfter('enableConfigDiscovery: false,', availableToolsLine + 1);
  const configEndLine = findAfter('enableSkills: false,', configStartLine);
  const expected = [
    lines[modeLine].trim(),
    '// …',
    lines[availableToolsLine].trim(),
    '// …',
    ...dedent(lines.slice(configStartLine, configEndLine + 1)),
  ].join('\n');

  const injected = await injectExcerpts(html, {
    manifest,
    readText: async (file) => await readFile(resolve(repoRoot, ...file.split('/')), 'utf8'),
  });

  expect(injected.usedIds).toEqual(['empty-mode']);
  expect(injected.html).toContain(expected);
});
