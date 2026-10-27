import { expect, test } from '@playwright/test';
import { goToSlide, openDeckWith, slideIds } from './helpers';

for (const theme of ['light', 'dark'] as const) {
  for (const viewport of [
    { width: 1280, height: 720, mode: 'present' },
    { width: 1024, height: 768, mode: 'present' },
    { width: 1440, height: 810, mode: 'present' },
    { width: 1920, height: 1080, mode: 'present' },
    { width: 390, height: 844, mode: 'read' },
    { width: 768, height: 1024, mode: 'read' },
  ] as const) {
    test(`all slides fit ${theme} ${viewport.width}x${viewport.height} ${viewport.mode}`, async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== 'desktop-dark', 'Rendered slide-fit matrices run once.');
      await openDeckWith(page, {
        theme,
        mode: viewport.mode,
        reducedMotion: 'reduce',
        viewport: { width: viewport.width, height: viewport.height },
      });

      const ids = await slideIds(page);
      const audits: { id: string; issues: string[] }[] = [];
      for (const id of ids) {
        await goToSlide(page, id);
        const issues = await page.locator(`#${id}`).evaluate((slide) => {
          const reading = document.documentElement.dataset.reading === 'true';
          const tolerance = 1;
          const toolbar = document.querySelector('.toolbar')?.getBoundingClientRect();
          const problems: string[] = [];
          function visible(element: Element) {
            const style = getComputedStyle(element);
            return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0 && element.getClientRects().length > 0;
          }

          const heading = slide.querySelector<HTMLElement>('h1, h2');
          if (heading && toolbar && visible(heading) && heading.getBoundingClientRect().top < toolbar.bottom - tolerance) {
            problems.push('heading sits behind the toolbar');
          }

          for (const block of slide.querySelectorAll<HTMLElement>('h1, h2, h3, p, li')) {
            if (block.closest('.notes') || !visible(block)) continue;
            if (block.scrollWidth > block.clientWidth + 1) {
              problems.push(`${block.tagName} scrollWidth ${block.scrollWidth} exceeds clientWidth ${block.clientWidth}`);
            }
          }

          for (const element of slide.querySelectorAll<HTMLElement>('*')) {
            if (!visible(element) || element.closest('.notes')) continue;
            const text = element.textContent?.trim() ?? '';
            if (!text) continue;
            const style = getComputedStyle(element);
            const hiddenX = /(hidden|clip)/.test(style.overflowX);
            const hiddenY = /(hidden|clip)/.test(style.overflowY);
            if ((hiddenX && element.scrollWidth > element.clientWidth + 1) ||
                (hiddenY && element.scrollHeight > element.clientHeight + 1)) {
              problems.push(`${element.tagName} hides overflow for text: ${text.slice(0, 60)}`);
            }
          }

          if (!reading) {
            const slideRect = slide.getBoundingClientRect();
            // The section is auto-height in present mode, so measure against the fixed stage, which is what the audience sees.
            const stageRect = slide.closest<HTMLElement>('.slides')?.getBoundingClientRect() ?? slideRect;
            const content = [...slide.querySelectorAll<HTMLElement>('h1, h2, h3, p, li, ol, ul, pre, figure, figcaption, table, .thesis-path, .contrast, .code-panel, .chat, .ladder, .timeline, .cards, .callouts, .strip, .duo, [data-diagram], .architecture-svg, .architecture-mobile')]
              .filter((element) => !element.closest('.notes') && visible(element))
              .map((element) => ({
                text: element.textContent?.trim().slice(0, 60) ?? element.tagName,
                rect: element.getBoundingClientRect(),
              }));
            const maxBottom = Math.max(slideRect.top, ...content.map((item) => item.rect.bottom));
            for (const item of content) {
              if (item.rect.left < -tolerance || item.rect.right > innerWidth + tolerance) {
                problems.push(`content exceeds viewport width: ${item.text}`);
              }
            }
            if (maxBottom - slideRect.top > slideRect.height + 1) {
              problems.push(`content height ${Math.round(maxBottom - slideRect.top)} exceeds slide height ${Math.round(slideRect.height)}`);
            }
            if (maxBottom > stageRect.bottom + tolerance) {
              problems.push(`content bottom ${Math.round(maxBottom)} runs past the stage bottom ${Math.round(stageRect.bottom)}`);
            }
          }

          return problems;
        });
        audits.push({ id, issues });
      }

      expect(audits.flatMap((audit) => audit.issues.map((issue) => `${audit.id}: ${issue}`))).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    });
  }
}
