import { expect, test } from '@playwright/test';
import { goToSlide, kebabCaseId, openDeck, openDeckWith, openMenu, slideIds, slideRecords } from './helpers';

test('navigation, deep links, menu wiring, shortcuts, and link contracts stay generic', async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  test.skip(testInfo.project.name !== 'desktop-dark', 'Integrated navigation checks run once.');

  await openDeckWith(page, { theme: 'light', mode: 'present', reducedMotion: 'no-preference' });
  const slides = await slideRecords(page);
  const ids = slides.map((slide) => slide.id);
  const total = ids.length;
  expect(total).toBeGreaterThan(0);
  expect(new Set(ids).size).toBe(total);
  for (const slide of slides) {
    expect(slide.id).toMatch(kebabCaseId);
    expect(slide.chapter, `${slide.id} is missing data-chapter`).not.toBe('');
  }
  await expect(page.locator('#slide-position')).toHaveText(`1 / ${total}`);

  const internalLinks = await page.locator('a[href^="#/"]').evaluateAll((links) => links.map((link) => ({
    href: link.getAttribute('href') ?? '',
    text: link.textContent?.trim() ?? '',
  })));
  for (const link of internalLinks) {
    const target = decodeURIComponent(link.href.slice(2).split('/')[0]);
    expect(ids, `${link.text || link.href} should resolve to an existing slide id`).toContain(target);
  }

  const externalLinks = await page.locator('a[href^="http"]').evaluateAll((links) => links.map((link) => ({
    href: link.getAttribute('href') ?? '',
    target: link.getAttribute('target'),
    rel: link.getAttribute('rel') ?? '',
    text: link.textContent?.trim() ?? '',
  })));
  for (const link of externalLinks) {
    expect(link.href, `${link.text || link.href} should use https`).toMatch(/^https:\/\//i);
    if (link.target === '_blank') expect(link.rel.split(/\s+/)).toContain('noopener');
  }

  const menuTargets = await page.locator('#deck-menu [data-slide]').evaluateAll((links) => links.map((link) => ({
    chapter: link.getAttribute('data-core-chapter'),
    slide: link.getAttribute('data-slide') ?? '',
    href: link.getAttribute('href') ?? '',
  })));
  expect(menuTargets.length).toBeGreaterThan(0);
  for (const target of menuTargets) {
    expect(ids, `[data-slide="${target.slide}"] should point at a real slide`).toContain(target.slide);
    expect(target.href).toBe(`#/${target.slide}`);
  }

  const firstCodeSlide = await page.locator('section[id]').evaluateAll((sections) => {
    const match = sections.find((section) => section.querySelector('.code-step.fragment'));
    if (!match) return null;
    return {
      id: match.id,
      steps: [...match.querySelectorAll<HTMLElement>('.code-step.fragment')].map((step) => ({
        code: step.dataset.code ?? '',
        lines: step.dataset.lines ?? '',
      })),
      lineCounts: [...match.querySelectorAll<HTMLElement>('pre > code')].map((code) => ({
        id: code.parentElement?.id ?? '',
        count: code.querySelectorAll('.code-line').length,
      })),
    };
  });

  if (firstCodeSlide) {
    await goToSlide(page, firstCodeSlide.id);
    await expect(page.locator('#slide-position')).toHaveText(`${ids.indexOf(firstCodeSlide.id) + 1} / ${total}`);
    await expect(page.locator(`#${firstCodeSlide.id} .code-step.fragment`)).toHaveCount(firstCodeSlide.steps.length);
    await page.locator('#next').click();
    const focusState = await page.locator(`#${firstCodeSlide.id}`).evaluate((slide) => {
      const latest = [...slide.querySelectorAll<HTMLElement>('.code-step.visible')].at(-1);
      const code = latest ? slide.querySelector<HTMLElement>(`#${latest.dataset.code}`) : null;
      const expected = (latest?.dataset.lines ?? '').split(',').filter(Boolean).flatMap((range) => {
        const [first, last = first] = range.split('-').map(Number);
        return Array.from({ length: last - first + 1 }, (_, index) => first + index);
      });
      return {
        targetExists: !!code,
        expected,
        focused: code ? [...code.querySelectorAll<HTMLElement>('.code-line.is-focused')].map((line) => Number(line.dataset.line)) : [],
      };
    });
    expect(focusState.targetExists).toBe(true);
    expect(focusState.focused.length, 'the first code step should focus at least one line').toBeGreaterThan(0);
    expect(focusState.focused.every((number) => number >= 1)).toBe(true);
    await page.locator('#previous').click();
    await expect(page.locator(`#${firstCodeSlide.id} .code-step.visible`)).toHaveCount(0);
  }

  const chapterLinks = menuTargets.filter((target) => target.chapter);
  for (const target of chapterLinks) {
    await openMenu(page, '#chapter-toggle');
    await page.locator(`[data-core-chapter="${target.chapter}"]`).click();
    await expect(page.locator('section.present')).toHaveAttribute('data-purpose', 'why');
    await expect(page.locator('section.present')).toHaveAttribute('data-chapter', String(target.chapter));
  }

  await page.locator('#presentation').focus();
  await page.keyboard.press('t');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.keyboard.press('t');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

  await page.keyboard.press('r');
  await expect(page.locator('html')).toHaveAttribute('data-reading', 'true');
  await expect(page).toHaveURL(/mode=read/);
  await page.keyboard.press('r');
  await expect(page.locator('html')).toHaveAttribute('data-reading', 'false');
  await expect(page).toHaveURL(/mode=present/);

  await page.keyboard.press('Escape');
  await expect(page.locator('.reveal')).toHaveClass(/overview/);
  await page.keyboard.press('Escape');
  await expect(page.locator('.reveal')).not.toHaveClass(/overview/);

  const popupPromise = page.waitForEvent('popup');
  await page.keyboard.press('s');
  const popup = await popupPromise;
  await expect(popup).toHaveTitle('reveal.js - Speaker View');
  await popup.close();

  await openMenu(page);
  await page.keyboard.press('Escape');
  await expect(page.locator('#deck-menu')).toBeHidden();
  await expect(page.locator('#menu-toggle')).toBeFocused();
});

