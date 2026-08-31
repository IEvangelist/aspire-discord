import sharp from 'sharp';
import type { Logger } from 'pino';
import type { AppConfig } from '../config.js';
import type { AnswerImage } from '../domain.js';
import { BodySizeLimitError, readBoundedBody } from '../agent/bounded-body.js';

const attachmentHosts = new Set(['cdn.discordapp.com', 'media.discordapp.net']);
const allowedMimeTypes = new Set(['image/gif', 'image/jpeg', 'image/png', 'image/webp']);
const attachmentPathPattern = /^\/attachments\/\d+\/\d+\/[^/]+$/u;
const externalProxyHostPattern = /^images-ext-\d+\.discordapp\.net$/u;
const externalProxyPathPattern = /^\/external\/[A-Za-z0-9_-]{20,}\/https?\/[^/]+\/.+$/u;
const maximumOutputDimension = 2_048;
const requestTimeoutMilliseconds = 10_000;

sharp.cache(false);
sharp.concurrency(1);

export type DiscordImageSource = 'current question' | 'latest thread turn' | 'thread starter';

export interface DiscordAttachmentSnapshot {
  readonly contentType: string | null;
  readonly height: number | null;
  readonly id: string;
  readonly inline?: boolean;
  readonly name: string;
  readonly size: number;
  readonly url: string;
  readonly width: number | null;
}

export interface DiscordImageCandidate {
  readonly attachment: DiscordAttachmentSnapshot;
  readonly explicit: boolean;
  readonly source: DiscordImageSource;
}

export class ImageAttachmentError extends Error {
  public constructor(
    public readonly userMessage: string,
    options?: ErrorOptions,
  ) {
    super(userMessage, options);
    this.name = 'ImageAttachmentError';
  }
}

export class SafeDiscordImageLoader {
  public constructor(
    private readonly config: AppConfig['imageContext'],
    private readonly logger: Logger,
  ) {}

  public async load(
    candidates: readonly DiscordImageCandidate[],
    signal?: AbortSignal,
  ): Promise<readonly AnswerImage[]> {
    const usable = deduplicateCandidates(candidates).filter(
      (candidate) => candidate.explicit || isPotentialImageAttachment(candidate.attachment),
    );
    if (usable.length === 0) {
      return [];
    }
    if (!this.config.enabled) {
      throw new ImageAttachmentError(
        'Image analysis is not enabled for the configured chat model.',
      );
    }

    const selected = usable.slice(0, this.config.maxImages);
    const images: AnswerImage[] = [];
    for (const [index, candidate] of selected.entries()) {
      signal?.throwIfAborted();
      try {
        images.push(await this.#loadOne(candidate, index, signal));
      } catch (error) {
        if (error instanceof ImageAttachmentError || signal?.aborted) {
          throw error;
        }
        this.logger.warn(
          {
            attachmentId: candidate.attachment.id,
            errorType: error instanceof Error ? error.name : 'Error',
          },
          'Rejected a Discord image attachment.',
        );
        throw new ImageAttachmentError(
          'I could not safely read the image. Please use a valid static PNG, JPEG, WebP, or GIF and retry.',
          { cause: error },
        );
      }
    }
    return images;
  }

  async #loadOne(
    candidate: DiscordImageCandidate,
    index: number,
    signal?: AbortSignal,
  ): Promise<AnswerImage> {
    const attachment = candidate.attachment;
    validateAttachmentMetadata(attachment, this.config);
    const url = validateAttachmentUrl(attachment.url);
    const timeout = AbortSignal.timeout(requestTimeoutMilliseconds);
    const response = await fetch(url, {
      cache: 'no-store',
      headers: {
        Accept: 'image/png, image/jpeg, image/webp, image/gif',
        'User-Agent': 'AspireDiscordBot/1.0 (+https://github.com/IEvangelist/aspire-discord)',
      },
      redirect: 'manual',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (response.status >= 300 && response.status < 400) {
      throw new ImageAttachmentError(
        'Discord redirected the attached image, so I did not open it.',
      );
    }
    if (!response.ok) {
      throw new ImageAttachmentError('Discord could not provide the attached image.');
    }

    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > this.config.maxBytes) {
      throw imageSizeError(this.config.maxBytes);
    }
    const responseMimeType = normalizeMimeType(response.headers.get('content-type'));
    if (!responseMimeType || !allowedMimeTypes.has(responseMimeType)) {
      throw unsupportedImageError();
    }

    let bytes: Uint8Array;
    try {
      bytes = await readBoundedBody(
        response,
        this.config.maxBytes,
        'Image content exceeded the size limit.',
      );
    } catch (error) {
      if (error instanceof BodySizeLimitError) {
        throw imageSizeError(this.config.maxBytes);
      }
      throw error;
    }
    const detectedMimeType = detectMimeType(bytes);
    const attachmentMimeType = normalizeMimeType(attachment.contentType);
    if (
      !detectedMimeType ||
      detectedMimeType !== responseMimeType ||
      (attachmentMimeType && attachmentMimeType !== detectedMimeType)
    ) {
      throw new ImageAttachmentError(
        'The attached image type did not match its contents, so I did not open it.',
      );
    }

    const normalized = await normalizeImage(bytes, this.config.maxPixels);
    if (normalized.byteLength > this.config.maxBytes) {
      throw imageSizeError(this.config.maxBytes);
    }
    this.logger.debug(
      {
        attachmentId: attachment.id,
        normalizedBytes: normalized.byteLength,
        source: candidate.source,
      },
      'Normalized a Discord image attachment.',
    );
    return {
      data: normalized.toString('base64'),
      displayName: `${candidate.source.replaceAll(' ', '-')}-${String(index + 1)}.jpg`,
      mimeType: 'image/jpeg',
    };
  }
}

export function isPotentialImageAttachment(attachment: DiscordAttachmentSnapshot): boolean {
  return (
    attachment.inline === true ||
    attachment.contentType?.toLocaleLowerCase('en-US').startsWith('image/') === true ||
    /\.(?:gif|jpe?g|png|svg|webp)$/iu.test(attachment.name)
  );
}

function deduplicateCandidates(
  candidates: readonly DiscordImageCandidate[],
): readonly DiscordImageCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    if (seen.has(candidate.attachment.id)) {
      return false;
    }
    seen.add(candidate.attachment.id);
    return true;
  });
}

