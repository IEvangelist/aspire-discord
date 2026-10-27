# Deck design

This is a first-person talk about how one Discord assistant, Aspirey Bot, was built: what it does, how it evolved, and where it stands today. It is 30 minutes, presented remotely, and published as a public site. The visual identity is the official Aspire one: self-hosted Poppins, `#7455dd`/`#512bd4` purple, `#1f1e33` dark, light and dark themes that follow the system and the `T` key.

## Story

The through-line is **where does the truth live?** The bot learned new places to look (docs, the API surface, issue threads, the conversation, then action), and every new source needed a boundary. Aspire, the GitHub Copilot SDK, and Azure OpenAI appear where they solved a real problem, not as a component tour. The verdict is **Aspire could handle it**, including a TypeScript rewrite done to find out.

| Part | Minutes | Slides |
| --- | --- | --- |
| Open | 0:00 to 0:01 | Title |
| What it does | 0:01 to 0:08 | Four things it does, four staged chat scenes, the rules it never breaks |
| How it evolved | 0:08 to 0:23 | A timeline, then six dated chapters: what broke, what I changed, what I kept |
| Where it stands | 0:23 to 0:30 | The architecture on one page, four lessons, the verdict |

Each chapter slide opens with a dated kicker such as `Aug 20 · Chapter 2 · It finds more truth`. Chapters appear in chronological order, and `tests/story.spec.ts` enforces that. The dates come from the real commit history.

Speaker notes begin with an `H:MM-H:MM.` range, the ranges are contiguous, and they end at `0:30`. Appendix slides are untimed and exist for questions.

## Remote-first rules

- **Nothing smaller than 20px** on a slide (code line numbers excepted), measured by `tests/story.spec.ts` in the rendered deck, including text inside diagrams. Captions are 22 to 24px, body copy 26 to 30px.
- **No slide is only a heading.** Every slide has a diagram, code, a scene, a table, or supporting text.
- **High contrast, little motion.** Fades are short, fragments reveal one idea at a time, and `prefers-reduced-motion` shows everything immediately.
- **Staged scenes only.** Every chat is written for the slide and labeled `Staged example`. The asker uses the presenter's own first name; every other name is made up. No real chats, third parties, user counts, or identifiers appear anywhere, including speaker notes.

## Slide forms

- **Ladder**: four steps with rising stakes (opening framing).
- **Scene**: a chat panel plus three numbered callouts. The bot's reply and the callouts appear on the first Next press. Each scene doubles as the fallback for a live demo.
- **Timeline** and **cards** for overviews, **strip** for small flows, **duo** for before and after.
- **Code panels** show real source excerpts of 13 lines or fewer, with stepwise focus by excerpt part (`data-parts`), never by line number.
- **Diagrams** are data in `src/diagrams.ts`: nodes, straight or elbow edges, reveal steps. Hub nodes are filled, gate nodes are outlined, telemetry and context edges are dashed, failure edges are thick. Narrow screens get a connected list instead of a shrunken graph.
- `data-purpose="why"` marks the slide that frames a chapter; the menu links to it.

## Real code, not copied code

Excerpts come from `excerpts.json` and are injected into the HTML at build time by `plugins/excerpts.ts`. Anchors match source text, so ordinary edits do not break them. If an anchor disappears or an excerpt grows too large, the build fails. CI rebuilds and republishes the deck on every push to `main`, so the deck follows the code.

## Modes and accessibility

Keyboard navigation, stable slide ids and deep links, overview, speaker notes, reading mode for phones, print, light and dark themes, and reduced motion are supported. Reading, print, and reduced-motion modes show every diagram stage, scene reply, and code step immediately. Interactive targets are at least 44px and the Playwright suite runs axe on every slide in light, dark, and mobile.

## Public safety

The Pages site is public although the repository is private. The deck contains no identifiers, resource names, endpoints, tokens, or links to the private repository, and its speaker notes are public-safe. `scripts/scan-public-output.mjs` enforces this on sources and on the built output in CI.

## Imagery

The portrait is the presenter's public profile image. Brand marks and icon families are unmodified; provenance and licenses are in `docs/deck/ASSETS.md` and `public/licenses/`.
