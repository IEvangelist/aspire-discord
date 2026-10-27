import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { openDeck } from './helpers';

const origin = 'https://ievangelist.github.io/aspire-discord/';
const image = `${origin}social/aspirey-bot-og.png`;

test('social cards use real artwork with consistent absolute metadata', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-dark', 'Social metadata is checked once.');
  await openDeck(page, '?mode=read');

  for (const [selector, value] of [
    ['meta[property="og:url"]', origin],
    ['meta[property="og:image"]', image],
    ['meta[property="og:image:secure_url"]', image],
    ['meta[property="og:image:width"]', '1200'],
    ['meta[property="og:image:height"]', '630'],
    ['meta[name="twitter:image"]', image],
    ['meta[name="twitter:card"]', 'summary_large_image'],
  ] as const) {
    await expect(page.locator(selector)).toHaveAttribute('content', value);
  }
  await expect(page.locator('meta[property="og:image:alt"]')).toHaveAttribute('content', /Building Aspirey Bot.*David Pine/);
  await expect(page.locator('meta[name="twitter:image:alt"]')).toHaveAttribute('content', /Building Aspirey Bot.*David Pine/);
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', origin);

  for (const [fileName, width, height] of [
    ['aspirey-bot-og.png', 1200, 630],
    ['aspirey-bot-social.png', 1280, 640],
  ] as const) {
    const file = resolve('public', 'social', fileName);
    const [data, info] = await Promise.all([readFile(file), stat(file)]);
    expect(data.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(data.toString('ascii', 12, 16)).toBe('IHDR');
    expect(data.readUInt32BE(16)).toBe(width);
    expect(data.readUInt32BE(20)).toBe(height);
    expect(info.size).toBeLessThan(1_000_000);
  }
});
