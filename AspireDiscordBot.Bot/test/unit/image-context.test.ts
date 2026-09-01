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
  explicit = false,
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
    explicit,
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

    const [image] = (await loader().load([candidate(source)])).images;
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
        candidate(
          source,
          {
            url: 'https://127.0.0.1/attachments/123/456/screenshot.png',
          },
          true,
        ),
      ]),
    ).rejects.toThrow(/Discord or its approved image proxy/u);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts a static WebP from Discord inline-image proxy and normalizes it', async () => {
    const source = await sharp({
      create: {
        background: { b: 50, g: 100, r: 200 },
        channels: 3,
        height: 10,
        width: 10,
      },
    })
      .webp()
      .toBuffer();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(source, {
            headers: { 'content-type': 'image/webp' },
          }),
      ),
    );

    const [image] = (
      await loader().load([
        candidate(source, {
          contentType: null,
          inline: true,
          name: 'inline-image',
          size: 0,
          url: 'https://images-ext-1.discordapp.net/external/abcdefghijABCDEFGHIJ1234/https/example.com/screenshot.webp',
        }),
      ])
    ).images;

    expect(image?.mimeType).toBe('image/jpeg');
    expect((await sharp(Buffer.from(image?.data ?? '', 'base64')).metadata()).format).toBe('jpeg');
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

    await expect(loader().load([candidate(source, {}, true)])).rejects.toThrow(/redirected/u);
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

    await expect(
      loader({ maxBytes: 64 * 1_024 }).load([candidate(source, {}, true)]),
    ).rejects.toThrow(/too large/u);
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

    const images = (await loader().load(candidates)).images;

    expect(images).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('rejects oversized metadata, unsupported formats, and mismatched bytes', async () => {
    const source = await png();

    await expect(
      loader({ maxBytes: 64 * 1_024 }).load([
        candidate(
          source,
          {
            size: 65 * 1_024,
          },
          true,
        ),
      ]),
    ).rejects.toThrow(/too large/u);
    await expect(
      loader().load([
        candidate(
          source,
          {
            contentType: 'image/svg+xml',
            name: 'vector.svg',
          },
          true,
        ),
      ]),
    ).rejects.toThrow(/static PNG, JPEG, WebP, or GIF/u);

    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('not an image', {
            headers: { 'content-type': 'image/png' },
          }),
      ),
    );
    await expect(loader().load([candidate(source, {}, true)])).rejects.toThrow(/did not match/u);
  });

  it('rejects decoded dimensions above the configured pixel bound', async () => {
    const source = await png();

    await expect(
      loader().load([
        candidate(
          source,
          {
            height: 2_000,
            width: 2_000,
          },
          true,
        ),
      ]),
    ).rejects.toThrow(/too many pixels/u);
  });

  it('skips invalid automatic images and falls back to the next candidate', async () => {
    const source = await png();
    const fetchMock = vi.fn(
      async () =>
        new Response(source, {
          headers: { 'content-type': 'image/png' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await loader().load([
      candidate(source, {
        contentType: 'image/svg+xml',
        id: 'invalid',
        name: 'vector.svg',
      }),
      candidate(source, {
        id: '457',
        url: 'https://cdn.discordapp.com/attachments/123/457/screenshot.png',
      }),
    ]);

    expect(result.images).toHaveLength(1);
    expect(result.notices).toContain('An optional image could not be read safely and was omitted.');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('normalizes the same captured image deterministically', async () => {
    const source = await png();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(source, {
            headers: { 'content-type': 'image/png' },
          }),
      ),
    );

    const first = (await loader().load([candidate(source)])).images[0]?.data;
    const second = (await loader().load([candidate(source)])).images[0]?.data;

    expect(first).toBeTruthy();
    expect(second).toBe(first);
  });
});
