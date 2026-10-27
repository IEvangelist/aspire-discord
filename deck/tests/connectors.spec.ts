import { expect, test } from '@playwright/test';
import { diagramSlideIds, goToSlide, openDeckWith } from './helpers';

for (const theme of ['light', 'dark'] as const) {
  for (const width of [320, 390]) {
    test(`diagram mobile fallbacks stay aligned in ${theme} ${width}px reading mode`, async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== 'desktop-dark', 'Narrow reading-mode diagram fallbacks run once.');
      await openDeckWith(page, {
        theme,
        mode: 'read',
        reducedMotion: 'reduce',
        viewport: { width, height: 844 },
      });

      const ids = await diagramSlideIds(page);
      expect(ids.length).toBeGreaterThan(0);
      for (const id of ids) {
        await goToSlide(page, id);
        await expect(page.locator(`#${id} .architecture-svg`)).toBeHidden();
        const fallback = await page.locator(`#${id}`).evaluate((slide) => {
          const graphNodes = [...slide.querySelectorAll<HTMLElement>('[data-node]')].map((node) => node.dataset.node ?? '');
          const mobileNodes = [...slide.querySelectorAll<HTMLElement>('[data-mobile-node]')].map((node) => node.dataset.mobileNode ?? '');
          const rows = [...slide.querySelectorAll<HTMLElement>('.architecture-mobile li')];
          return {
            graphNodes,
            mobileNodes,
            relationCount: rows.reduce((count, row) => count + (row.querySelector('small')?.textContent?.match(/To /g)?.length ?? 0), 0),
            edgeCount: slide.querySelectorAll('.graph-edge').length,
            cycleReturn: slide.querySelectorAll('.cycle-return').length,
            hasReturnEdge: slide.querySelectorAll('.graph-edge.return').length > 0,
            fits: rows.every((row) => {
              const rect = row.getBoundingClientRect();
              return rect.left >= 0 && rect.right <= innerWidth + 1 && row.scrollWidth <= row.clientWidth + 1;
            }),
          };
        });
        expect([...fallback.mobileNodes].sort()).toEqual([...fallback.graphNodes].sort());
        expect(fallback.relationCount).toBe(fallback.edgeCount);
        expect(fallback.fits).toBe(true);
        expect(fallback.cycleReturn > 0).toBe(fallback.hasReturnEdge);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    });
  }
}

test('diagram fragments only reveal edges whose endpoints are already visible', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'Fragment geometry is exercised on desktop.');
  test.setTimeout(60_000);
  await openDeckWith(page, {
    theme: 'dark',
    mode: 'present',
    reducedMotion: 'no-preference',
    viewport: { width: 1440, height: 810 },
  });

  const ids = await diagramSlideIds(page);
  for (const id of ids) {
    await goToSlide(page, id);
    const steps = Number(await page.locator(`#${id} [data-diagram]`).getAttribute('data-steps'));
    const walk = [0, ...Array.from({ length: steps }, (_, index) => index + 1), ...Array.from({ length: steps }, (_, index) => steps - index - 1)];
    let previous = 0;
    for (const step of walk) {
      if (step > previous) await page.locator('#next').click();
      if (step < previous) await page.locator('#previous').click();
      previous = step;
      const state = await page.locator(`#${id} .architecture-svg`).evaluate((svg) => {
        function opacity(element: Element) {
          let value = 1;
          for (let parent: Element | null = element; parent; parent = parent.parentElement) {
            const style = getComputedStyle(parent);
            if (style.display === 'none' || style.visibility === 'hidden') return 0;
            value *= Number(style.opacity);
          }
          return value;
        }
        const nodes = new Map([...svg.querySelectorAll<SVGElement>('.graph-node')].map((node) => [
          node.getAttribute('data-node'),
          opacity(node.querySelector('rect')!) > 0,
        ]));
        const edges = [...svg.querySelectorAll<SVGElement>('.graph-edge')].map((edge) => ({
          from: edge.getAttribute('data-from') ?? '',
          to: edge.getAttribute('data-to') ?? '',
          visible: opacity(edge.querySelector('.edge-path')!) > 0,
          labelVisible: !!edge.querySelector('.edge-label') && opacity(edge.querySelector('.edge-label')!) > 0,
          sourceVisible: nodes.get(edge.getAttribute('data-from')) ?? false,
          targetVisible: nodes.get(edge.getAttribute('data-to')) ?? false,
        }));
        const nodeCount = svg.querySelectorAll('.graph-node').length;
        return {
          edges,
          visibleNodes: [...nodes.values()].filter(Boolean).length,
          nodeCount,
          visibleEdges: edges.filter((edge) => edge.visible).length,
          edgeCount: edges.length,
        };
      });

      for (const edge of state.edges) {
        expect(!edge.visible || (edge.sourceVisible && edge.targetVisible), `${id} stage ${step}: ${edge.from} -> ${edge.to} revealed before both endpoints`).toBe(true);
        expect(!edge.labelVisible || edge.visible, `${id} stage ${step}: ${edge.from} -> ${edge.to} label revealed before its path`).toBe(true);
      }
    }
  }
});

for (const mode of ['reduced-motion', 'read', 'print'] as const) {
  test(`all diagram surfaces are complete in ${mode}`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-dark', 'Static diagram surfaces run once.');
    if (mode === 'print') {
      await openDeckWith(page, { viewport: { width: 1440, height: 810 }, hash: '?print-pdf' });
    } else {
      await openDeckWith(page, {
        theme: 'dark',
        mode: mode === 'read' ? 'read' : 'present',
        reducedMotion: mode === 'reduced-motion' ? 'reduce' : 'no-preference',
        viewport: { width: 1440, height: 810 },
      });
    }

    const ids = await diagramSlideIds(page);
    for (const id of ids) {
      if (mode !== 'print') await goToSlide(page, id);
      const result = await page.locator(`#${id} .architecture-svg`).evaluate((svg) =>
        [...svg.querySelectorAll<SVGElement>('.graph-node rect, .graph-edge .edge-path, .graph-edge .edge-label')].map((element) => {
          let opacity = 1;
          for (let parent: Element | null = element; parent; parent = parent.parentElement) {
            const style = getComputedStyle(parent);
            if (style.display === 'none' || style.visibility === 'hidden') return false;
            opacity *= Number(style.opacity);
          }
          return opacity === 1;
        }));
      expect(result.length, `${id} should contain rendered diagram geometry`).toBeGreaterThan(0);
      expect(result.every(Boolean), `${mode} ${id} should expose every rendered diagram element`).toBe(true);
    }
  });
}
