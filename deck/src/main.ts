import Reveal from 'reveal.js';
import Notes from 'reveal.js/plugin/notes/notes.esm.js';
import 'reveal.js/dist/reveal.css';
import '@fontsource/poppins/latin-400.css';
import '@fontsource/poppins/latin-500.css';
import '@fontsource/poppins/latin-600.css';
import '@fontsource/poppins/latin-700.css';
import '@fontsource/fira-code/latin-400.css';
import '@fontsource/fira-code/latin-500.css';
import { renderIcons } from './icons';
import { renderDiagrams } from './diagrams';
import { focusCode, highlightCode } from './syntax';
import './style.css';

function element<T extends HTMLElement>(id: string, type: { new(): T }): T {
  const result = document.getElementById(id);
  if (!(result instanceof type)) throw new Error(`Missing presentation element: ${id}`);
  return result;
}

const root = element('presentation', HTMLElement);
const themeButton = element('theme', HTMLButtonElement);
const readButton = element('read-mode', HTMLButtonElement);
const overviewButton = element('overview', HTMLButtonElement);
const notesButton = element('notes', HTMLButtonElement);
const menu = element('deck-menu', HTMLDialogElement);
const menuButton = element('menu-toggle', HTMLButtonElement);
const chapterButton = element('chapter-toggle', HTMLButtonElement);
const chapterLabel = element('chapter-label', HTMLSpanElement);
const previousButton = element('previous', HTMLButtonElement);
const nextButton = element('next', HTMLButtonElement);
const position = element('slide-position', HTMLOutputElement);
const status = element('deck-status', HTMLParagraphElement);
const darkPreference = window.matchMedia('(prefers-color-scheme: dark)');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const params = new URL(window.location.href).searchParams;
const initialTheme = params.get('theme');
let explicitTheme = initialTheme === 'dark' || initialTheme === 'light';
const printMode = params.has('print-pdf');
const initialView = params.get('mode');
const slides = [...root.querySelectorAll<HTMLElement>('.slides > section[id]')];
let currentId = slides[0]?.id ?? 'intro';
let reading = !printMode && (initialView === 'read' ||
  (initialView !== 'present' && (window.innerWidth < 1000 || window.innerHeight < 650)));
let readingObserver: IntersectionObserver | undefined;

renderIcons();
renderDiagrams();
highlightCode();

function setTheme(theme: 'dark' | 'light') {
  document.documentElement.dataset.theme = theme;
  themeButton.setAttribute('aria-label', `Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`);
}

function toggleTheme() {
  explicitTheme = true;
  const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  setTheme(theme);
  const url = new URL(window.location.href);
  url.searchParams.set('theme', theme);
  window.history.replaceState(null, '', url);
}

setTheme(initialTheme === 'dark' || initialTheme === 'light'
  ? initialTheme
  : darkPreference.matches ? 'dark' : 'light');

const deck = new Reveal(root, {
  width: reading ? Math.min(root.clientWidth, 1440) : Math.max(1200, Math.min(1440, root.clientWidth / root.clientHeight * 810)),
  height: reading ? root.clientHeight : 810,
  margin: 0.04,
  minScale: 0.15,
  maxScale: 1.4,
  hash: !reading,
  history: !reading,
  controls: false,
  progress: true,
  embedded: true,
  center: false,
  transition: reducedMotion.matches ? 'none' : 'fade',
  backgroundTransition: 'none',
  transitionSpeed: 'fast',
  view: reading ? 'scroll' : null,
  scrollSnap: 'proximity',
  scrollActivationWidth: 0,
  scrollProgress: false,
  showNotes: false,
  fragments: !reading && !reducedMotion.matches && !printMode,
  pdfSeparateFragments: false,
  keyboardCondition: () => {
    if (menu.open) return false;
    // Code panels are focusable so wide lines can scroll. Give them the arrow keys only when they really scroll,
    // so clicking a panel mid-talk never silences the clicker.
    const active = document.activeElement;
    return !(active instanceof HTMLPreElement && active.scrollWidth > active.clientWidth + 1);
  },
  plugins: [Notes],
});

