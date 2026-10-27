import { expect, test } from '@playwright/test';
import { openDeck } from './helpers';

for (const width of [320, 390, 1440]) {
  test(`the shared speaker socials fit and keep 44px targets at ${width}px`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-dark', 'The explicit social viewport matrix runs once.');
    await page.setViewportSize({ width, height: 900 });
    await openDeck(page, '?mode=read#/intro');
    const links = page.locator('.speaker-socials a');
    await expect(links).toHaveCount(4);
    const expected = [
      ['github', 'https://github.com/IEvangelist', 'GitHub'],
      ['x', 'https://x.com/davidpine7', 'X'],
      ['bluesky', 'https://bsky.app/profile/davidpine.dev', 'Bluesky'],
      ['linkedin', 'https://www.linkedin.com/in/dpine/', 'LinkedIn'],
    ];
    const portrait = await page.locator('.speaker-portrait').boundingBox();
    for (const [name, url, title] of expected) {
      const link = page.locator(`[data-social="${name}"]`);
      await expect(link).toHaveAttribute('href', url);
      await expect(link).toHaveAttribute('aria-label', `David Pine on ${title}`);
      await expect(link).toHaveAttribute('title', title);
      await expect(link).toHaveAttribute('rel', /noopener/);
      const bounds = await link.boundingBox();
      expect(bounds!.width).toBeGreaterThanOrEqual(43.9);
      expect(bounds!.height).toBeGreaterThanOrEqual(43.9);
      expect(bounds!.y).toBeGreaterThanOrEqual(portrait!.y + portrait!.height - 1);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width + 1);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
