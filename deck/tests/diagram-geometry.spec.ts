import { expect, test, type Page } from '@playwright/test';
import { diagramSlideIds, goToSlide, openDeckWith } from './helpers';

type DiagramAudit = {
  id: string;
  issues: string[];
  nodeCount: number;
  edgeCount: number;
};

async function auditDiagram(page: Page, id: string): Promise<DiagramAudit> {
  await goToSlide(page, id);
  return page.locator(`#${id} .architecture-svg`).evaluate((svgElement) => {
    if (!(svgElement instanceof SVGSVGElement)) throw new Error('Expected an active architecture SVG.');
    const svg = svgElement;
    const rootMatrix = svg.getCTM();
    if (!rootMatrix) throw new Error('Diagram has no current transformation matrix.');
    const inverse = rootMatrix.inverse();

    function projectBox(graphic: SVGGraphicsElement) {
      const bounds = graphic.getBBox();
      const matrix = inverse.multiply(graphic.getCTM()!);
      const corners = [
        new DOMPoint(bounds.x, bounds.y),
        new DOMPoint(bounds.x + bounds.width, bounds.y),
        new DOMPoint(bounds.x, bounds.y + bounds.height),
        new DOMPoint(bounds.x + bounds.width, bounds.y + bounds.height),
      ].map((point) => point.matrixTransform(matrix));
      return {
        left: Math.min(...corners.map((point) => point.x)),
        right: Math.max(...corners.map((point) => point.x)),
        top: Math.min(...corners.map((point) => point.y)),
        bottom: Math.max(...corners.map((point) => point.y)),
      };
    }

    function pointInside(point: { x: number; y: number }, box: { left: number; right: number; top: number; bottom: number }, inset = 0) {
      return point.x >= box.left + inset && point.x <= box.right - inset && point.y >= box.top + inset && point.y <= box.bottom - inset;
    }

    function pointOnBoundary(point: { x: number; y: number }, box: { left: number; right: number; top: number; bottom: number }, tolerance = 2) {
      if (point.x < box.left - tolerance || point.x > box.right + tolerance || point.y < box.top - tolerance || point.y > box.bottom + tolerance) {
        return false;
      }
      return Math.min(
        Math.abs(point.x - box.left),
        Math.abs(point.x - box.right),
        Math.abs(point.y - box.top),
        Math.abs(point.y - box.bottom),
      ) <= tolerance;
    }

    function boxesOverlap(
      first: { left: number; right: number; top: number; bottom: number },
      second: { left: number; right: number; top: number; bottom: number },
      padding = 0,
    ) {
      return first.left - padding < second.right && first.right + padding > second.left &&
        first.top - padding < second.bottom && first.bottom + padding > second.top;
    }

    function boxGap(
      first: { left: number; right: number; top: number; bottom: number },
      second: { left: number; right: number; top: number; bottom: number },
    ) {
      const dx = Math.max(0, first.left - second.right, second.left - first.right);
      const dy = Math.max(0, first.top - second.bottom, second.top - first.bottom);
      if (dx === 0 && dy === 0) return 0;
      return dx === 0 ? dy : dy === 0 ? dx : Math.hypot(dx, dy);
    }

    const issues: string[] = [];
    const nodes = [...svg.querySelectorAll<SVGGElement>('.graph-node')].map((node) => {
      const rect = node.querySelector<SVGRectElement>('rect');
      if (!rect) throw new Error(`Node ${node.dataset.node ?? 'unknown'} is missing its rect.`);
      const title = node.querySelector<SVGTextElement>('.node-title');
      if (!title) throw new Error(`Node ${node.dataset.node ?? 'unknown'} is missing its title.`);
      const details = [...node.querySelectorAll<SVGTextElement>('.node-detail')];
      const icon = node.querySelector<SVGGraphicsElement>('svg');
      return {
        id: node.dataset.node ?? '',
        rect: projectBox(rect),
        title: projectBox(title),
        details: details.map((detail) => ({ text: detail.textContent ?? '', box: projectBox(detail) })),
        icon: icon ? projectBox(icon) : undefined,
      };
    });

    for (const node of nodes) {
      if (node.title.left < node.rect.left + 12 || node.title.right > node.rect.right - 12) {
        issues.push(`${svg.dataset.graph}:${node.id}: title misses 12px horizontal padding`);
      }
      if (node.title.bottom > node.rect.bottom - 8 || node.title.top < node.rect.top + 8) {
        issues.push(`${svg.dataset.graph}:${node.id}: title exceeds node bounds`);
      }
      if (node.icon && boxesOverlap(node.title, node.icon, 0)) {
        issues.push(`${svg.dataset.graph}:${node.id}: title overlaps icon`);
      }
      for (const detail of node.details) {
        if (detail.box.left < node.rect.left + 12 || detail.box.right > node.rect.right - 12) {
          issues.push(`${svg.dataset.graph}:${node.id}: detail \"${detail.text}\" misses 12px horizontal padding`);
        }
        if (detail.box.bottom > node.rect.bottom - 8 || detail.box.top < node.rect.top + 8) {
          issues.push(`${svg.dataset.graph}:${node.id}: detail \"${detail.text}\" exceeds node bounds`);
        }
      }
    }

    for (let first = 0; first < nodes.length; first++) {
      for (let second = first + 1; second < nodes.length; second++) {
        const gap = boxGap(nodes[first].rect, nodes[second].rect);
        if (gap < 12) issues.push(`${svg.dataset.graph}:${nodes[first].id}/${nodes[second].id}: node gap ${gap.toFixed(2)} is below 12px`);
      }
    }

    const edges = [...svg.querySelectorAll<SVGGElement>('.graph-edge')].map((edge) => {
      const path = edge.querySelector<SVGPathElement>('.edge-path');
      if (!path) throw new Error(`Edge ${edge.dataset.from ?? '?'} -> ${edge.dataset.to ?? '?'} is missing its path.`);
      const pathMatrix = inverse.multiply(path.getCTM()!);
      const length = path.getTotalLength();
      const step = Math.max(2, Math.min(6, Math.ceil(length / 80)));
      function point(distance: number) {
        const source = path.getPointAtLength(distance).matrixTransform(pathMatrix);
        return { x: source.x, y: source.y };
      }
      const label = edge.querySelector<SVGTextElement>('.edge-label');
      return {
        id: `${edge.dataset.from ?? '?'}->${edge.dataset.to ?? '?'}`,
        from: edge.dataset.from ?? '',
        to: edge.dataset.to ?? '',
        start: point(0),
        end: point(length),
        samples: Array.from({ length: Math.floor(length / step) + 1 }, (_, index) => point(Math.min(length, index * step))),
        label: label ? projectBox(label) : undefined,
      };
    });

    const nodeMap = new Map(nodes.map((node) => [node.id, node]));
    for (const edge of edges) {
      const source = nodeMap.get(edge.from);
      const target = nodeMap.get(edge.to);
      if (!source || !target) {
        issues.push(`${svg.dataset.graph}:${edge.id}: missing source or target node`);
        continue;
      }
      if (!pointOnBoundary(edge.start, source.rect, 2)) issues.push(`${svg.dataset.graph}:${edge.id}: edge start misses the source boundary`);
      if (!pointOnBoundary(edge.end, target.rect, 2)) issues.push(`${svg.dataset.graph}:${edge.id}: edge end misses the target boundary`);
      for (const node of nodes) {
        if (node.id === edge.from || node.id === edge.to) continue;
        const crosses = edge.samples.slice(1, -1).some((point) => pointInside(point, node.rect, 2));
        if (crosses) issues.push(`${svg.dataset.graph}:${edge.id}: path crosses node ${node.id}`);
      }
    }

    const labeledEdges = edges.filter((edge) => edge.label);
    for (const edge of labeledEdges) {
      const label = edge.label!;
      for (const node of nodes) {
        if (boxesOverlap(label, node.rect, 0)) issues.push(`${svg.dataset.graph}:${edge.id}: label overlaps node ${node.id}`);
      }
      for (const other of labeledEdges) {
        if (edge === other) continue;
        if (boxesOverlap(label, other.label!, 0)) issues.push(`${svg.dataset.graph}:${edge.id}: label overlaps ${other.id}`);
      }
      for (const other of edges) {
        if (other === edge) continue;
        if (other.samples.some((point) => pointInside(point, label, -2))) {
          issues.push(`${svg.dataset.graph}:${edge.id}: label overlaps path ${other.id}`);
        }
      }
    }

    return {
      id: svg.dataset.graph ?? svg.closest('section')?.id ?? 'diagram',
      issues,
      nodeCount: nodes.length,
      edgeCount: edges.length,
    };
  });
}

