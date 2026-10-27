import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const deckRoot = resolve(scriptDirectory, '..');
const repoRoot = resolve(deckRoot, '..');
const defaultBuildDirectory = resolve(deckRoot, process.env.DECK_OUT_DIR ?? 'dist');

const guidExtensions = new Set(['.html', '.json', '.txt', '.md', '.svg']);
const snowflakeExtensions = new Set(['.html', '.json', '.txt', '.md']);
const textExtensions = new Set(['.html', '.css', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json', '.svg', '.txt', '.md', '.yml', '.yaml']);
const sourceRoots = [
  resolve(deckRoot, 'index.html'),
  resolve(deckRoot, 'excerpts.json'),
  resolve(deckRoot, 'src'),
  resolve(deckRoot, 'public'),
];

const rules = [
  { name: 'guid', applies: (ext) => guidExtensions.has(ext), pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i },
  { name: 'discord-snowflake', applies: (ext) => snowflakeExtensions.has(ext), pattern: /(?<!\d)\d{17,20}(?!\d)/ },
  {
    name: 'private-hostname',
    applies: (ext) => textExtensions.has(ext),
    pattern: /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:openai\.azure\.com|vault\.azure\.net|azconfig\.io|table\.core\.windows\.net|blob\.core\.windows\.net|search\.windows\.net|azurecontainerapps\.io|azurecr\.io|cognitiveservices\.azure\.com|services\.ai\.azure\.com|applicationinsights\.azure\.com)\b/i,
  },
  {
    name: 'resource-name-fragment',
    applies: (ext) => textExtensions.has(ext),
    pattern: /(?:\bffccd7\b|\baspire-discord-(?:prod|blue|green)\b|\baspire-issues\b|\baspirediscord[-_]?[a-f0-9]{4,}\b)/i,
  },
  { name: 'github-token', applies: (ext) => textExtensions.has(ext), pattern: /\bgh[pousr]_[A-Za-z0-9_]{8,}\b/ },
  { name: 'github-pat', applies: (ext) => textExtensions.has(ext), pattern: /\bgithub_pat_[A-Za-z0-9_]{16,}\b/ },
  { name: 'aws-access-key-id', applies: (ext) => textExtensions.has(ext), pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'jwt', applies: (ext) => textExtensions.has(ext), pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/ },
  { name: 'pem-header', applies: (ext) => textExtensions.has(ext), pattern: /-----BEGIN [A-Z0-9 ]+-----/ },
  { name: 'discord-bot-token', applies: (ext) => textExtensions.has(ext), pattern: /\b[A-Za-z0-9_-]{24}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{24,}\b/ },
  {
    name: 'sensitive-assignment',
    applies: (ext) => textExtensions.has(ext),
    pattern: /(?:^|[\s{,(])(?:["']?(?:password|secret|token|api[_-]?key)["']?|(?:const|let|var)\s+(?:password|secret|token|api[_-]?key))\s*[:=]\s*["'][^"'\r\n]{8,}["']/i,
  },
  { name: 'specific-id', applies: (ext) => textExtensions.has(ext), pattern: /\b(?:4968096|163850423)\b/ },
  { name: 'private-repo-link', applies: (ext) => textExtensions.has(ext), pattern: /(?:https?:\/\/)?github\.com\/IEvangelist\/aspire-discord(?:[\/?#][^\s"')<>]*)?/i },
];

function toDisplayPath(filePath) {
  return relative(repoRoot, filePath).replace(/\\/g, '/');
}

function isTextExtension(filePath) {
  return textExtensions.has(extname(filePath).toLowerCase());
}

function readUtf8(filePath) {
  return readFileSync(filePath, 'utf8').replace(/^\ufeff/, '');
}

function walkFiles(entryPath) {
  const stat = statSync(entryPath);
  if (stat.isDirectory()) {
    return readdirSync(entryPath)
      .map((name) => walkFiles(resolve(entryPath, name)))
      .flat();
  }
  return [entryPath];
}

function collectSourceFiles() {
  return sourceRoots
    .filter((entryPath) => existsSync(entryPath))
    .flatMap((entryPath) => walkFiles(entryPath))
    .filter((filePath) => isTextExtension(filePath));
}

function collectBuildFiles(directory) {
  return walkFiles(directory).filter((filePath) => isTextExtension(filePath));
}

export function scanText(text, fileName) {
  const extension = extname(fileName).toLowerCase();
  if (!isTextExtension(fileName)) {
    return [];
  }

  const findings = [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    for (const rule of rules) {
      if (!rule.applies(extension)) {
        continue;
      }
      if (rule.pattern.test(line)) {
        findings.push({ rule: rule.name, file: fileName.replace(/\\/g, '/'), line: index + 1 });
      }
    }
  }
  return findings;
}

export function scanDirectory(directory = defaultBuildDirectory, options = {}) {
  const { sources = false } = options;
  const files = sources ? collectSourceFiles() : collectBuildFiles(resolve(directory));
  return files.flatMap((filePath) => scanText(readUtf8(filePath), toDisplayPath(filePath)));
}

function formatFindings(findings) {
  return findings.map((finding) => `${finding.rule}: ${finding.file}:${finding.line}`).join('\n');
}

function main(argv) {
  const args = [...argv];
  const sources = args.includes('--sources');
  const positional = args.filter((argument) => argument !== '--sources');
  if (positional.length > 1) {
    throw new Error('Usage: node deck/scripts/scan-public-output.mjs [--sources] [directory]');
  }

  const directory = positional[0] ? resolve(process.cwd(), positional[0]) : defaultBuildDirectory;
  const findings = scanDirectory(directory, { sources });
  if (findings.length > 0) {
    console.error(formatFindings(findings));
    process.exitCode = 1;
    return;
  }

  console.log(sources ? 'Source scan passed.' : `Build scan passed for ${toDisplayPath(directory)}.`);
}

if (process.argv[1] && resolve(process.argv[1]) == fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  }
}