function updateModeControls() {
  readButton.querySelector('.control-label')!.textContent = reading ? 'Presentation mode' : 'Reading mode';
  readButton.setAttribute('aria-pressed', String(reading));
  readButton.setAttribute('aria-label', reading ? 'Switch to presentation mode' : 'Switch to reading mode');
  overviewButton.disabled = reading;
  overviewButton.title = reading ? 'Switch to presentation mode for overview' : 'Overview (Esc)';
  document.documentElement.dataset.reading = String(reading);
  document.documentElement.dataset.static = String(reading || reducedMotion.matches || printMode);
}

function syncControls() {
  if (!reading) currentId = deck.getCurrentSlide()?.id ?? currentId;
  const index = slides.findIndex((slide) => slide.id === currentId);
  const slide = document.getElementById(currentId);
  position.value = `${index + 1} / ${slides.length}`;
  position.setAttribute('aria-label', `Slide ${index + 1} of ${slides.length}`);
  chapterLabel.textContent = slide?.dataset.chapter ?? 'Building Aspirey Bot';
  previousButton.disabled = index <= 0 && (reading || !deck.availableFragments().prev);
  nextButton.disabled = index >= slides.length - 1 && (reading || !deck.availableFragments().next);
  menu.querySelectorAll('[data-slide]').forEach((link) => {
    const item = link as HTMLAnchorElement;
    const current = item.hasAttribute('data-core-chapter')
      ? item.getAttribute('data-core-chapter') === slide?.dataset.chapter
      : item.getAttribute('data-slide') === currentId;
    item.setAttribute('aria-current', current ? 'step' : 'false');
  });
  if (slide) focusCode(slide, reading || reducedMotion.matches || printMode);
  if (!reading) {
    for (const inactive of root.querySelectorAll<HTMLElement>('section:not(.present)')) {
      inactive.getAnimations({ subtree: true }).forEach((animation) => animation.cancel());
    }
  }
}

function observeReading() {
  readingObserver?.disconnect();
  if (!reading) return;
  readingObserver = new IntersectionObserver((entries) => {
    const visible = entries.filter((entry) => entry.isIntersecting)
      .sort((first, second) => Math.abs(first.boundingClientRect.top - root.getBoundingClientRect().top) -
        Math.abs(second.boundingClientRect.top - root.getBoundingClientRect().top));
    if (!visible[0]) return;
    currentId = (visible[0].target as HTMLElement).id;
    syncControls();
  }, { root, threshold: [0.15, 0.5], rootMargin: '0px 0px -20% 0px' });
  for (const slide of root.querySelectorAll<HTMLElement>('section[id]')) readingObserver.observe(slide);
}

function slideFor(id: string): HTMLElement | undefined {
  return slides.find((slide) => slide.id === id);
}

// A stale or malformed deep link must never stop the deck from starting.
function decodeSlideId(raw: string): string | undefined {
  try {
    return decodeURIComponent(raw);
  } catch {
    return undefined;
  }
}

function goTo(id: string): boolean {
  const target = slideFor(id);
  if (!target) return false;
  currentId = id;
  if (reading) {
    root.scrollTo({
      top: root.scrollTop + target.getBoundingClientRect().top - root.getBoundingClientRect().top,
      behavior: 'auto',
    });
    const url = new URL(window.location.href);
    url.hash = `/${target.id}`;
    if (window.location.hash !== url.hash) window.history.pushState(null, '', url);
    syncControls();
  } else {
    const indices = deck.getIndices(target);
    deck.slide(indices.h, indices.v, -1);
  }
  return true;
}

function closeMenu() {
  menu.close();
  menuButton.setAttribute('aria-expanded', 'false');
  chapterButton.setAttribute('aria-expanded', 'false');
}

function toggleReading() {
  const id = currentId;
  reading = !reading;
  const url = new URL(window.location.href);
  url.searchParams.set('mode', reading ? 'read' : 'present');
  window.history.replaceState(null, '', url);
  updateModeControls();
  deck.configure({
    view: reading ? 'scroll' : null,
    width: reading ? Math.min(root.clientWidth, 1440) : Math.max(1200, Math.min(1440, root.clientWidth / root.clientHeight * 810)),
    height: reading ? root.clientHeight : 810,
    fragments: !reading && !reducedMotion.matches && !printMode,
    hash: !reading,
    history: !reading,
  });
  observeReading();
  goTo(id);
  status.textContent = reading ? 'Reading mode. Scroll through the slides.' : 'Presentation mode. Use arrow keys to navigate.';
}