function validateAttachmentMetadata(
  attachment: DiscordAttachmentSnapshot,
  config: AppConfig['imageContext'],
): void {
  if (!Number.isSafeInteger(attachment.size) || attachment.size < 0) {
    throw new ImageAttachmentError('The attached image reported an invalid size.');
  }
  if (attachment.size > config.maxBytes) {
    throw imageSizeError(config.maxBytes);
  }

  const mimeType = normalizeMimeType(attachment.contentType);
  if (mimeType && !allowedMimeTypes.has(mimeType)) {
    throw unsupportedImageError();
  }
  for (const dimension of [attachment.width, attachment.height]) {
    if (dimension !== null && (!Number.isSafeInteger(dimension) || dimension <= 0)) {
      throw new ImageAttachmentError('The attached image reported invalid dimensions.');
    }
  }
  if (
    attachment.width !== null &&
    attachment.height !== null &&
    attachment.width * attachment.height > config.maxPixels
  ) {
    throw imagePixelError();
  }
}

function validateAttachmentUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ImageAttachmentError('The Discord image URL was invalid.');
  }
  const hostname = url.hostname.toLocaleLowerCase('en-US');
  const allowedPath =
    (attachmentHosts.has(hostname) && attachmentPathPattern.test(url.pathname)) ||
    (externalProxyHostPattern.test(hostname) && externalProxyPathPattern.test(url.pathname));
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    (url.port && url.port !== '443') ||
    url.href.length > 2_048 ||
    !allowedPath
  ) {
    throw new ImageAttachmentError('The image was not hosted by Discord or its image proxy.');
  }
  return url;
}

function normalizeMimeType(value: string | null): string | undefined {
  const mimeType = value?.split(';', 1)[0]?.trim().toLocaleLowerCase('en-US');
  return mimeType || undefined;
}

function detectMimeType(
  bytes: Uint8Array,
): 'image/gif' | 'image/jpeg' | 'image/png' | 'image/webp' | undefined {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  if (bytes.length >= 6 && (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a')) {
    return 'image/gif';
  }
  return undefined;
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.slice(start, end));
}

async function normalizeImage(bytes: Uint8Array, maximumPixels: number): Promise<Buffer> {
  const input = Buffer.from(bytes);
  const metadata = await sharp(input, {
    animated: false,
    failOn: 'error',
    limitInputPixels: maximumPixels,
    sequentialRead: true,
  }).metadata();
  if (!metadata.width || !metadata.height || metadata.width * metadata.height > maximumPixels) {
    throw imagePixelError();
  }
  if ((metadata.pages ?? 1) !== 1 || !['gif', 'jpeg', 'png', 'webp'].includes(metadata.format)) {
    throw unsupportedImageError();
  }

  return await sharp(input, {
    animated: false,
    failOn: 'error',
    limitInputPixels: maximumPixels,
    sequentialRead: true,
  })
    .rotate()
    .resize({
      fit: 'inside',
      height: maximumOutputDimension,
      width: maximumOutputDimension,
      withoutEnlargement: true,
    })
    .flatten({ background: '#ffffff' })
    .jpeg({ chromaSubsampling: '4:4:4', progressive: true, quality: 88 })
    .toBuffer();
}

function unsupportedImageError(): ImageAttachmentError {
  return new ImageAttachmentError(
    'I can only inspect static PNG, JPEG, WebP, or GIF images. Please convert the image and retry.',
  );
}

function imageSizeError(maximumBytes: number): ImageAttachmentError {
  const maximumSize =
    maximumBytes >= 1_024 * 1_024
      ? `${String(Math.floor(maximumBytes / (1_024 * 1_024)))} MB`
      : `${String(Math.floor(maximumBytes / 1_024))} KB`;
  return new ImageAttachmentError(
    `The attached image is too large. Please use an image no larger than ${maximumSize}.`,
  );
}

function imagePixelError(): ImageAttachmentError {
  return new ImageAttachmentError(
    'The attached image has too many pixels to process safely. Please resize it and retry.',
  );
}
