import { expect, type Page } from '@playwright/test';

export type Theme = 'light' | 'dark';
export type DeckMode = 'present' | 'read';

export const kebabCaseId = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export async function openDeck(page: Page, url = '') {
  await page.goto(url);
  await expect(page.locator('html')).toHaveAttribute('data-deck-ready', 'true');
  await page.evaluate(() => document.fonts.ready);
}

export async function openDeckWith(page: Page, options: {
  theme?: Theme;
  mode?: DeckMode;
  hash?: string;
  reducedMotion?: 'reduce' | 'no-preference';
  viewport?: { width: number; height: number };
}) {
  const { theme, mode, hash, reducedMotion, viewport } = options;
  if (viewport) await page.setViewportSize(viewport);
  if (theme || reducedMotion) {
    await page.emulateMedia({
      ...(theme ? { colorScheme: theme } : {}),
      ...(reducedMotion ? { reducedMotion } : {}),
    });
  }
  const params = new URLSearchParams();
  if (theme) params.set('theme', theme);
  if (mode) params.set('mode', mode);
  const query = params.toString();
  await openDeck(page, `${query ? `?${query}` : ''}${hash ?? ''}`);
}

export async function slideIds(page: Page) {
  return page.locator('section[id]').evaluateAll((slides) => slides.map((slide) => slide.id));
}

export async function slideRecords(page: Page) {
  return page.locator('section[id]').evaluateAll((slides) => slides.map((slide) => ({
    id: slide.id,
    chapter: slide.getAttribute('data-chapter') ?? '',
    purpose: slide.getAttribute('data-purpose'),
    appendix: slide.hasAttribute('data-appendix'),
    notes: slide.querySelector('.notes')?.textContent?.trim() ?? '',
  })));
}

export async function diagramSlideIds(page: Page) {
  return page.locator('section[id]').evaluateAll((slides) => slides
    .filter((slide) => slide.querySelector('.architecture-svg, [data-diagram]'))
    .map((slide) => slide.id));
}

export async function codeSlideIds(page: Page) {
  return page.locator('section[id]').evaluateAll((slides) => slides
    .filter((slide) => slide.querySelector('pre'))
    .map((slide) => slide.id));
}

export async function openMenu(page: Page, opener = '#menu-toggle') {
  await page.locator(opener).click();
  await expect(page.locator('#deck-menu')).toBeVisible();
}

export async function goToSlide(page: Page, id: string) {
  await page.evaluate((slideId) => {
    window.location.hash = `/${slideId}`;
  }, id);
  const slide = page.locator(`#${id}`);
  const heading = slide.locator('h1, h2').first();
  if (await heading.count()) await expect(heading).toBeInViewport();
  else await expect(slide).toBeVisible();
  if (await page.locator('html').getAttribute('data-reading') !== 'true') {
    await expect(slide).toHaveClass(/present/);
  }
}

export function parseTimingRange(notes: string) {
  const match = notes.match(/^(\d+):(\d{2})-(\d+):(\d{2})\./);
  if (!match) return null;
  const start = Number(match[1]) * 60 + Number(match[2]);
  const end = Number(match[3]) * 60 + Number(match[4]);
  return { start, end };
}

function parseChannel(value: string) {
  const percent = value.trim().endsWith('%');
  const numeric = Number.parseFloat(value);
  return percent ? numeric * 2.55 : numeric;
}

export function parseColor(color: string) {
  const normalized = color.trim().toLowerCase();
  if (normalized.startsWith('#')) {
    const hex = normalized.slice(1);
    const full = hex.length === 3 ? [...hex].map((part) => part + part).join('') : hex;
    return {
      r: Number.parseInt(full.slice(0, 2), 16),
      g: Number.parseInt(full.slice(2, 4), 16),
      b: Number.parseInt(full.slice(4, 6), 16),
    };
  }
  const match = normalized.match(/rgba?\(([^)]+)\)/);
  if (!match) throw new Error(`Unsupported color: ${color}`);
  const [r, g, b] = match[1].split(',').slice(0, 3).map(parseChannel);
  return { r, g, b };
}

export function luminance(color: string) {
  const { r, g, b } = parseColor(color);
  const channels = [r, g, b].map((value) => {
    const normalized = value / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

export function contrastRatio(foreground: string, background: string) {
  const first = luminance(foreground);
  const second = luminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}
