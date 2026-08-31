import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SafeDiscordImageLoader,
  type DiscordAttachmentSnapshot,
  type DiscordImageCandidate,
} from '../../src/discord/image-context.js';
import { createTestConfig } from '../helpers/config.js';
import { testLogger } from '../helpers/logger.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

function candidate(
  bytes: Uint8Array,
  overrides: Partial<DiscordAttachmentSnapshot> = {},
): DiscordImageCandidate {
  return {
    attachment: {
      contentType: 'image/png',
      height: 10,
      id: '456',
      name: 'screenshot.png',
      size: bytes.byteLength,
      url: 'https://cdn.discordapp.com/attachments/123/456/screenshot.png?ex=signed',
      width: 10,
      ...overrides,
    },
    explicit: false,
    source: 'latest thread turn',
  };
}

function loader(overrides: Partial<ReturnType<typeof createTestConfig>['imageContext']> = {}) {
  return new SafeDiscordImageLoader(
    createTestConfig({
      imageContext: {
        enabled: true,
        maxBytes: 1_048_576,
        maxPixels: 2_000_000,
        ...overrides,
      },
    }).imageContext,
    testLogger,
  );
}

async function png(): Promise<Buffer> {
  return await sharp({
    create: {
      background: { alpha: 1, b: 255, g: 255, r: 255 },
      channels: 4,
      height: 10,
      width: 10,
    },
  })
    .png()
    .toBuffer();
}

describe('SafeDiscordImageLoader', () => {
  it('fetches and normalizes a bounded Discord PNG entirely in memory', async () => {
    const source = await png();
    const fetchMock = vi.fn(
      async () =>
        new Response(source, {
          headers: {
            'content-length': String(source.byteLength),
            'content-type': 'image/png',
          },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const [image] = await loader().load([candidate(source)]);
    const metadata = await sharp(Buffer.from(image?.data ?? '', 'base64')).metadata();

    expect(image).toMatchObject({
      displayName: 'latest-thread-turn-1.jpg',
      mimeType: 'image/jpeg',
    });
    expect(metadata.format).toBe('jpeg');
    expect(fetchMock).toHaveBeenCalledWith(
      expect.objectContaining({ hostname: 'cdn.discordapp.com' }),
      expect.objectContaining({ redirect: 'manual' }),
    );
  });

  it('rejects non-Discord hosts before making a request', async () => {
    const source = await png();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      loader().load([
        candidate(source, {
          url: 'https://127.0.0.1/attachments/123/456/screenshot.png',
        }),
      ]),
    ).rejects.toThrow(/Discord CDN/u);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not follow redirects', async () => {
    const source = await png();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(null, {
            headers: { location: 'https://example.com/image.png' },
            status: 302,
          }),
      ),
    );

    await expect(loader().load([candidate(source)])).rejects.toThrow(/redirected/u);
  });

  it('enforces the streamed body limit when content-length is absent', async () => {
    const source = await png();
    const oversized = Buffer.concat([source, Buffer.alloc(64 * 1_024)]);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(oversized, {
            headers: { 'content-type': 'image/png' },
          }),
      ),
    );

    await expect(loader({ maxBytes: 64 * 1_024 }).load([candidate(source)])).rejects.toThrow(
      /too large/u,
    );
  });

  it('processes no more than the configured image count', async () => {
    const source = await png();
    const fetchMock = vi.fn(
      async () =>
        new Response(source, {
          headers: { 'content-type': 'image/png' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const candidates = ['456', '457', '458'].map((id) =>
      candidate(source, {
        id,
        url: `https://cdn.discordapp.com/attachments/123/${id}/screenshot.png`,
      }),
    );

    const images = await loader().load(candidates);

    expect(images).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('rejects oversized metadata, unsupported formats, and mismatched bytes', async () => {
    const source = await png();

    await expect(
      loader({ maxBytes: 64 * 1_024 }).load([
        candidate(source, {
          size: 65 * 1_024,
        }),
      ]),
    ).rejects.toThrow(/too large/u);
    await expect(
      loader().load([
        candidate(source, {
          contentType: 'image/gif',
          name: 'animation.gif',
        }),
      ]),
    ).rejects.toThrow(/static PNG or JPEG/u);

    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('not an image', {
            headers: { 'content-type': 'image/png' },
          }),
      ),
    );
    await expect(loader().load([candidate(source)])).rejects.toThrow(/did not match/u);
  });

  it('rejects decoded dimensions above the configured pixel bound', async () => {
    const source = await png();

    await expect(
      loader().load([
        candidate(source, {
          height: 2_000,
          width: 2_000,
        }),
      ]),
    ).rejects.toThrow(/too many pixels/u);
  });
});
