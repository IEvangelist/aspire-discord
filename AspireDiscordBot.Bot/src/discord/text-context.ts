import type { Logger } from 'pino';
import type { AppConfig } from '../config.js';
import type { AnswerDocument } from '../domain.js';
import { BodySizeLimitError, readBoundedBody } from '../agent/bounded-body.js';
import { sanitizeForAgent, truncateAtGrapheme } from '../safety.js';
import { validateDiscordAttachmentUrl } from './discord-media.js';
import type { DiscordAttachmentSnapshot, DiscordImageSource } from './image-context.js';

const allowedExtensions = new Set([
  '.bicep',
  '.c',
  '.config',
  '.cpp',
  '.cshtml',
  '.cs',
  '.csproj',
  '.css',
  '.cts',
  '.diff',
  '.fs',
  '.fsproj',
  '.graphql',
  '.go',
  '.h',
  '.hpp',
  '.http',
  '.ini',
  '.java',
  '.js',
  '.json',
  '.jsonc',
  '.jsx',
  '.log',
  '.md',
  '.mjs',
  '.mts',
  '.patch',
  '.props',
  '.proto',
  '.ps1',
  '.py',
  '.razor',
  '.rs',
  '.sh',
  '.sln',
  '.sql',
  '.targets',
  '.tf',
  '.toml',
  '.ts',
  '.tsx',
  '.txt',
  '.vb',
  '.vbproj',
  '.xml',
  '.yaml',
  '.yml',
]);
const allowedFileNames = new Set(['containerfile', 'dockerfile', 'makefile']);
const allowedApplicationTypes = new Set([
  'application/json',
  'application/octet-stream',
  'application/toml',
  'application/xml',
  'application/x-yaml',
  'application/yaml',
]);
const requestTimeoutMilliseconds = 10_000;

export interface DiscordTextCandidate {
  readonly attachment: DiscordAttachmentSnapshot;
  readonly explicit: boolean;
  readonly source: DiscordImageSource;
}

export interface TextContextResult {
  readonly documents: readonly AnswerDocument[];
  readonly notices: readonly string[];
}

interface LoadedTextDocument {
  readonly document: AnswerDocument;
  readonly truncated: boolean;
}

export class TextAttachmentError extends Error {
  public constructor(
    public readonly userMessage: string,
    options?: ErrorOptions,
  ) {
    super(userMessage, options);
    this.name = 'TextAttachmentError';
  }
}

export class SafeDiscordTextLoader {
  public constructor(
    private readonly config: AppConfig['textContext'],
    private readonly logger: Logger,
  ) {}

  public async load(
    candidates: readonly DiscordTextCandidate[],
    signal?: AbortSignal,
  ): Promise<TextContextResult> {
    const unique = deduplicate(candidates);
    if (unique.length === 0) {
      return { documents: [], notices: [] };
    }
    if (!this.config.enabled) {
      if (unique.some((candidate) => candidate.explicit)) {
        throw new TextAttachmentError('Text attachment analysis is not enabled.');
      }
      return {
        documents: [],
        notices: ['Text attachments were not available for this answer.'],
      };
    }

    const documents: AnswerDocument[] = [];
    const notices: string[] = [];
    let remainingCharacters = this.config.maxCharacters;
    for (const candidate of unique) {
      if (documents.length >= this.config.maxFiles || remainingCharacters <= 0) {
        notices.push('Additional text attachments were omitted by the context limit.');
        break;
      }
      signal?.throwIfAborted();
      try {
        const loaded = await this.#loadOne(candidate, remainingCharacters, signal);
        documents.push(loaded.document);
        remainingCharacters -= loaded.document.content.length;
        if (loaded.truncated) {
          notices.push('A text attachment was truncated to fit the context limit.');
        }
      } catch (error) {
        if (candidate.explicit || signal?.aborted) {
          if (error instanceof TextAttachmentError) {
            throw error;
          }
          throw new TextAttachmentError(
            'I could not safely read the attached text file. Please paste the relevant excerpt.',
            { cause: error },
          );
        }
        this.logger.info(
          {
            attachmentId: candidate.attachment.id,
            errorType: error instanceof Error ? error.name : 'Error',
            source: candidate.source,
          },
          'Skipped optional Discord text context.',
        );
        notices.push('An optional text attachment could not be read safely and was omitted.');
      }
    }
    return { documents, notices: uniqueNotices(notices) };
  }