test('a stale or malformed deep link still starts the deck', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-dark', 'Deep-link robustness runs once.');
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });

  for (const url of ['?mode=read#/no-such-slide', '?mode=read#/%E0%A4%A', '?mode=present#/no-such-slide', '?mode=present#/%E0%A4%A']) {
    await openDeck(page, url);
    await expect(page.locator('#slide-position'), `${url} should open on a real slide`).toHaveText(/^\d+ \/ \d+$/);
    await expect(page.locator('#next')).toBeVisible();
  }
  expect(errors).toEqual([]);
});

test('focus order, minimum target sizes, and visible controls stay accessible', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-dark', 'Keyboard and target geometry checks run once.');
  await openDeck(page, '?mode=read');

  await page.keyboard.press('Tab');
  await expect(page.locator('.skip-link')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#presentation')).toBeFocused();

  await openMenu(page);
  const targetIssues = await page.locator('.toolbar, #deck-menu, .speaker-socials, .closing-links').evaluateAll((roots) => roots.flatMap((root) =>
    [...root.querySelectorAll<HTMLElement>('a, button')]
      .filter((element) => {
        const style = getComputedStyle(element);
        return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
      })
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width >= 44 && rect.height >= 44
          ? null
          : `${element.tagName} ${element.id || element.getAttribute('aria-label') || element.textContent?.trim() || 'target'} is ${Math.round(rect.width)}x${Math.round(rect.height)}`;
      })
      .filter(Boolean) as string[]));
  expect(targetIssues).toEqual([]);

  await page.keyboard.press('Escape');
  await expect(page.locator('#deck-menu')).toBeHidden();
  await expect(page.locator('#menu-toggle')).toBeFocused();
});

