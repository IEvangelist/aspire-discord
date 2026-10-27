import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { kebabCaseId, openDeck, slideRecords } from './helpers';

const buildDir = join(process.cwd(), process.env.DECK_OUT_DIR ?? 'dist');
const forbiddenStrings = [
  'github.com/IEvangelist/aspire-discord',
  'D:\\GitHub\\aspire-discord',
  'D:\\GitHub\\aspire-discord-issue-release',
  // The product is "Aspire". The old ".NET Aspire" name must not reappear in slides, captions, or alt text.
  '.NET Aspire',
];

function readAllFiles(directory: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) results.push(...readAllFiles(full));
    else results.push(readFileSync(full, 'utf8'));
  }
  return results;
}

test('chapter order, slide ids, and appendix placement stay content-agnostic', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-dark', 'Structure checks run once.');
  await openDeck(page, '?mode=read');
  const slides = await slideRecords(page);
  expect(slides.length).toBeGreaterThan(0);

  const ids = slides.map((slide) => slide.id);
  expect(new Set(ids).size).toBe(ids.length);
  for (const id of ids) expect(id).toMatch(kebabCaseId);

  const chapterLinks = await page.locator('[data-core-chapter]').evaluateAll((links) =>
    links.map((link) => ({
      chapter: link.getAttribute('data-core-chapter') ?? '',
      slide: link.getAttribute('data-slide') ?? '',
    })));
  expect(chapterLinks.length).toBeGreaterThan(0);
  expect(new Set(chapterLinks.map((link) => link.chapter)).size).toBe(chapterLinks.length);

  const firstSeenCoreChapters = slides.reduce<string[]>((order, slide) => {
    if (!slide.appendix && chapterLinks.some((link) => link.chapter === slide.chapter) && !order.includes(slide.chapter)) {
      order.push(slide.chapter);
    }
    return order;
  }, []);
  expect(firstSeenCoreChapters).toEqual(chapterLinks.map((link) => link.chapter));

  for (const link of chapterLinks) {
    const first = slides.find((slide) => slide.chapter === link.chapter);
    expect(first?.purpose, `${link.chapter} should begin with a why slide`).toBe('why');
    expect(first?.id, `${link.chapter} menu target should point at its first slide`).toBe(link.slide);
  }

  const firstAppendix = slides.findIndex((slide) => slide.appendix);
  expect(firstAppendix).toBeGreaterThan(-1);
  for (let index = firstAppendix; index < slides.length; index++) expect(slides[index].appendix).toBe(true);
  for (const slide of slides.filter((item) => item.appendix)) {
    expect(slide.notes).not.toMatch(/^\d+:\d{2}-\d+:\d{2}\./);
  }
});

test('built output and rendered markup never expose private repository markers', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-dark', 'Build artifact checks run once.');
  await openDeck(page, '?mode=read');
  const pageMarkup = await page.content();
  const builtOutput = readAllFiles(buildDir).join('\n');
  for (const forbidden of forbiddenStrings) {
    expect(pageMarkup).not.toContain(forbidden);
    expect(builtOutput).not.toContain(forbidden);
  }
  expect(pageMarkup).not.toContain('%BASE_URL%');
  expect(builtOutput).not.toContain('%BASE_URL%');
});
