import { expect, test } from '@playwright/test';
import { openDeck, slideIds } from './helpers';

test('print layout gives every slide exactly one equal-height page', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-dark', 'Print pagination is verified once.');
  await page.setViewportSize({ width: 1440, height: 810 });
  await openDeck(page, '?print-pdf');
  await page.emulateMedia({ media: 'print' });

  const ids = await slideIds(page);
  await expect(page.locator('.pdf-page')).toHaveCount(ids.length);
  const heights = await page.locator('.pdf-page').evaluateAll((pages) =>
    pages.map((item) => ({ id: item.querySelector('section')?.id ?? '', height: Math.round(item.getBoundingClientRect().height) })));
  const normal = Math.min(...heights.map((item) => item.height));
  const oversize = heights.filter((item) => item.height > normal + 1).map((item) => `${item.id}=${item.height}`);
  expect(oversize, `slides that spill onto a second printed page (normal page ${normal}px)`).toEqual([]);
});
