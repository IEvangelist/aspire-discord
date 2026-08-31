import type { Logger } from 'pino';
import type { AppConfig } from '../config.js';
import { readBoundedBody } from './bounded-body.js';

const maximumBodyBytes = 1_024 * 1_024;
const maximumRedirects = 3;
const requestTimeoutMilliseconds = 12_000;

export interface FetchedLinkContext {
  readonly citationUrl: string;
  readonly content: string;
  readonly searchText: string;
  readonly title: string;
}

export class SafeWebFetcher {
  public constructor(
    private readonly config: AppConfig['linkContext'],
    private readonly logger: Logger,
  ) {}

  public canFetch(value: string): boolean {
    try {
      this.#validate(new URL(value));
      return true;
    } catch {
      return false;
    }
  }

  public async fetch(value: string, signal?: AbortSignal): Promise<FetchedLinkContext> {
    let url = new URL(value);
    for (let redirects = 0; redirects <= maximumRedirects; redirects++) {
      this.#validate(url);
      const timeout = AbortSignal.timeout(requestTimeoutMilliseconds);
      const response = await fetch(url, {
        headers: {
          Accept: 'text/html, text/plain;q=0.9, application/json;q=0.8',
          'User-Agent': 'AspireDiscordBot/1.0 (+https://github.com/IEvangelist/aspire-discord)',
        },
        redirect: 'manual',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });

      if (isRedirect(response.status)) {
        if (redirects === maximumRedirects) {
          throw new Error('Link exceeded the redirect limit.');
        }
        const location = response.headers.get('location');
        if (!location) {
          throw new Error('Link redirect did not include a location.');
        }
        url = new URL(location, url);
        continue;
      }
      if (!response.ok) {
        throw new Error(`Link returned HTTP ${String(response.status)}.`);
      }

      const contentType = response.headers.get('content-type')?.toLocaleLowerCase('en-US') ?? '';
      if (!isReadableContentType(contentType)) {
        throw new Error('Link did not return supported text content.');
      }
      const declaredLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(declaredLength) && declaredLength > maximumBodyBytes) {
        throw new Error('Link content exceeded the size limit.');
      }

      const raw = new TextDecoder().decode(
        await readBoundedBody(response, maximumBodyBytes, 'Link content exceeded the size limit.'),
      );
      if (contentType.includes('html')) {
        const refresh = metaRefreshTarget(raw);
        if (refresh) {
          if (redirects === maximumRedirects) {
            throw new Error('Link exceeded the redirect limit.');
          }
          url = new URL(refresh, url);
          continue;
        }
      }
      const title = contentType.includes('html')
        ? (htmlTitle(raw) ?? fallbackTitle(url))
        : fallbackTitle(url);
      const content = contentType.includes('html') ? htmlToText(raw) : normalizeText(raw);
      if (!content) {
        throw new Error('Link did not contain readable text.');
      }
      this.logger.debug(
        { hostname: url.hostname, responseBytes: raw.length },
        'Fetched allowlisted link context.',
      );
      return {
        citationUrl: citationUrl(url),
        content,
        searchText: `${title}\n${content.slice(0, 1_000)}`,
        title,
      };
    }
    throw new Error('Link could not be fetched.');
  }

  #validate(url: URL): void {
    const hostname = url.hostname.toLocaleLowerCase('en-US');
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      (url.port && url.port !== '443') ||
      url.href.length > 2_048 ||
      !this.config.allowedHosts.has(hostname)
    ) {
      throw new Error('Link is not allowed by the configured fetch policy.');
    }
  }
}

function htmlToText(value: string): string {
  const readable =
    /<main\b[^>]*data-pagefind-body[^>]*>(?<body>[\s\S]*?)<\/main>/iu.exec(value)?.groups?.body ??
    /<article\b[^>]*>(?<body>[\s\S]*?)<\/article>/iu.exec(value)?.groups?.body ??
    /<main\b[^>]*>(?<body>[\s\S]*?)<\/main>/iu.exec(value)?.groups?.body ??
    /<body\b[^>]*>(?<body>[\s\S]*?)<\/body>/iu.exec(value)?.groups?.body ??
    value;
  return normalizeText(
    decodeEntities(
      readable
        .replace(/<!--[\s\S]*?-->/gu, ' ')
        .replace(
          /<(?:script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/(?:script|style|noscript|svg)>/giu,
          ' ',
        )
        .replace(/<(?:br|\/p|\/div|\/li|\/h[1-6])\s*>/giu, '\n')
        .replace(/<[^>]+>/gu, ' '),
    ),
  );
}

function htmlTitle(value: string): string | undefined {
  const match = /<title\b[^>]*>(?<title>[\s\S]*?)<\/title>/iu.exec(value);
  const title = normalizeText(decodeEntities(match?.groups?.title ?? ''));
  return title ? title.slice(0, 200) : undefined;
}

function metaRefreshTarget(value: string): string | undefined {
  const tag = /<meta\b[^>]*http-equiv=["']?refresh["']?[^>]*>/iu.exec(value)?.[0];
  const content = tag
    ? /\bcontent=["'](?<content>[^"']+)["']/iu.exec(tag)?.groups?.content
    : undefined;
  return /(?:^|;)\s*url\s*=\s*(?<url>.+?)\s*$/iu.exec(content ?? '')?.groups?.url;
}

function decodeEntities(value: string): string {
  const named: Record<string, string> = {
    amp: '&',
    apos: "'",
    gt: '>',
    lt: '<',
    nbsp: ' ',
    quot: '"',
  };
  return value.replace(
    /&(?:(#)(x)?([0-9a-f]+)|([a-z]+));/giu,
    (_match, hash, hex, digits, name) => {
      if (hash) {
        const codePoint = Number.parseInt(String(digits), hex ? 16 : 10);
        return Number.isSafeInteger(codePoint) && codePoint <= 0x10ffff
          ? String.fromCodePoint(codePoint)
          : ' ';
      }
      return named[String(name).toLocaleLowerCase('en-US')] ?? ' ';
    },
  );
}

function normalizeText(value: string): string {
  return value
    .replace(/\r\n?/gu, '\n')
    .replace(/[^\S\n]+/gu, ' ')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
    .slice(0, 12_000);
}

function fallbackTitle(url: URL): string {
  const leaf = url.pathname.split('/').filter(Boolean).at(-1);
  if (!leaf) {
    return url.hostname;
  }
  try {
    return decodeURIComponent(leaf).replace(/[-_]+/gu, ' ');
  } catch {
    return leaf.replace(/[-_]+/gu, ' ');
  }
}

function citationUrl(url: URL): string {
  const clean = new URL(url);
  clean.hash = '';
  clean.search = '';
  return clean.toString();
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

function isReadableContentType(value: string): boolean {
  return (
    value.startsWith('text/html') ||
    value.startsWith('application/xhtml+xml') ||
    value.startsWith('text/plain') ||
    value.startsWith('application/json')
  );
}
