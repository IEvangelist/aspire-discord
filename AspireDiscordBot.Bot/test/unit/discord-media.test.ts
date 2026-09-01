import { describe, expect, it } from 'vitest';
import {
  validateDiscordAttachmentUrl,
  validateDiscordImageUrl,
} from '../../src/discord/discord-media.js';

describe('Discord media URL policy', () => {
  it('accepts exact attachment and image-proxy URL shapes', () => {
    expect(
      validateDiscordAttachmentUrl(
        'https://cdn.discordapp.com/attachments/123/456/trace.log?ex=signed',
      ).hostname,
    ).toBe('cdn.discordapp.com');
    expect(
      validateDiscordImageUrl(
        'https://images-ext-1.discordapp.net/external/abcdefghijABCDEFGHIJ1234/https/example.com/image.webp',
      ).hostname,
    ).toBe('images-ext-1.discordapp.net');
    expect(
      validateDiscordImageUrl(
        'https://media.discordapp.net/external/abcdefghijABCDEFGHIJ1234/https/example.com/image.webp',
      ).hostname,
    ).toBe('media.discordapp.net');
  });

  it.each([
    'http://cdn.discordapp.com/attachments/123/456/file.txt',
    'https://cdn.discordapp.com.evil.test/attachments/123/456/file.txt',
    'https://cdn.discordapp.com:444/attachments/123/456/file.txt',
    '******cdn.discordapp.com/attachments/123/456/file.txt',
    'https://cdn.discordapp.com/not-attachments/123/456/file.txt',
    'https://images-ext-1.discordapp.net/external/short/https/example.com/image.png',
  ])('rejects unsafe or malformed Discord media URL: %s', (value) => {
    expect(() => validateDiscordImageUrl(value)).toThrow();
  });

  it('does not allow image-proxy paths for text attachment fetching', () => {
    expect(() =>
      validateDiscordAttachmentUrl(
        'https://images-ext-1.discordapp.net/external/abcdefghijABCDEFGHIJ1234/https/example.com/file.txt',
      ),
    ).toThrow();
  });
});
