# Next prompts in the quiet composer

## Result

The ghost, Tab acceptance and Up list work in both source versions tested. The
Watcher generation failure is on main: `9172a9ba5766c809cf63e94852f16b0e85a6d860`
added Watcher next prompts without changing the provider adapters' blanket refusal
to write side text for Watcher. Codex, Claude and Grok already had those guards
from `7d94c7d6ffbef331cf538e37512b8c1b29db0834`; Cursor has the same refusal.
A verified Watcher profile therefore returned `null` before a next-prompt call
could reach the provider. This predates the quiet composer and the speed branch.

There is no reproduced ordinary Threads rendering failure. This investigation
does not prove that every live thread generates a suggestion: a failed side
call, unreadable response or ineligible turn can still leave none.

## Headless comparison

No Electron app, existing app window, provider process or full CI gate was
started. A temporary Vite harness mounted the real `ThreadComposer`, with the
app's `global.css`, `threads.css`, `threadChips.css`, `quietComposer.css`,
`nextPrompt.css` and `watcher.css` (and the components' imported styles). React
and Lingui used the repository's installed dependencies. Chromium ran headless.

Sources:

- Main: `fd5267ccadac07b54e0ccb79b9d93fb1ab74c53e`, before this fix.
- Installed Owl .6 speed source: `2ef654cd231b27ebe23b7d4f26cf07ac3087c640`,
  extracted with `git archive` into a temporary directory. The remote did not
  advertise `origin/feat/agent-speed` at the time of the check, so the reported
  installed commit was used. No other thread's worktree was touched.
- The later local `feat/agent-speed` tip `a0b25fa16` changes only an effort-dot
  tooltip among the composer/key files examined; it adds no Tab handler.

The fixture started with `threadsStateFixture`, an idle project thread, an
empty draft, `configureThread: true`, a ready model offering three effort levels
and Fast, and the quiet-composer and next-prompt switches on. A second case
changed the same thread to `kind: 'watcher'` and passed `watcher` to the composer.
`nextPromptStore.apply` supplied a suggestion anchored to that thread's latest
user message, with ghost text “Open the pull request for this fix”. This checks
rendering and keys separately from provider generation.

| Source | Surface | Composer | Ghost | Tab inserts and retains prompt focus | Up opens, Down navigates, Escape closes |
| --- | --- | --- | --- | --- | --- |
| main | Thread | Quiet pill | Yes | Yes | Yes |
| main | Watcher | Full (main excludes Watcher from quiet) | Yes | Yes | Yes |
| Owl .6 speed | Thread | Quiet pill | Yes | Yes | Yes |
| Owl .6 speed | Watcher | Quiet pill | Yes | Yes | Yes |

The ghost remained present at 1600×1000, 1280×800 and 820×560 in dark mode,
and at 820×560 and 390×844 in light mode, with reduced motion requested. None
of these fixture pages overflowed horizontally. On a running thread the ghost
was absent; Tab from the effort control reached Stop on every pill case. The
speed branch's Alt-Up/Down handler belongs to the focused effort slider, not
the editor. Its Stop button is a sibling. Neither intercepts the editor's Tab.

Captures, visually inspected at 1280×800 and cropped to the real composer:

- [Main thread](../../artifacts/next-prompt-quiet-composer/main-thread.png)
- [Main Watcher](../../artifacts/next-prompt-quiet-composer/main-watcher.png)
- [Owl .6 speed thread](../../artifacts/next-prompt-quiet-composer/speed-thread.png)
- [Owl .6 speed Watcher](../../artifacts/next-prompt-quiet-composer/speed-watcher.png)
- [Machine-readable checks](../../artifacts/next-prompt-quiet-composer/checks.json)

## Source trace and repair

`ThreadComposer` reads `useNextPrompt` and passes the eligible suggestion and
`nextKey` to the shared editor for both layouts. `PromptEditor` draws the ghost
as a ProseMirror decoration, outside the draft. The editor's capture handler
offers keys to the skills/files menus before `nextKey`. No layout-specific
next-prompt fetch exists: main's `NextPrompts` service publishes to the shared
renderer store. Watcher is scheduled after direct user turns, not news wake-ups,
and its history and handover composers remain excluded.

The repair carries `ShortTextRequest.purpose` into the internal `ShortTextPrompt`.
After their existing profile validation, Codex, Claude, Grok and Cursor permit
only `next-prompt` for Watcher. The metadata never enters the model prompt.
Other Watcher side writing stays refused. Cursor now uses its validating profile
helper instead of swallowing lookup failures; failed, invalid or revoked
profiles cannot enter the ordinary-thread path. ADR-0132 and ADR-0128 describe
this existing next-prompt exception explicitly.

## Targeted validation

- `npm run typecheck`: passed.
- `npm run lint`: passed.
- `NODE_OPTIONS=--no-webstorage node node_modules/vitest/vitest.mjs run tests/unit/renderer/composerNextPrompt.test.tsx`: 14 passed.
- Same command for `tests/unit/renderer/watcherNextPrompt.test.tsx`: 3 passed.
- Same command for `tests/unit/main/shortTextWriter.test.ts`: 39 passed.

Node 25's native web storage initially made the renderer test cleanup fail at
`localStorage.clear`; disabling that Node feature for Vitest's workers lets
jsdom supply storage. No test expectation or app code changed for that.
Full suites and the remaining CI gates were left to GitHub as requested; the app was not launched.