  async #loadOne(
    candidate: DiscordTextCandidate,
    maximumCharacters: number,
    signal?: AbortSignal,
  ): Promise<LoadedTextDocument> {
    const attachment = candidate.attachment;
    if (!isPotentialTextAttachment(attachment)) {
      throw unsupportedTextError();
    }
    if (!Number.isSafeInteger(attachment.size) || attachment.size < 0) {
      throw new TextAttachmentError('The attached text file reported an invalid size.');
    }
    if (attachment.size > this.config.maxBytes) {
      throw textSizeError(this.config.maxBytes);
    }

    let url: URL;
    try {
      url = validateDiscordAttachmentUrl(attachment.url);
    } catch (error) {
      throw new TextAttachmentError('The text file was not hosted by Discord.', { cause: error });
    }
    const timeout = AbortSignal.timeout(requestTimeoutMilliseconds);
    const response = await fetch(url, {
      cache: 'no-store',
      headers: {
        Accept:
          'text/plain, application/json, application/xml, application/yaml, application/octet-stream',
        'User-Agent': 'AspireDiscordBot/1.0 (+https://github.com/IEvangelist/aspire-discord)',
      },
      redirect: 'manual',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (response.status >= 300 && response.status < 400) {
      throw new TextAttachmentError(
        'Discord redirected the text attachment, so I did not open it.',
      );
    }
    if (!response.ok) {
      throw new TextAttachmentError('Discord could not provide the text attachment.');
    }
    const contentType = normalizeMimeType(response.headers.get('content-type'));
    if (contentType && !isTextResponseType(contentType)) {
      throw unsupportedTextError();
    }
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > this.config.maxBytes) {
      throw textSizeError(this.config.maxBytes);
    }

    let bytes: Uint8Array;
    try {
      bytes = await readBoundedBody(
        response,
        this.config.maxBytes,
        'Text attachment exceeded the size limit.',
      );
    } catch (error) {
      if (error instanceof BodySizeLimitError) {
        throw textSizeError(this.config.maxBytes);
      }
      throw error;
    }
    let decoded: string;
    try {
      decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (error) {
      throw new TextAttachmentError('The attachment was not valid UTF-8 text.', { cause: error });
    }
    if (!decoded.trim()) {
      throw new TextAttachmentError('The text attachment was empty.');
    }
    if (!isReadableText(decoded)) {
      throw new TextAttachmentError('The attachment contained binary or unreadable content.');
    }
    const normalized = sanitizeForAgent(normalizeText(decoded));
    const content = truncateAtGrapheme(normalized, maximumCharacters);
    if (!content) {
      throw new TextAttachmentError('The text attachment was empty.');
    }
    return {
      document: {
        content,
        displayName: sanitizeFileName(attachment.name),
        source: candidate.source,
      },
      truncated: content.length < normalized.length,
    };
  }
}

export function isPotentialTextAttachment(attachment: DiscordAttachmentSnapshot): boolean {
  const extension = fileExtension(attachment.name);
  const fileName = attachment.name.toLocaleLowerCase('en-US');
  const contentType = normalizeMimeType(attachment.contentType);
  return (
    (allowedExtensions.has(extension) ||
      allowedFileNames.has(fileName) ||
      /\.env\.(?:example|sample)$/u.test(fileName)) &&
    (!contentType || contentType.startsWith('text/') || allowedApplicationTypes.has(contentType))
  );
}

function deduplicate(candidates: readonly DiscordTextCandidate[]): readonly DiscordTextCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    if (seen.has(candidate.attachment.id)) {
      return false;
    }
    seen.add(candidate.attachment.id);
    return true;
  });
}

function isTextResponseType(contentType: string): boolean {
  return contentType.startsWith('text/') || allowedApplicationTypes.has(contentType);
}

function isReadableText(value: string): boolean {
  if (value.includes('\0')) {
    return false;
  }
  const sample = value.slice(0, 8_192);
  if (!sample) {
    return false;
  }
  const disallowed = Array.from(sample).filter((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 0x20 && character !== '\n' && character !== '\r' && character !== '\t';
  }).length;
  return disallowed / sample.length <= 0.02;
}

function normalizeText(value: string): string {
  return value
    .replace(/^\uFEFF/u, '')
    .replace(/\r\n?/gu, '\n')
    .replace(/[^\S\n]+/gu, ' ')
    .replace(/\n{4,}/gu, '\n\n\n')
    .trim();
}

function sanitizeFileName(value: string): string {
  const name = Array.from(value)
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint >= 0x20 && codePoint !== 0x7f;
    })
    .join('')
    .trim();
  return (name || 'attachment.txt').slice(0, 100);
}

function fileExtension(value: string): string {
  const index = value.lastIndexOf('.');
  return index >= 0 ? value.slice(index).toLocaleLowerCase('en-US') : '';
}

function normalizeMimeType(value: string | null): string | undefined {
  const contentType = value?.split(';', 1)[0]?.trim().toLocaleLowerCase('en-US');
  return contentType || undefined;
}

function uniqueNotices(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function unsupportedTextError(): TextAttachmentError {
  return new TextAttachmentError(
    'I can inspect common UTF-8 code, configuration, Markdown, JSON, and log files. Please paste other content as text.',
  );
}

function textSizeError(maximumBytes: number): TextAttachmentError {
  return new TextAttachmentError(
    `The text attachment is too large. Please keep it under ${String(Math.floor(maximumBytes / 1_024))} KB or paste the relevant excerpt.`,
  );
}
