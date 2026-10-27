import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin, ViteDevServer } from 'vite';
import { normalizePath } from 'vite';

type Awaitable<T> = T | Promise<T>;

type ReadText = (file: string) => Awaitable<string>;

export interface ExcerptPart {
  from: string;
  to?: string;
}

export interface ExcerptEntry {
  file: string;
  language: string;
  elision?: string;
  maxLines?: number;
  maxColumns?: number;
  parts: readonly ExcerptPart[];
}

export type ExcerptsManifest = Record<string, ExcerptEntry>;

export interface ResolvedExcerpt {
  file: string;
  language: string;
  lineCount: number;
  maxColumn: number;
  text: string;
}

export interface InjectedExcerpts {
  html: string;
  referencedFiles: string[];
  unusedIds: string[];
  usedIds: string[];
}

export interface ExcerptsPluginOptions {
  manifestPath?: string;
}

const DEFAULT_ELISION = '// …';
const DEFAULT_MAX_COLUMNS = 100;
const DEFAULT_MAX_LINES = 13;
const placeholderText = 'Excerpt injected at build time from the repository source.';
const PRE_WITH_CODE_PATTERN = /(?<preOpen><pre\b[^>]*\bdata-excerpt-id=(?<quote>['"])(?<id>[^'"]+)\k<quote>[^>]*>)(?<between>[\s\S]*?)(?<codeOpen><code\b(?<codeAttrs>[^>]*)>)(?<codeBody>[\s\S]*?)<\/code>(?<after>[\s\S]*?)<\/pre>/giu;

export async function resolveExcerpt(
  entry: ExcerptEntry,
  readText: ReadText,
): Promise<ResolvedExcerpt> {
  const normalizedEntry = validateEntry('<anonymous>', entry);
  let sourceText: string;
  try {
    sourceText = await readText(normalizedEntry.file);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Excerpt file missing: ${normalizedEntry.file}. ${detail}`);
  }

  const lines = normalizeLines(sourceText);
  const parts: string[] = [];
  let searchFrom = 0;

  for (const [index, part] of normalizedEntry.parts.entries()) {
    const fromAnchor = part.from.trim();
    const fromIndex = findAnchorLine(lines, fromAnchor, searchFrom);
    if (fromIndex < 0) {
      throw new Error(
        `Excerpt ${normalizedEntry.file} part ${index + 1} from anchor not found: ${part.from}`,
      );
    }

    const toAnchor = part.to;
    const toIndex =
      toAnchor === undefined
        ? fromIndex
        : toAnchor === '@block'
          ? findBlockEnd(lines, fromIndex)
          : findToAnchorLine(lines, toAnchor.trim(), fromIndex);

    if (toIndex < 0) {
      const reason = toAnchor === '@block' ? '@block unterminated' : `to anchor not found: ${toAnchor}`;
      throw new Error(
        `Excerpt ${normalizedEntry.file} part ${index + 1} ${reason} (from: ${part.from})`,
      );
    }

    parts.push(dedentPart(lines.slice(fromIndex, toIndex + 1), normalizedEntry.file, index, part.from));
    searchFrom = toIndex + 1;
  }

  const text = parts.join(`\n${normalizedEntry.elision}\n`);
  const resolvedLines = text.split('\n');
  const maxColumn = resolvedLines.reduce((width, line) => Math.max(width, line.length), 0);

  if (resolvedLines.length > normalizedEntry.maxLines) {
    throw new Error(
      `Excerpt ${normalizedEntry.file} exceeds maxLines ${normalizedEntry.maxLines}: ${resolvedLines.length}`,
    );
  }
  if (maxColumn > normalizedEntry.maxColumns) {
    throw new Error(
      `Excerpt ${normalizedEntry.file} exceeds maxColumns ${normalizedEntry.maxColumns}: ${maxColumn}`,
    );
  }

  return {
    file: normalizedEntry.file,
    language: normalizedEntry.language,
    lineCount: resolvedLines.length,
    maxColumn,
    text,
  };
}

export async function injectExcerpts(
  html: string,
  options: { manifest: ExcerptsManifest; readText: ReadText },
): Promise<InjectedExcerpts> {
  const manifest = validateManifest(options.manifest);
  const usedIds: string[] = [];
  const referencedFiles = new Set<string>();
  const cache = new Map<string, ResolvedExcerpt>();
  let output = '';
  let lastIndex = 0;

  for (const match of html.matchAll(PRE_WITH_CODE_PATTERN)) {
    const index = match.index;
    if (index === undefined) {
      continue;
    }

    const groups = match.groups;
    if (!groups) {
      continue;
    }

    output += html.slice(lastIndex, index);
    lastIndex = index + match[0].length;

    const excerptId = groups.id;
    const entry = manifest[excerptId];
    if (!entry) {
      throw new Error(`Unknown data-excerpt-id: ${excerptId}`);
    }

    const language = extractLanguage(groups.codeAttrs);
    if (language !== entry.language) {
      throw new Error(
        `Excerpt ${excerptId} language mismatch for ${entry.file}: expected language-${entry.language}, found ${language ? `language-${language}` : 'none'}`,
      );
    }

    let resolved = cache.get(excerptId);
    if (!resolved) {
      resolved = await resolveExcerptForId(excerptId, entry, options.readText);
      cache.set(excerptId, resolved);
      referencedFiles.add(resolved.file);
    }

    usedIds.push(excerptId);
    output += `${groups.preOpen}${groups.between}${groups.codeOpen}${escapeHtml(resolved.text)}</code>${groups.after}</pre>`;
  }

  output += html.slice(lastIndex);

  return {
    html: output,
    referencedFiles: [...referencedFiles],
    unusedIds: Object.keys(manifest).filter((id) => !cache.has(id)),
    usedIds,
  };
}

export function excerptsPlugin(options: ExcerptsPluginOptions = {}): Plugin {
  const pluginFile = fileURLToPath(import.meta.url);
  const deckDir = resolve(dirname(pluginFile), '..');
  const repoRoot = resolve(deckDir, '..');
  const manifestPath = normalizeFilePath(
    isAbsolute(options.manifestPath ?? '')
      ? (options.manifestPath as string)
      : resolve(repoRoot, options.manifestPath ?? 'deck/excerpts.json'),
  );
  const watchedFiles = new Set<string>();
  let server: ViteDevServer | undefined;
  let warnedUnusedKey = '';
  let isBuild = false;

  const readManifest = async (): Promise<ExcerptsManifest> => {
    let raw: string;
    try {
      raw = await readFile(manifestPath, 'utf8');
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Unable to read excerpts manifest ${manifestPath}: ${detail}`);
    }

    try {
      return validateManifest(JSON.parse(raw) as ExcerptsManifest);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid excerpts manifest ${manifestPath}: ${detail}`);
    }
  };

  const readSource: ReadText = async (file) => {
    const absolutePath = resolveRepoFile(repoRoot, file);
    return await readFile(absolutePath, 'utf8');
  };

  const warnUnused = (unusedIds: readonly string[]) => {
    if (unusedIds.length === 0) {
      warnedUnusedKey = '';
      return;
    }

    const key = unusedIds.join(',');
    if (key === warnedUnusedKey) {
      return;
    }

    warnedUnusedKey = key;
    console.warn(`[excerpts] Unused manifest entries: ${unusedIds.join(', ')}`);
  };

  return {
    name: 'excerpts',
    configResolved(config) {
      isBuild = config.command === 'build';
    },
    configureServer(configuredServer) {
      server = configuredServer;
      configuredServer.watcher.on('change', (changedFile) => {
        const normalized = normalizeFilePath(changedFile);
        if (watchedFiles.has(normalized)) {
          configuredServer.ws.send({ type: 'full-reload' });
        }
      });
    },
    transformIndexHtml: {
      order: 'pre',
      async handler(html: string): Promise<string> {
        const watchContext = this as unknown as { addWatchFile?: (file: string) => void };
        const manifest = await readManifest();
        const injected = await injectExcerpts(html, { manifest, readText: readSource });
        // A slide that never reached the injector would publish its placeholder text, and a manifest entry nobody uses is drift.
        if (injected.html.includes(placeholderText)) {
          throw new Error('A code panel still shows its excerpt placeholder. Check that its <pre> uses a quoted data-excerpt-id.');
        }
        if (isBuild && injected.unusedIds.length > 0) {
          throw new Error(`Unused excerpt manifest entries: ${injected.unusedIds.join(', ')}. Remove them or point a slide at them.`);
        }
        warnUnused(injected.unusedIds);

        const absoluteFiles = injected.referencedFiles.map((file) =>
          normalizeFilePath(resolveRepoFile(repoRoot, file)),
        );

        for (const file of absoluteFiles) {
          watchContext.addWatchFile?.(file);
          if (!watchedFiles.has(file)) {
            watchedFiles.add(file);
            server?.watcher.add(file);
          }
        }

        return injected.html;
      },
    },
  };
}

function dedentPart(
  lines: readonly string[],
  file: string,
  index: number,
  anchor: string,
): string {
  const trimmedLines = lines.map((line) => line.replace(/[ \t]+$/gu, ''));
  const nonEmptyLines = trimmedLines.filter((line) => line.trim().length > 0);
  let minIndent = Number.POSITIVE_INFINITY;

  for (const line of nonEmptyLines) {
    const indent = line.match(/^[ \t]*/u)?.[0] ?? '';
    if (indent.includes('\t')) {
      throw new Error(
        `Excerpt ${file} part ${index + 1} uses tab indentation (from: ${anchor})`,
      );
    }
    minIndent = Math.min(minIndent, indent.length);
  }

  const dedent = Number.isFinite(minIndent) ? minIndent : 0;
  return trimmedLines
    .map((line) => (line.trim().length === 0 ? '' : line.slice(dedent)))
    .join('\n');
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;');
}

function extractLanguage(codeAttributes: string): string | undefined {
  const classMatch = /\bclass=(['"])(.*?)\1/u.exec(codeAttributes);
  if (!classMatch) {
    return undefined;
  }

  return classMatch[2]
    .split(/\s+/u)
    .find((className) => className.startsWith('language-'))
    ?.slice('language-'.length);
}

function findAnchorLine(lines: readonly string[], anchor: string, startIndex: number): number {
  for (let index = startIndex; index < lines.length; index++) {
    if (lines[index].trim().startsWith(anchor)) {
      return index;
    }
  }
  return -1;
}

function findBlockEnd(lines: readonly string[], fromIndex: number): number {
  const fromIndent = indentationOf(lines[fromIndex]);
  for (let index = fromIndex + 1; index < lines.length; index++) {
    const trimmed = lines[index].trim();
    if ((trimmed.startsWith('}') || trimmed.startsWith(')') || trimmed.startsWith(']')) && indentationOf(lines[index]) <= fromIndent) {
      return index;
    }
  }
  return -1;
}

function findToAnchorLine(lines: readonly string[], anchor: string, startIndex: number): number {
  for (let index = startIndex; index < lines.length; index++) {
    if (lines[index].trim().startsWith(anchor)) {
      return index;
    }
  }
  return -1;
}

function indentationOf(line: string): number {
  const indent = line.match(/^[ \t]*/u)?.[0] ?? '';
  return indent.length;
}

function normalizeFilePath(file: string): string {
  return normalizePath(resolve(file));
}

function normalizeLines(text: string): string[] {
  return text.replace(/\r\n/gu, '\n').replace(/\r/gu, '\n').split('\n');
}

async function resolveExcerptForId(excerptId: string, entry: ExcerptEntry, readText: ReadText): Promise<ResolvedExcerpt> {
  try {
    return await resolveExcerpt(entry, readText);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Excerpt ${excerptId} (${entry.file}): ${detail}`);
  }
}

function resolveRepoFile(repoRoot: string, manifestFile: string): string {
  if (manifestFile.includes('\\')) {
    throw new Error(`Manifest file must use POSIX separators: ${manifestFile}`);
  }
  if (manifestFile.startsWith('/') || manifestFile.includes('..')) {
    throw new Error(`Manifest file must stay within the repo root: ${manifestFile}`);
  }
  return resolve(repoRoot, ...manifestFile.split('/'));
}

function validateEntry(excerptId: string, entry: ExcerptEntry): Required<ExcerptEntry> {
  if (!entry || typeof entry !== 'object') {
    throw new Error(`Manifest entry ${excerptId} must be an object.`);
  }
  if (typeof entry.file !== 'string' || entry.file.length === 0) {
    throw new Error(`Manifest entry ${excerptId} must define a non-empty file.`);
  }
  if (typeof entry.language !== 'string' || entry.language.length === 0) {
    throw new Error(`Manifest entry ${excerptId} must define a non-empty language.`);
  }
  if (!Array.isArray(entry.parts) || entry.parts.length === 0) {
    throw new Error(`Manifest entry ${excerptId} must define at least one part.`);
  }
  if (entry.elision !== undefined && (typeof entry.elision !== 'string' || entry.elision.includes('\n'))) {
    throw new Error(`Manifest entry ${excerptId} has an invalid elision.`);
  }
  if (entry.maxLines !== undefined && (!Number.isInteger(entry.maxLines) || entry.maxLines <= 0)) {
    throw new Error(`Manifest entry ${excerptId} has an invalid maxLines.`);
  }
  if (entry.maxColumns !== undefined && (!Number.isInteger(entry.maxColumns) || entry.maxColumns <= 0)) {
    throw new Error(`Manifest entry ${excerptId} has an invalid maxColumns.`);
  }

  const parts = entry.parts.map((part, index) => {
    if (!part || typeof part !== 'object') {
      throw new Error(`Manifest entry ${excerptId} part ${index + 1} must be an object.`);
    }
    if (typeof part.from !== 'string' || part.from.trim().length === 0) {
      throw new Error(`Manifest entry ${excerptId} part ${index + 1} must define a non-empty from.`);
    }
    if (part.to !== undefined && (typeof part.to !== 'string' || part.to.trim().length === 0)) {
      throw new Error(`Manifest entry ${excerptId} part ${index + 1} has an invalid to.`);
    }
    return {
      from: part.from,
      to: part.to,
    };
  });

  return {
    file: entry.file,
    language: entry.language,
    elision: entry.elision ?? DEFAULT_ELISION,
    maxColumns: entry.maxColumns ?? DEFAULT_MAX_COLUMNS,
    maxLines: entry.maxLines ?? DEFAULT_MAX_LINES,
    parts,
  };
}

function validateManifest(manifest: ExcerptsManifest): ExcerptsManifest {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('Manifest root must be an object.');
  }

  const validatedEntries = Object.entries(manifest).map(([excerptId, entry]) => [
    excerptId,
    validateEntry(excerptId, entry),
  ]);

  return Object.fromEntries(validatedEntries);
}