function openNotes() {
  const plugin = deck.getPlugin('notes');
  if ('open' in plugin && typeof plugin.open === 'function') {
    plugin.open();
  } else {
    status.textContent = 'Speaker notes could not open. Use S or allow popups for this site.';
    console.error('Reveal notes plugin is unavailable.');
  }
}

themeButton.addEventListener('click', toggleTheme);
readButton.addEventListener('click', () => { closeMenu(); toggleReading(); root.focus({ preventScroll: true }); });
overviewButton.addEventListener('click', () => { closeMenu(); deck.toggleOverview(); root.focus({ preventScroll: true }); });
notesButton.addEventListener('click', () => { closeMenu(); openNotes(); });
for (const button of [menuButton, chapterButton]) {
  button.addEventListener('click', () => {
    menu.showModal();
    menuButton.setAttribute('aria-expanded', 'true');
    chapterButton.setAttribute('aria-expanded', 'true');
  });
}
menu.addEventListener('close', () => {
  menuButton.setAttribute('aria-expanded', 'false');
  chapterButton.setAttribute('aria-expanded', 'false');
});
menu.addEventListener('click', (event) => {
  const link = (event.target as Element).closest<HTMLAnchorElement>('[data-slide]');
  if (!link?.dataset.slide) return;
  event.preventDefault();
  closeMenu();
  goTo(link.dataset.slide);
  root.focus({ preventScroll: true });
});
root.addEventListener('click', (event) => {
  const link = (event.target as Element).closest<HTMLAnchorElement>('a[href^="#/"]');
  const href = link?.getAttribute('href');
  if (!href) return;
  event.preventDefault();
  const id = decodeSlideId(href.slice(2).split('/')[0]);
  if (id) goTo(id);
  root.focus({ preventScroll: true });
});
previousButton.addEventListener('click', () => {
  if (reading) goTo(slides[Math.max(0, slides.findIndex((slide) => slide.id === currentId) - 1)].id);
  else deck.prev();
});
nextButton.addEventListener('click', () => {
  if (reading) goTo(slides[Math.min(slides.length - 1, slides.findIndex((slide) => slide.id === currentId) + 1)].id);
  else deck.next();
});
document.querySelector('.skip-link')?.addEventListener('click', (event) => {
  event.preventDefault();
  root.focus();
});
darkPreference.addEventListener('change', () => {
  if (!explicitTheme) setTheme(darkPreference.matches ? 'dark' : 'light');
});
reducedMotion.addEventListener('change', () => {
  updateModeControls();
  deck.configure({
    transition: reducedMotion.matches ? 'none' : 'fade',
    fragments: !reading && !reducedMotion.matches && !printMode,
  });
  syncControls();
});
window.addEventListener('resize', () => {
  if (reading) deck.configure({ width: Math.min(root.clientWidth, 1440), height: root.clientHeight });
});
window.addEventListener('hashchange', (event) => {
  if (!window.location.hash.startsWith('#/')) return;
  const [slideId, fragment] = window.location.hash.slice(2).split('/');
  const id = decodeSlideId(slideId);
  // Unknown ids fall through to Reveal's own tolerant handling instead of being swallowed here.
  if (!id || !slideFor(id)) return;
  const directSlideJump = !printMode && fragment === undefined && id !== currentId;
  if (reading || directSlideJump) {
    event.stopImmediatePropagation();
    goTo(id);
  }
}, true);

try {
  updateModeControls();
  await deck.initialize();
  root.removeAttribute('role');
  deck.on('slidechanged', () => syncControls());
  deck.on('fragmentshown', () => syncControls());
  deck.on('fragmenthidden', () => syncControls());
  observeReading();
  const targetId = window.location.hash.startsWith('#/') ? decodeSlideId(window.location.hash.slice(2).split('/')[0]) : undefined;
  if (reading) {
    if (targetId && slideFor(targetId)) goTo(targetId);
    else root.scrollTop = 0;
  }
  deck.addKeyBinding({ keyCode: 84, key: 'T', description: 'Switch theme' }, toggleTheme);
  deck.addKeyBinding({ keyCode: 82, key: 'R', description: 'Switch reading mode' }, toggleReading);
  deck.addKeyBinding({ keyCode: 83, key: 'S', description: 'Open speaker notes' }, openNotes);
  syncControls();
  document.documentElement.dataset.deckReady = 'true';
} catch (error) {
  status.textContent = 'The presentation could not initialize. Reload and try again.';
  console.error('Presentation initialization failed.', error);
  throw error;
}
