# Building Aspirey Bot: the talk deck

This reveal.js deck is a 30-minute, first-person talk about how Aspirey Bot was built (what it does, how it evolved, and where it stands today) on Aspire, the GitHub Copilot SDK, and Azure OpenAI. It publishes as a public-safe slide site at `https://ievangelist.github.io/aspire-discord/`. [DESIGN.md](../../deck/DESIGN.md) explains the story, pacing, and the rules the tests enforce.

## Local development

Run from the repository root:

```powershell
npm ci --prefix deck --registry=https://registry.npmjs.org --no-fund --no-audit
npm run dev --prefix deck
npm run build --prefix deck
npm test --prefix deck
npm run preview --prefix deck
```

`DECK_OUT_DIR` overrides the build folder (default `deck/dist`). `DECK_PORT` overrides the preview/test port (default `4173`). Example:

```powershell
$env:DECK_OUT_DIR = 'dist/_local'
$env:DECK_PORT = '4182'
npm run build --prefix deck
npm run preview --prefix deck
```

If Playwright cannot find Chromium, install the pinned browser without changing dependencies:

```powershell
node deck/node_modules/playwright/cli.js install chromium
```

## Presenting the deck

- Arrow keys move between slides and fragments. On a chat scene, the first Next press reveals the bot's reply and the callouts.
- `Esc` toggles overview.
- `R` toggles reading mode.
- `T` switches theme.
- `S` opens speaker notes in a separate window.
- Append `?print-pdf` to the deck URL, then print from the browser to export a PDF backup.

### Presenting remotely

- Share the browser window, not the whole screen. Press `S` and keep the speaker-notes window on your own screen.
- Use full-screen (`F11`) before you start sharing so the browser chrome does not eat the canvas. The deck scales to any window; 1920×1080 gives the largest text.
- Pick the theme that suits your video call (`?theme=dark` or `?theme=light`). Share the URL with attendees; on a phone it opens in reading mode.
- Keep the PDF backup open in another tab in case the network or the live site misbehaves.

### Timing

The notes carry an `H:MM-H:MM.` range for every slide and end at 0:30. If you run long, compress the deploy pipeline slide to one sentence and skip the lessons discussion. The appendix is untimed and holds the diagrams and code for follow-up questions.

### Live demo (optional)

Each of the four scene slides doubles as the fallback for a live demo, so the talk works with or without Discord. To demo live, switch to Discord when you reach a scene, then return to the slide. Suggested prompts:

1. Ask: "How do I make my API wait for the database?"
2. GitHub: "What has `<your GitHub username>` worked on in the Aspire repos over the last two weeks?"
3. Context: reply to any message that has a screenshot with `@Aspirey Bot what is going on here?`
4. Action: reply to a thread with `@Aspirey Bot turn this into an issue`, then click **Cancel**. Never click **Create issue** during a demo. The bot confirms that nothing was published.

Before you start: confirm the bot is online, you are on the allow-list, and you know which test channel you will use. Chat content from a live demo is not part of the deck, so nothing from Discord ever lands on the public site.

## Excerpts, slides, and diagrams

`deck/excerpts.json` is the manifest for repository-backed code excerpts. Each entry names a source `file` plus stable `from`/`to` anchors. Real excerpt slides should bind a panel to a manifest entry with `data-excerpt-id` so the injected source range and the slide stay in sync.

When you add a slide:

1. Add the slide markup in `deck/index.html`. Give it a kebab-case `id` and a `data-chapter`; start the speaker notes with a contiguous `H:MM-H:MM.` range (appendix slides are untimed and use no range).
2. Add or reuse styles/behavior in `deck/src/**`. Keep every text element at 20px or larger.
3. For a code excerpt, add a manifest entry in `deck/excerpts.json`, point the slide at its `data-excerpt-id`, and keep the anchor lines exact.
4. For a chat scene, write the content yourself (the asker is `david`, the presenter's own first name; any other name must be made up), add `Staged` to the panel label, and keep exactly three callouts.
5. For a diagram or screenshot, keep the asset self-hosted under `deck/public/**` and update [ASSETS.md](ASSETS.md) and [NOTICE.md](NOTICE.md) if provenance changes.

Drift is intentional failure: if a source file moves past its `from`/`to` anchors, the excerpt step or its tests should fail so the published deck never shows invented code.

## Public-safety scan

`deck/scripts/scan-public-output.mjs` blocks content that should never ship in the public deck. It scans the built output and, with `--sources`, scans `deck/index.html`, `deck/src/**`, `deck/excerpts.json`, and text assets under `deck/public/**`.

Blocked shapes:

- GUIDs in low-risk text formats only.
- Discord snowflakes in HTML, JSON, TXT, and Markdown.
- Private Azure or app hostnames such as `*.openai.azure.com`, `*.vault.azure.net`, `*.azurecr.io`, `*.applicationinsights.azure.com`, and related service domains.
- Resource-name fragments: `ffccd7`, `aspire-discord-prod`, `aspire-discord-blue`, `aspire-discord-green`, `aspire-issues`, and `aspirediscord` plus hex.
- GitHub token prefixes, PATs, AWS access-key IDs, JWTs, PEM headers, Discord bot token shapes, and exact `password`/`secret`/`token`/`apiKey` style string assignments.
- Specific numeric IDs `4968096` and `163850423`.
- Any link to `github.com/IEvangelist/aspire-discord`.

Approved public links are limited to the published Pages URL, the `/aspire-discord/` base path, `github.com/IEvangelist`, `github.com/IEvangelist/inside-aspire`, `github.com/github/copilot-sdk`, and the existing social profile links already used in the deck.

Manual runs:

```powershell
node deck/scripts/scan-public-output.mjs
node deck/scripts/scan-public-output.mjs --sources
```

## Publishing and unpublishing

`.github/workflows/deck.yml` owns validation and GitHub Pages publishing.

- Pull requests run the deck build, Playwright tests, and public-safety scans when deck files, `docs/deck/**`, the workflow, or any excerpt source file changes.
- Pushes to `main` always run, even without a path filter, so excerpt refreshes are never skipped.
- `workflow_dispatch` is available for manual reruns.
- Only `main` uploads `deck/dist` and deploys to the public Pages site.

One-time Pages setup commands are documented here only. Do not put them in CI:

```powershell
gh api -X POST repos/IEvangelist/aspire-discord/pages -f build_type=workflow
```

If Pages already exists, update it instead:

```powershell
gh api -X PUT repos/IEvangelist/aspire-discord/pages -f build_type=workflow
```

To unpublish the site:

```powershell
gh api -X DELETE repos/IEvangelist/aspire-discord/pages
```

The Pages site is public even though the repository is private, so treat every deck asset, excerpt, and note as public release material.

## Troubleshooting

- If `npm test --prefix deck` fails before the browser launches, confirm the build exists and that `DECK_OUT_DIR` matches the preview output folder.
- If a public-safety scan fails, remove the sensitive value; the scanner reports only rule, file, and line so CI logs do not leak the match.
- If a PR changes a new excerpt source file, add that path to `.github/workflows/deck.yml` so the PR trigger stays aligned with `deck/excerpts.json`.
- If the Pages deployment succeeds but the site is stale, rerun the workflow on `main` and confirm the artifact path stayed `deck/dist`.
