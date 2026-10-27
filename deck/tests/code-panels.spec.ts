import { expect, test } from '@playwright/test';
import { codeSlideIds, goToSlide, openDeckWith } from './helpers';

for (const theme of ['light', 'dark'] as const) {
  for (const viewport of [
    { width: 1280, height: 720 },
    { width: 1024, height: 768 },
    { width: 1440, height: 810 },
  ]) {
    test(`${theme} ${viewport.width}x${viewport.height} code panels fit and stay legible`, async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== 'desktop-dark', 'Panel geometry matrices run once.');
      await openDeckWith(page, {
        theme,
        mode: 'present',
        reducedMotion: 'reduce',
        viewport,
      });

      const ids = await codeSlideIds(page);
      for (const id of ids) {
        await goToSlide(page, id);
        const blocks = await page.locator(`#${id}`).evaluate((slide) => {
          function parseChannel(value: string) {
            const percent = value.trim().endsWith('%');
            const numeric = Number.parseFloat(value);
            return percent ? numeric * 2.55 : numeric;
          }
          function luminance(color: string) {
            const match = color.trim().toLowerCase().match(/rgba?\(([^)]+)\)/);
            if (!match) return 0;
            const [r, g, b] = match[1].split(',').slice(0, 3).map(parseChannel);
            const channels = [r, g, b].map((value) => {
              const normalized = value / 255;
              return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
            });
            return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
          }
          function contrast(foreground: string, background: string) {
            const first = luminance(foreground);
            const second = luminance(background);
            return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
          }
          return [...slide.querySelectorAll<HTMLElement>('pre')].map((pre, index) => {
            const panel = pre.closest<HTMLElement>('.code-panel');
            const container = panel ?? pre;
            const code = pre.querySelector<HTMLElement>('code');
            const containerRect = container.getBoundingClientRect();
            const preRect = pre.getBoundingClientRect();
            const tokenElements = code ? [...code.querySelectorAll<HTMLElement>('span[class*="hljs-"]')] : [];
            const tokenClassKinds = [...new Set(tokenElements.flatMap((token) =>
              [...token.classList].filter((name) => name.startsWith('hljs-') && name !== 'hljs')))].sort();
            const colors = [...new Set([
              code ? getComputedStyle(code).color : getComputedStyle(pre).color,
              ...tokenElements.map((token) => getComputedStyle(token).color),
            ])];
            const background = getComputedStyle(pre).backgroundColor;
            const contrastFloor = Math.min(...colors.map((color) => contrast(color, background)));
            return {
              key: `${slide.id}#${pre.id || `pre-${index + 1}`}`,
              top: containerRect.top,
              bottom: containerRect.bottom,
              left: containerRect.left,
              right: containerRect.right,
              preOverflow: pre.scrollWidth - pre.clientWidth,
              pageOverflow: document.documentElement.scrollWidth - innerWidth,
              fontSize: parseFloat(getComputedStyle(pre).fontSize),
              lineCount: code?.querySelectorAll('.code-line').length ?? 0,
              preserveLayout: pre.hasAttribute('data-preserve-layout'),
              highlighted: code?.classList.contains('hljs') ?? false,
              language: code?.dataset.language ?? '',
              tokenClassKinds,
              contrastFloor,
              codeOverflow: code ? getComputedStyle(code).overflowX : '',
              rendered: code ? [...code.querySelectorAll<HTMLElement>('.code-line')].every((line) => line.getBoundingClientRect().height > 0) : false,
              hasPanel: !!panel,
              preTop: preRect.top,
              preBottom: preRect.bottom,
            };
          });
        });

        for (const block of blocks) {
          if (block.hasPanel) {
            expect(block.top, `${block.key} should fit below the toolbar`).toBeGreaterThanOrEqual(0);
            expect(block.bottom, `${block.key} should fit inside the viewport`).toBeLessThanOrEqual(viewport.height + 1);
          }
          expect(block.left, `${block.key} should stay inside the viewport`).toBeGreaterThanOrEqual(-1);
          expect(block.right, `${block.key} should stay inside the viewport`).toBeLessThanOrEqual(viewport.width + 1);
          expect(block.preTop, `${block.key} pre top`).toBeGreaterThanOrEqual(0);
          expect(block.preBottom, `${block.key} pre bottom`).toBeLessThanOrEqual(viewport.height + 1);
          expect(block.fontSize, `${block.key} font size`).toBeGreaterThanOrEqual(20);
          expect(block.lineCount, `${block.key} line count`).toBeLessThanOrEqual(13);
          expect(block.highlighted, `${block.key} should be highlighted`).toBe(true);
          if (block.lineCount > 3 && block.language !== 'plaintext') {
            expect(block.tokenClassKinds.length, `${block.key} should use at least two token classes`).toBeGreaterThanOrEqual(2);
          }
          expect(block.contrastFloor, `${block.key} token contrast`).toBeGreaterThanOrEqual(4.5);
          if (!block.preserveLayout) expect(block.preOverflow, `${block.key} should not need horizontal scrolling`).toBeLessThanOrEqual(1);
          expect(block.pageOverflow, `${block.key} should not make the page scroll horizontally`).toBeLessThanOrEqual(1);
          expect(block.codeOverflow, `${block.key} code overflow`).toBe('visible');
          expect(block.rendered, `${block.key} should render real code lines`).toBe(true);
        }
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    });
  }
}