test('local assets load with no console errors, failed responses, or external requests', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-light', 'Network hygiene runs once.');
  const deckOrigin = new URL(String(testInfo.project.use.baseURL ?? process.env.DECK_URL ?? 'http://127.0.0.1:4173/')).origin;
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const externalRequests = new Set<string>();
  const failedResponses: string[] = [];

  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('request', (request) => {
    if (!/^https?:/i.test(request.url())) return;
    if (new URL(request.url()).origin !== deckOrigin) externalRequests.add(request.url());
  });
  page.on('response', (response) => {
    if (/^https?:/i.test(response.url()) && new URL(response.url()).origin === deckOrigin && !response.ok()) {
      failedResponses.push(`${response.status()} ${response.url()}`);
    }
  });

  await openDeck(page, '?theme=light&mode=read');
  const ids = await slideIds(page);
  await goToSlide(page, ids.at(-1) ?? ids[0]);
  await openMenu(page);
  await page.keyboard.press('Escape');

  await expect(page.locator('.brand-link img')).toHaveJSProperty('naturalWidth', 32);
  expect(await page.evaluate(() => document.fonts.status)).toBe('loaded');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
  expect([...externalRequests]).toEqual([]);
  expect(failedResponses).toEqual([]);
});

test('reduced motion and print expose complete static slides with no hidden fragments', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-dark', 'Static mode checks run once.');
  await openDeckWith(page, { mode: 'present', reducedMotion: 'reduce', viewport: { width: 1440, height: 810 } });
  await expect(page.locator('html')).toHaveAttribute('data-static', 'true');

  const reducedState = await page.evaluate(() => ({
    hiddenFragments: [...document.querySelectorAll<HTMLElement>('.fragment')].filter((fragment) => {
      const style = getComputedStyle(fragment);
      return style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) < 1;
    }).length,
    hiddenStages: [...document.querySelectorAll<HTMLElement>('.architecture-svg .graph-stage')].filter((stage) => {
      const style = getComputedStyle(stage);
      return style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) < 1;
    }).length,
  }));
  expect(reducedState.hiddenFragments).toBe(0);
  expect(reducedState.hiddenStages).toBe(0);

  await openDeckWith(page, { hash: '?print-pdf', viewport: { width: 1440, height: 810 } });
  const ids = await slideIds(page);
  await expect(page.locator('.pdf-page')).toHaveCount(ids.length);
  const printState = await page.evaluate(() => {
    const pages = [...document.querySelectorAll<HTMLElement>('.pdf-page')];
    const hiddenSlides = pages.flatMap((page) => {
      const slides = [...page.querySelectorAll<HTMLElement>('section[id]')];
      return slides
        .filter((slide) => {
          const style = getComputedStyle(slide);
          return style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0;
        })
        .map((slide) => slide.id);
    });
    const hiddenFragments = [...document.querySelectorAll<HTMLElement>('.fragment')].filter((fragment) => {
      const style = getComputedStyle(fragment);
      return style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) < 1;
    }).length;
    const hiddenStages = [...document.querySelectorAll<HTMLElement>('.architecture-svg .graph-stage')].filter((stage) => {
      const style = getComputedStyle(stage);
      return style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) < 1;
    }).length;
    const widthIssues = pages.filter((page) => {
      const pageRect = page.getBoundingClientRect();
      return [...page.querySelectorAll<HTMLElement>('section[id]')].some((slide) => slide.getBoundingClientRect().width > pageRect.width + 1);
    }).length;
    return { hiddenSlides, hiddenFragments, hiddenStages, widthIssues };
  });
  expect(printState.hiddenSlides).toEqual([]);
  expect(printState.hiddenFragments).toBe(0);
  expect(printState.hiddenStages).toBe(0);
  expect(printState.widthIssues).toBe(0);
});
