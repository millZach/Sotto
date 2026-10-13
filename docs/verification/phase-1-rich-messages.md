# Phase 1 #46 rich messages and attachment presentation — verification

Lane: rich (Opus 5 UI worker). Branch `work/phase1-rich-messages`, baseline `0598d48` plus cherry-picked parent `fe6fa14` (here `8d92818`, openExternalLink IPC). This record covers the components, their styles, dependencies and notices. Wiring them into the Threads page (ThreadsView/ThreadTranscript, scroll, paging, jump-to-latest) belongs to the workspace lane and the parent integration run.

## What shipped

- `src/renderer/src/agents/MessageContent.tsx`
  - `MessageContent({ text, streaming?, onOpenLink? })` renders one message body as safe Markdown. It is memoised and renders `div.rich-message`.
  - `AttachmentPreviews({ attachments, notice? })` renders submitted attachments as bounded image previews or metadata tiles, with an optional provider-limit note. It returns nothing for an empty list.
  - `MessageAttachment` accepts `AgentAttachmentReference` as-is and also a pending `{ id, name }`.
- `src/renderer/src/agents/rich-messages.css`, imported by the component. All classes are prefixed `rich-`, and colours come from `--tt-*` tokens through local `--rich-*` properties. The appearance lane's `--tt-code-bg`, `--tt-code-border`, `--tt-code-text`, `--tt-link` and `--tt-table-stripe` are used with fallbacks to tokens that already exist, so the file renders the same before and after the appearance merge.
- Dependencies are pinned as exact devDependencies and bundled into the renderer like react and lucide: `react-markdown` 10.1.0, `remark-gfm` 4.0.1 and `lowlight` 3.3.0 (highlight.js 11.11.2). The lock change is additive: 96 packages added, none removed or changed. Production dependencies are still `zod` only.
- Notices:
  - `scripts/verify-notices.mjs` inventories all 72 bundled Markdown and highlighting packages with version and license checked against package.json and the lock file.
  - `scripts/generate-notices.mjs` now emits the "Markdown rendering MIT licenses", "Markdown rendering ISC license", "highlight.js BSD 3-Clause license" and "T3 Code MIT license" sections, so a regenerate keeps them.
  - The T3 entry covers the provider icon paths the workspace lane adapted from T3 Code `apps/web/src/components/Icons.tsx` at `d1d15c67` (MIT, T3 Tools Inc.).
  - Regenerating from the scripts reproduces `THIRD_PARTY_NOTICES.md` byte for byte.

## Safety guarantees

| Risk | Behaviour | Evidence |
|---|---|---|
| Raw HTML in agent or user text | No `rehype-raw`; HTML is shown as literal text and is never parsed into elements. No `dangerouslySetInnerHTML` anywhere, highlighting included. | unit "raw HTML stays literal"; E2E asserts the `<img onerror>` string is visible text and the page has exactly one `<img>` (the trusted preview) |
| Unsafe link schemes | Only absolute `http:`, `https:` and `mailto:` become anchors, checked against the shared `externalLinkSchema` on both the raw and the normalised URL. `javascript:`, `data:`, `file:`, `vbscript:`, relative, backslash-trick and malformed URLs render as inert text. | unit "unsafe links become inert"; every streaming prefix of a hostile document is checked for inert output |
| Navigation or popups from links | Click, Enter and middle-click are always `preventDefault`ed. The vetted URL goes to `onOpenLink` or, by default, `window.sotto.openExternalLink`. A failed or missing bridge shows "Could not open <host>." with a separate Copy link button. Nothing is copied by default. | unit bridge, failure and no-bridge cases; E2E records zero navigations and popups, two bridge opens, and the clipboard holding the exact URL after Copy link |
| Remote tracking images | Markdown images are never loaded. They render as a labelled chip ("Image not loaded: alt", "not loaded from host"). | unit and E2E |
| Untrusted preview data | `preview.dataUrl` is revalidated in the renderer with `agentAttachmentPreviewSchema` (raster signature check) before use as `img src`, with a bounded cache of 48 entries. Anything else, or an image that fails to decode, falls back to metadata. Names are stripped of bidi control characters. No path, URL or name is fetched. | unit preview, unsafe, evicted, onError and bidi cases |
| Oversized or unknown code | Only declared, registered fence languages are highlighted, with no auto-detection. Blocks over 20 000 characters render plain. | unit |

## Behaviour

- Streaming:
  - Rendering reads `useDeferredValue(text)`, so fast deltas do not block typing.
  - Unfinished fences render as code and unfinished links stay unlinked.
  - `streaming` sets `aria-busy` and a caret on the last paragraph or list item.
  - Copy state survives continued streaming.