for (const theme of ['light', 'dark'] as const) {
  test(`diagram geometry stays strict in ${theme}`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-dark', 'Diagram geometry audits run once per theme.');
    await openDeckWith(page, {
      theme,
      mode: 'present',
      reducedMotion: 'reduce',
      viewport: { width: 1440, height: 810 },
    });

    const ids = await diagramSlideIds(page);
    const audits: DiagramAudit[] = [];
    for (const id of ids) audits.push(await auditDiagram(page, id));
    expect(audits.reduce((total, audit) => total + audit.nodeCount, 0)).toBeGreaterThan(0);
    expect(audits.reduce((total, audit) => total + audit.edgeCount, 0)).toBeGreaterThan(0);
    expect(audits.flatMap((audit) => audit.issues)).toEqual([]);
  });
}

test('diagram geometry self-test proves the detector catches synthetic overflow and label collisions', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-dark', 'Geometry self-test runs once.');
  await openDeckWith(page, {
    theme: 'dark',
    mode: 'present',
    reducedMotion: 'reduce',
    viewport: { width: 1440, height: 810 },
  });

  let firstId = '';
  for (const id of await diagramSlideIds(page)) {
    if ((await page.locator(`#${id} .architecture-svg .edge-label`).count()) >= 2) {
      firstId = id;
      break;
    }
  }
  expect(firstId, 'a diagram with at least two edge labels').toBeTruthy();
  await goToSlide(page, firstId);
  const syntheticIssues = await page.locator(`#${firstId} .architecture-svg`).evaluate((svgElement) => {
    if (!(svgElement instanceof SVGSVGElement)) throw new Error('Expected a source SVG.');
    const clone = svgElement.cloneNode(true) as SVGSVGElement;
    clone.dataset.graph = `${svgElement.dataset.graph ?? 'diagram'}-self-test`;
    clone.style.position = 'fixed';
    clone.style.left = '-9999px';
    clone.style.top = '0';
    clone.style.width = `${svgElement.getBoundingClientRect().width}px`;
    clone.style.height = `${svgElement.getBoundingClientRect().height}px`;
    document.body.appendChild(clone);

    const badTitle = clone.querySelector<SVGTextElement>('.node-title');
    if (badTitle) {
      badTitle.setAttribute('x', '0');
      badTitle.textContent = 'Synthetic title that must overflow into the icon column';
    }
    const labels = clone.querySelectorAll<SVGTextElement>('.edge-label');
    if (labels.length >= 2) {
      labels[0].setAttribute('x', '640');
      labels[0].setAttribute('y', '270');
      labels[1].setAttribute('x', '640');
      labels[1].setAttribute('y', '270');
    }

    const rootMatrix = clone.getCTM();
    if (!rootMatrix) throw new Error('Synthetic clone has no matrix.');
    const inverse = rootMatrix.inverse();
    function projectBox(graphic: SVGGraphicsElement) {
      const bounds = graphic.getBBox();
      const matrix = inverse.multiply(graphic.getCTM()!);
      const corners = [
        new DOMPoint(bounds.x, bounds.y),
        new DOMPoint(bounds.x + bounds.width, bounds.y),
        new DOMPoint(bounds.x, bounds.y + bounds.height),
        new DOMPoint(bounds.x + bounds.width, bounds.y + bounds.height),
      ].map((point) => point.matrixTransform(matrix));
      return {
        left: Math.min(...corners.map((point) => point.x)),
        right: Math.max(...corners.map((point) => point.x)),
        top: Math.min(...corners.map((point) => point.y)),
        bottom: Math.max(...corners.map((point) => point.y)),
      };
    }
    function boxesOverlap(first: { left: number; right: number; top: number; bottom: number }, second: { left: number; right: number; top: number; bottom: number }) {
      return first.left < second.right && first.right > second.left && first.top < second.bottom && first.bottom > second.top;
    }
    const node = clone.querySelector<SVGGElement>('.graph-node');
    const rect = node?.querySelector<SVGRectElement>('rect');
    const title = node?.querySelector<SVGTextElement>('.node-title');
    const icon = node?.querySelector<SVGGraphicsElement>('svg');
    const issues: string[] = [];
    if (node && rect && title) {
      const nodeRect = projectBox(rect);
      const titleRect = projectBox(title);
      if (titleRect.left < nodeRect.left + 12) issues.push('synthetic-title-padding');
      if (icon && boxesOverlap(titleRect, projectBox(icon))) issues.push('synthetic-title-overlaps-icon');
    }
    if (labels.length >= 2) {
      const first = projectBox(labels[0]);
      const second = projectBox(labels[1]);
      if (boxesOverlap(first, second)) issues.push('synthetic-label-overlap');
    }
    clone.remove();
    return issues;
  });

  expect(syntheticIssues).toContain('synthetic-title-padding');
  expect(syntheticIssues).toContain('synthetic-title-overlaps-icon');
  expect(syntheticIssues).toContain('synthetic-label-overlap');
});
