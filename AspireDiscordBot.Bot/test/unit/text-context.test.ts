import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isPotentialTextAttachment,
  SafeDiscordTextLoader,
  type DiscordTextCandidate,
} from '../../src/discord/text-context.js';
import { createTestConfig } from '../helpers/config.js';
import { testLogger } from '../helpers/logger.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

function candidate(
  overrides: Partial<DiscordTextCandidate['attachment']> = {},
  explicit = true,
): DiscordTextCandidate {
  return {
    attachment: {
      contentType: 'text/plain',
      height: null,
      id: '456',
      name: 'diagnostics.log',
      size: 100,
      url: 'https://cdn.discordapp.com/attachments/123/456/diagnostics.log?ex=signed',
      width: null,
      ...overrides,
    },
    explicit,
    source: explicit ? 'current question' : 'thread starter',
  };
}

function loader(
  overrides: Partial<ReturnType<typeof createTestConfig>['textContext']> = {},
): SafeDiscordTextLoader {
  return new SafeDiscordTextLoader(
    createTestConfig({
      textContext: {
        maxBytes: 32_768,
        maxCharacters: 4_000,
        ...overrides,
      },
    }).textContext,
    testLogger,
  );
}

describe('SafeDiscordTextLoader', () => {
  it('classifies common engineering files without trusting arbitrary extensions', () => {
    expect(
      isPotentialTextAttachment(
        candidate({
          contentType: 'application/octet-stream',
          name: 'Dockerfile',
        }).attachment,
      ),
    ).toBe(true);
    expect(
      isPotentialTextAttachment(
        candidate({
          contentType: 'text/plain',
          name: '.env.example',
        }).attachment,
      ),
    ).toBe(true);
    expect(
      isPotentialTextAttachment(
        candidate({
          contentType: 'text/plain',
          name: '.env',
        }).attachment,
      ),
    ).toBe(false);
  });

  it('reads bounded UTF-8 text and redacts credentials', async () => {
    const body = 'Redis failed.\npassword = super-secret-value\nUse AddRedis.';
    const fetchMock = vi.fn(
      async () =>
        new Response(body, {
          headers: {
            'content-length': String(Buffer.byteLength(body)),
            'content-type': 'text/plain; charset=utf-8',
          },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await loader().load([candidate()]);

    expect(result.documents).toHaveLength(1);
    expect(result.documents[0]?.content).toContain('Redis failed.');
    expect(result.documents[0]?.content).not.toContain('super-secret-value');
    expect(result.documents[0]?.content).toContain('[REDACTED]');
    expect(fetchMock).toHaveBeenCalledWith(
      expect.objectContaining({ hostname: 'cdn.discordapp.com' }),
      expect.objectContaining({ redirect: 'manual' }),
    );
  });

  it('rejects external hosts and unsupported explicit file types before fetching', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      loader().load([
        candidate({
          url: 'https://example.com/attachments/123/456/diagnostics.log',
        }),
      ]),
    ).rejects.toThrow(/not hosted by Discord/u);
    await expect(
      loader().load([
        candidate({
          contentType: 'application/zip',
          name: 'archive.zip',
        }),
      ]),
    ).rejects.toThrow(/common UTF-8/u);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects binary and invalid UTF-8 content', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(Uint8Array.from([0xff, 0xfe, 0x00, 0x01]), {
            headers: { 'content-type': 'application/octet-stream' },
          }),
      ),
    );

    await expect(loader().load([candidate()])).rejects.toThrow(/UTF-8|binary/u);
  });

  it('skips invalid automatic files and continues with valid context', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response('Valid diagnostic context.', {
          headers: { 'content-type': 'text/plain' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await loader().load([
      candidate(
        {
          contentType: 'application/zip',
          id: '111',
          name: 'archive.zip',
        },
        false,
      ),
      candidate(
        {
          id: '457',
          url: 'https://cdn.discordapp.com/attachments/123/457/diagnostics.log',
        },
        false,
      ),
    ]);

    expect(result.documents).toHaveLength(1);
    expect(result.notices).toContain(
      'An optional text attachment could not be read safely and was omitted.',
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('enforces aggregate file and character limits deterministically', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('x'.repeat(3_000), {
            headers: { 'content-type': 'text/plain' },
          }),
      ),
    );
    const result = await loader({ maxCharacters: 1_000, maxFiles: 1 }).load([
      candidate(),
      candidate({
        id: '457',
        url: 'https://cdn.discordapp.com/attachments/123/457/second.log',
      }),
    ]);

    expect(result.documents).toHaveLength(1);
    expect(result.documents[0]?.content).toHaveLength(1_000);
    expect(result.notices).toContain('A text attachment was truncated to fit the context limit.');
    expect(result.notices).toContain(
      'Additional text attachments were omitted by the context limit.',
    );
  });

  it('fails explicit files and skips automatic files when text context is disabled', async () => {
    const disabled = loader({ enabled: false });

    await expect(disabled.load([candidate()])).rejects.toThrow(/not enabled/u);
    await expect(disabled.load([candidate({}, false)])).resolves.toEqual({
      documents: [],
      notices: ['Text attachments were not available for this answer.'],
    });
  });

  it('rejects redirects, oversized responses, and empty text', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(null, {
          headers: { location: 'https://example.com/file.log' },
          status: 302,
        }),
      )
      .mockResolvedValueOnce(
        new Response('small', {
          headers: {
            'content-length': '40000',
            'content-type': 'text/plain',
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response('', {
          headers: { 'content-type': 'text/plain' },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(loader().load([candidate()])).rejects.toThrow(/redirected/u);
    await expect(loader().load([candidate()])).rejects.toThrow(/too large/u);
    await expect(loader().load([candidate()])).rejects.toThrow(/empty/u);
  });

  it('returns an empty result when no text candidates are supplied', async () => {
    await expect(loader().load([])).resolves.toEqual({ documents: [], notices: [] });
  });
});
