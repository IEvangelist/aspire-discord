import { chromium } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const deck = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const publicRoot = join(deck, 'public');
const socialRoot = join(publicRoot, 'social');
const image = async (path, type) =>
  `data:${type};base64,${(await readFile(join(publicRoot, path))).toString('base64')}`;
const font = async (path) =>
  `data:font/woff2;base64,${(await readFile(join(deck, 'node_modules', path))).toString('base64')}`;

const [portrait, logo, github, poppins, poppinsBold, fira] = await Promise.all([
  image('speaker/david-pine.webp', 'image/webp'),
  image('brand/aspire-icon-256.svg', 'image/svg+xml'),
  image('github/invertocat-white.svg', 'image/svg+xml'),
  font('@fontsource/poppins/files/poppins-latin-400-normal.woff2'),
  font('@fontsource/poppins/files/poppins-latin-700-normal.woff2'),
  font('@fontsource/fira-code/files/fira-code-latin-400-normal.woff2'),
]);

const browser = await chromium.launch();
try {
  await mkdir(socialRoot, { recursive: true });
  for (const [file, width, height] of [
    ['aspirey-bot-og.png', 1200, 630],
    ['aspirey-bot-social.png', 1280, 640],
  ]) {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    await page.setContent(`<!doctype html>
      <html lang="en"><head><meta charset="utf-8"><style>
        @font-face { font-family: Poppins; src: url("${poppins}"); font-weight: 400; }
        @font-face { font-family: Poppins; src: url("${poppinsBold}"); font-weight: 700; }
        @font-face { font-family: Fira; src: url("${fira}"); font-weight: 400; }
        * { box-sizing: border-box; }
        html, body { width: 100%; height: 100%; margin: 0; }
        body { display: grid; grid-template-columns: 35% 65%; color: #f7f5ff; background: #151423; font-family: Poppins, sans-serif; }
        .author { border-right: 1px solid #474252; background: linear-gradient(160deg, #201d34, #191726); padding: 48px 45px 28px 54px; }
        .brand { display: flex; align-items: center; gap: 12px; height: 44px; font-size: 34px; font-weight: 700; }
        .brand img { width: 42px; height: 42px; }
        .portrait { display: block; width: 300px; height: 300px; margin-top: 40px; border-radius: 12px; object-fit: cover; }
        .author h2 { font-size: 30px; line-height: 1.2; margin: 16px 0 0; font-weight: 700; }
        .author p { margin: 2px 0 0; font-size: 19px; color: #c5c0d5; }
        .story { padding: 54px 58px 32px 50px; display: flex; flex-direction: column; min-width: 0; }
        .repo { display: flex; align-items: center; justify-content: flex-end; gap: 12px; font: 16px Fira, monospace; color: #c5c0d5; }
        .repo img { width: 25px; height: 25px; }
        h1 { margin: auto 0 0; font-size: 72px; line-height: 1.12; letter-spacing: -0.035em; font-weight: 700; }
        h1 strong { display: block; color: #ad92ff; font-weight: 700; }
        .subtitle { margin: 18px 0 0; font-size: 27px; line-height: 1.32; max-width: 610px; }
        .topics { display: flex; align-items: center; gap: 17px; margin: 32px 0 auto; font-size: 18px; white-space: nowrap; }
        .topics span:nth-of-type(1) { color: #ad92ff; }
        .topics span:nth-of-type(2) { color: #6bd3ff; }
        .topics span:nth-of-type(3) { color: #3ddbc0; }
        .topics b { height: 23px; width: 1px; background: #474252; }
        .footer { position: absolute; bottom: 24px; left: 54px; right: 52px; border-top: 1px solid #474252; padding-top: 15px; display: flex; justify-content: space-between; font-size: 16px; }
        .footer span:last-child { color: #c5c0d5; }
      </style></head>
      <body><aside class="author">
        <div class="brand"><img src="${logo}" alt="">Aspire</div>
        <img class="portrait" src="${portrait}" alt="">
        <h2>David Pine</h2><p>Aspire team</p>
      </aside><main class="story">
        <div class="repo"><img src="${github}" alt=""> IEvangelist/aspire-discord</div>
        <h1>Building <strong>Aspirey Bot</strong></h1>
        <p class="subtitle">How I built a grounded Discord assistant</p>
        <div class="topics"><span>Aspire</span><b></b><span>Copilot SDK</span><b></b><span>Azure OpenAI</span></div>
      </main><div class="footer"><span>davidpine.dev</span><span>Talk and architecture deck</span></div>
      </body></html>`);
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: join(socialRoot, file) });
    await page.close();
    console.log(`Rendered ${file} (${width}x${height}).`);
  }
} finally {
  await browser.close();
}
