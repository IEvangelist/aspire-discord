import { expect, test } from '@playwright/test';
import { goToSlide, openDeck, openDeckWith, slideIds } from './helpers';

// This deck tells a first-person story for a remote audience. These checks guard the editorial promises
// made in DESIGN.md: every slide says something, nothing is too small to read on a shared screen,
// staged chat scenes are labeled, and the evolution chapters stay in order.

const minimumTextPixels = 20;

test('no slide is only a heading', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-dark', 'Structure checks run once.');
  await openDeck(page, '?mode=read');
  const thin = await page.locator('section[id]').evaluateAll((slides) => slides.flatMap((slide) => {
    const hasVisual = !!slide.querySelector('svg, pre, table, img, .chat, .ladder, .timeline, .cards, .thesis-path, .closing-links');
    const clone = slide.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('h1, h2, .kicker, .notes, [aria-hidden="true"]').forEach((node) => node.remove());
    const supportingText = (clone.textContent ?? '').replace(/\s+/g, ' ').trim();
    return hasVisual || supportingText.length >= 40 ? [] : [`${slide.id} has only a heading (${supportingText.length} supporting characters)`];
  }));
  expect(thin).toEqual([]);
});

test('text stays large enough for a shared screen', async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  test.skip(testInfo.project.name !== 'desktop-dark', 'Type floor runs once.');
  await openDeckWith(page, { theme: 'light', mode: 'present', reducedMotion: 'reduce', viewport: { width: 1440, height: 810 } });
  const failures: string[] = [];
  for (const id of await slideIds(page)) {
    await goToSlide(page, id);
    const small = await page.locator(`#${id}`).evaluate((slide, floor) => {
      const found: string[] = [];
      for (const element of slide.querySelectorAll<HTMLElement>('*')) {
        if (element.closest('.notes, pre, svg')) continue;
        const own = [...element.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim());
        if (!own.length) continue;
        const style = getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden' || element.getClientRects().length === 0) continue;
        const size = parseFloat(style.fontSize);
        if (size < floor) found.push(`${element.tagName.toLowerCase()}.${element.className} is ${size}px: ${element.textContent?.trim().slice(0, 40)}`);
      }
      for (const svg of slide.querySelectorAll<SVGSVGElement>('svg[viewBox]')) {
        if (!svg.clientWidth || !svg.clientHeight) continue;
        const scale = Math.min(svg.clientWidth / svg.viewBox.baseVal.width, svg.clientHeight / svg.viewBox.baseVal.height);
        for (const text of svg.querySelectorAll<SVGTextElement>('text')) {
          const size = parseFloat(getComputedStyle(text).fontSize) * scale;
          if (size < floor) found.push(`svg text is ${size.toFixed(1)}px: ${text.textContent?.trim().slice(0, 40)}`);
        }
      }
      return found;
    }, minimumTextPixels);
    failures.push(...small.map((entry) => `${id}: ${entry}`));
  }
  expect(failures).toEqual([]);
});

test('staged chat scenes are labeled and never ping real audiences', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-dark', 'Structure checks run once.');
  await openDeck(page, '?mode=read');
  const problems = await page.locator('.chat').evaluateAll((chats) => chats.flatMap((chat, index) => {
    const label = chat.querySelector('.chat-label')?.textContent?.trim() ?? '';
    const text = chat.textContent ?? '';
    const issues: string[] = [];
    if (!/^staged/i.test(label)) issues.push(`chat ${index + 1} is not labeled as staged (label: "${label}")`);
    if (/@(everyone|here)\b/i.test(text)) issues.push(`chat ${index + 1} mentions a broadcast audience`);
    return issues;
  }));
  expect(problems).toEqual([]);
  expect(await page.locator('.chat').count()).toBeGreaterThan(0);
});

test('evolution chapters are dated and stay in chronological order', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-dark', 'Structure checks run once.');
  await openDeck(page, '?mode=read');
  const kickers = await page.locator('section[data-chapter="How it evolved"]').evaluateAll((slides) => slides
    .map((slide) => ({ id: slide.id, kicker: slide.querySelector('.kicker')?.textContent?.trim() ?? '' }))
    .filter((slide) => slide.kicker && slide.id !== 'timeline'));
  expect(kickers.length).toBeGreaterThanOrEqual(6);

  const months: Record<string, number> = { Aug: 8, Sep: 9, Oct: 10 };
  let previous = 0;
  for (const { id, kicker } of kickers) {
    const match = kicker.match(/^(Aug|Sep|Oct) (\d{1,2})/);
    expect(match, `${id} kicker should start with a date: "${kicker}"`).not.toBeNull();
    const ordinal = months[match![1]] * 100 + Number(match![2]);
    expect(ordinal, `${id} (${kicker}) should not come before the previous chapter`).toBeGreaterThanOrEqual(previous);
    previous = ordinal;
  }
});

test('every staged scene walks the audience through three callouts', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-dark', 'Structure checks run once.');
  await openDeck(page, '?mode=read');
  const counts = await page.locator('.scene').evaluateAll((scenes) => scenes.map((scene) => ({
    id: scene.closest('section')?.id ?? '',
    callouts: scene.querySelectorAll('.callouts > li').length,
  })));
  expect(counts.length).toBeGreaterThan(0);
  for (const scene of counts) expect(scene.callouts, `${scene.id} callouts`).toBe(3);
});
