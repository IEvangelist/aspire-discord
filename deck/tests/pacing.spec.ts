import { expect, test } from '@playwright/test';
import { openDeck, parseTimingRange, slideRecords } from './helpers';

test('speaker notes cover every slide and timed slides form a contiguous runtime budget', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-dark', 'Pacing checks run once.');
  await openDeck(page, '?mode=read');
  const durationMinutes = Number(await page.locator('#presentation').getAttribute('data-duration-minutes'));
  expect(durationMinutes).toBeGreaterThan(0);

  const slides = await slideRecords(page);
  for (const slide of slides) expect(slide.notes, `${slide.id} is missing notes`).not.toBe('');

  const timedSlides = slides.filter((slide) => !slide.appendix);
  const issues: string[] = [];
  let previousEnd = 0;

  for (const slide of timedSlides) {
    const range = parseTimingRange(slide.notes);
    if (!range) {
      issues.push(`${slide.id}: missing H:MM-H:MM timing prefix in notes`);
      continue;
    }
    if (range.start !== previousEnd) {
      issues.push(`${slide.id}: starts at ${range.start} but previous timed slide ended at ${previousEnd}`);
    }
    if (range.end <= range.start) {
      issues.push(`${slide.id}: ends at ${range.end} which is not after ${range.start}`);
    }
    if (range.end - range.start < 1) {
      issues.push(`${slide.id}: spans ${range.end - range.start} minute(s), expected at least 1`);
    }
    previousEnd = range.end;
  }

  if (previousEnd > durationMinutes) {
    issues.push(`timed slides end at ${previousEnd}, beyond declared duration ${durationMinutes}`);
  }
  if (previousEnd < durationMinutes - 1) {
    issues.push(`timed slides end at ${previousEnd}, more than 1 minute before declared duration ${durationMinutes}`);
  }

  expect(issues, issues.join('; ')).toEqual([]);

  const appendixSlides = slides.filter((slide) => slide.appendix);
  expect(appendixSlides.length).toBeGreaterThan(0);
  for (const slide of appendixSlides) {
    expect(slide.notes, `${slide.id} appendix notes must stay untimed`).not.toMatch(/^\d+:\d{2}-\d+:\d{2}\./);
  }
});