- Code:
  - The bar shows the language label and a 32 px icon button labelled "Copy {lang} code".
  - Copying swaps the icon to a check and announces "Copied" or "Copy failed" in a `role=status` element for 1.6 s.
  - The `<pre>` is focusable so keyboard users can scroll long lines.
- Tables sit in a focusable `role=region` labelled "Table" that scrolls horizontally inside itself. Cells wrap at 42ch.
- Stable layout: code uses `white-space: pre` with internal horizontal scroll, image frames reserve 208×140, and the transcript never scrolls sideways.
- Reduced motion: the caret animation and copy confirmation stop under both `prefers-reduced-motion: reduce` and Sotto's own `:root[data-reduced-motion='on']`.

## Checks run

| Check | Result |
|---|---|
| `npx vitest run tests/unit/renderer/messageContent.test.tsx --maxWorkers=2` | 19 passed |
| `npx vitest run tests/unit/release/notices.test.ts` | passed |
| `npx playwright test tests/e2e/rich-messages.spec.ts --workers=1` (real Electron, standalone fixture) | 5 passed |
| `npm run typecheck` | clean |
| `npx eslint` on all new and changed files | clean |
| `node scripts/verify-notices.mjs` | 118 components verified |
| `node scripts/generate-notices.mjs`, then diff | identical apart from the new T3 entry |
| Fixture bundle inventory (`test-results/rich-messages-fixture`) | no uninventoried packages |

The full suite was not run in this lane; the parent runs broad tests after integration.

## Rendered evidence (`artifacts/rich-messages/`)

The fixture (`tests/fixtures/richMessages/`) renders the real Threads layout classes with the app's CSP in a sandboxed, context-isolated Electron window. A temporary profile is removed on quit, and the fixture preload records link opens. It never touches the user's running app or makes provider calls.

- `desktop-1080-top.png`: user message with an image preview, evicted and PDF metadata tiles and a provider note, followed by the start of the Codex answer.
- `desktop-1080-table-code.png`: nested lists, link, wide table, highlighted TypeScript, quote, tasks, literal raw HTML and the blocked tracking image.
- `focus-copy-code.png`: keyboard focus ring on the copy button with the "Copied" status.
- `minimum-760-top.png`, `minimum-760-table-code.png`: 760 px window, with the table and code scrolling inside themselves and the table scrolled by arrow keys.
- `scale-150-streaming-reduced-motion.png`: 150% device scale, streaming caret held still under reduced motion.

## Tastify review (Windows Electron desktop, minimum width 760, keyboard, scale, reduced motion)

- Type (per the parent's review, using the skill's thresholds):
  - Message body 16px, line-height 1.65; table cells 16px; headings 21/18/16px.
  - Meaningful controls and messages 14px: code, inline code, copy status, link failure line, Copy link button, attachment names, provider note.
  - Secondary metadata 12px: code language label, attachment type and size, blocked-image host.
  - The Bricolage and mono families are unchanged. The surrounding Threads chrome (headers, timestamps, nav) is workspace-owned and was not changed here.
- Targets: copy button 32×32 px and Copy link at least 32 px tall, both with visible 3 px focus rings. The copy button is icon-only, carries an explicit aria-label, and shows a text status after activation.
- Minimum width: at 760 px the user bubble, tiles and note reflow. Tables and code scroll internally, and the transcript has no horizontal overflow (asserted).
- Scale: at 150% nothing clips and there is no horizontal overflow (asserted).
- Reduced motion: caret animation is `none` under both the OS setting and Sotto's setting (asserted).
- Signature motion is limited to the streaming caret and the copy confirmation.
- Defects found and fixed during review:
  - Metadata tiles stretched to the image tile's height; the list is now `align-items: flex-start`, and the E2E asserts it.
  - The provider note inherited `.thread-message p` sizing; its selector now wins, and the E2E asserts its size.

## Material gaps

- Not yet wired into the Threads page. The workspace lane swaps `MessageContent` and `AttachmentPreviews` into `ThreadTranscript.tsx`, and jump-to-latest and scroll anchoring stay there. Until then the production renderer bundle does not include the Markdown packages. After integration the parent can add `react-markdown` to the required bundle evidence in `verify-notices.mjs`.
- Light theme and accent colours depend on the appearance lane's tokens. This lane rendered only the dark theme; the parent's integrated E2E covers light, dark and minimum.
- No enlarge or lightbox for image previews. The tile shows a bounded preview only.
- The fixture has no AppShell strip, so the screenshots show the Threads column layout without the app frame.
- Links stay active while a message streams. Activation always goes through the vetted bridge, but a link can still change under the pointer as text arrives.
