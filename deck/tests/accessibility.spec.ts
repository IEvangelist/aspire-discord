import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { goToSlide, openDeck, openMenu, slideIds } from './helpers';

test('axe passes every slide with zero violations in each project surface', async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  const mode = testInfo.project.name === 'mobile' ? 'read' : 'present';
  const theme = testInfo.project.name === 'desktop-light' ? 'light' : 'dark';
  // Reduced motion removes slide fades so axe never samples a half-transparent slide, and it exposes every diagram stage and code step.
  await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
  await openDeck(page, `?theme=${theme}&mode=${mode}`);

  const ids = await slideIds(page);
  const failures: { id: string; violations: { id: string; impact: string | null; targets: string[] }[] }[] = [];
  for (const id of ids) {
    await goToSlide(page, id);
    const results = await new AxeBuilder({ page })
      .include('.toolbar')
      .include(`#${id}`)
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze();
    if (results.violations.length) {
      failures.push({
        id,
        violations: results.violations.map((violation) => ({
          id: violation.id,
          impact: violation.impact ?? null,
          targets: violation.nodes.slice(0, 3).map((node) => node.target.join(' ')),
        })),
      });
    }
  }

  await openMenu(page);
  const menuResults = await new AxeBuilder({ page })
    .include('#deck-menu')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
  if (menuResults.violations.length) {
    failures.push({
      id: 'deck-menu',
      violations: menuResults.violations.map((violation) => ({
        id: violation.id,
        impact: violation.impact ?? null,
        targets: violation.nodes.slice(0, 3).map((node) => node.target.join(' ')),
      })),
    });
  }

  expect(failures, JSON.stringify(failures, null, 2)).toEqual([]);
});