test('code-step fragments reference parts or lines that exist and really focus them', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-dark', 'Code-step focus checks run once.');
  await openDeckWith(page, {
    theme: 'dark',
    mode: 'present',
    reducedMotion: 'no-preference',
    viewport: { width: 1440, height: 810 },
  });

  const slideIds = await page.locator('section[id]').evaluateAll((sections) => sections
    .filter((section) => section.querySelector('.code-step.fragment'))
    .map((section) => section.id));
  expect(slideIds.length, 'at least one slide steps through code').toBeGreaterThan(0);

  for (const id of slideIds) {
    await goToSlide(page, id);
    await expect(page.locator(`#${id} .code-step.visible`)).toHaveCount(0);
    const stepCount = await page.locator(`#${id} .code-step.fragment`).count();
    for (let step = 0; step < stepCount; step++) {
      await page.locator('#next').click();
      const state = await page.locator(`#${id}`).evaluate((slide) => {
        const latest = [...slide.querySelectorAll<HTMLElement>('.code-step.visible')].at(-1);
        const code = latest ? slide.querySelector<HTMLElement>(`#${latest.dataset.code}`) : null;
        const lines = [...(code?.querySelectorAll<HTMLElement>('.code-line') ?? [])];
        const parts = (latest?.dataset.parts ?? '').split(',').filter(Boolean).map(Number);
        const ranges = (latest?.dataset.lines ?? '').split(',').filter(Boolean);
        const expected = ranges.flatMap((range) => {
          const [first, last = first] = range.split('-').map(Number);
          return Array.from({ length: last - first + 1 }, (_, index) => first + index);
        });
        const availableParts = new Set(lines.map((line) => Number(line.dataset.part)).filter(Boolean));
        return {
          target: latest?.dataset.code ?? '',
          declared: parts.length + ranges.length,
          lineCount: lines.length,
          missingParts: parts.filter((part) => !availableParts.has(part)),
          invalidLines: expected.filter((number) => number < 1 || number > lines.length),
          focused: lines.filter((line) => line.classList.contains('is-focused')).map((line) => Number(line.dataset.line)),
        };
      });
      expect(state.target, `${id} step ${step + 1} should point at a code block`).not.toBe('');
      expect(state.declared, `${id} step ${step + 1} should declare data-parts or data-lines`).toBeGreaterThan(0);
      expect(state.missingParts, `${id} step ${step + 1} references excerpt parts that do not exist`).toEqual([]);
      expect(state.invalidLines, `${id} step ${step + 1} references missing lines`).toEqual([]);
      expect(state.focused.length, `${id} step ${step + 1} should focus at least one line`).toBeGreaterThan(0);
    }
  }
});
test('deliberate preserve-layout code only scrolls inside the code body', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-dark', 'Wide-line preserve-layout behavior runs once.');
  await openDeckWith(page, {
    theme: 'dark',
    mode: 'present',
    reducedMotion: 'reduce',
    viewport: { width: 1440, height: 810 },
  });

  const [firstCodeSlide] = await codeSlideIds(page);
  await goToSlide(page, firstCodeSlide);
  const firstPre = page.locator(`#${firstCodeSlide} pre`).first();
  await firstPre.evaluate((element, text) => {
    element.dataset.preserveLayout = '';
    const code = element.querySelector('code');
    if (!code) throw new Error('Expected a code element.');
    const line = document.createElement('span');
    line.className = 'code-line';
    line.dataset.line = '1';
    line.textContent = text;
    code.replaceChildren(line);
  }, `$opaque = '${'required-unbroken-value-'.repeat(12)}';`);

  const geometry = await firstPre.evaluate((element) => ({
    overflow: element.scrollWidth - element.clientWidth,
    mode: getComputedStyle(element).overflowX,
    pageOverflow: document.documentElement.scrollWidth - innerWidth,
  }));
  expect(geometry.overflow).toBeGreaterThan(1000);
  expect(geometry.mode).toBe('auto');
  expect(geometry.pageOverflow).toBeLessThanOrEqual(1);
  await firstPre.focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => firstPre.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
});
