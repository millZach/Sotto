# Shortcut popup behaviour polish

2026-11-03. Follow-up to [PR #2061](https://github.com/millZach/Sotto/pull/2061) and ADR-0181. Evidence here is code inspection and unit tests. The app was not launched; no screenshots, visual approval or hardware results are claimed.

## Changes

- Request-card web links, including permission descriptions, message-link rows and Markdown plans, use the popup's existing `openExternalLink` bridge when the main-window bridge is absent. Both bridges reach `EXTERNAL_LINK_OPEN`; main still validates the URL and owns opening it. Main-window links keep their existing path.
- A request's prototype link uses the popup's existing Open path to show its owning thread in Sotto. The user opens the prototype from the same card there. This follows the existing thread navigation rather than admitting the popup to another channel. Link presses never answer a question or permission.
- Hiding or toggling off a popup while its first renderer loads now cancels that pending show. It cannot reappear and take the keyboard after dismissal. A later show during that same load wins once.

## PR #2061 hand-test checklist

Every real-app journey remains unchecked. The table records how far code and tests can establish each one.

| Original journey | Evidence available here | Still needs the running app |
| --- | --- | --- |
| macOS shortcut over another app; keyboard to popup, main stays behind | `popupShortcut.test.ts` invokes the registered callback. New `popupWindow.test.ts` verifies a panel, `showInactive()` before `focus()`, toggle-to-hide, and cancelled shows never focusing. `createPopup` hides without showing main; only Open calls `showMain`. | Actual foreground app, keyboard ownership, Spaces/full-screen behaviour, and focus returning to the preceding app after hiding. |
| Windows shortcut brings popup forward | New window tests verify `show()` then `focus()` on Windows; shortcut callback covered separately. | Windows foreground restrictions and actual global-key delivery. |
| New thread keeps main selection; stream, Escape stop, question answer | `popupThreadSelection.test.ts` starts a thread through the popup client while preserving main's selected thread. Feed and logic tests cover observed messages and streamed deltas. New renderer tests cover normal sends, queued sends, Escape/Stop, and answering only on Send answer. | Real provider streaming, native rendering/scrolling, and the full journey through a real provider request. |
| Switch to Watcher, send, `/open` its room | New renderer test switches target, queues a prompt behind Watcher's running last turn, and sends Open with `watcher: true`. | Actual Watcher/provider execution and main-window room presentation. |
| Settings: record, refuse dictation/taken chords, remove, restore | Existing shortcut-setting, lifecycle and shared-validation tests cover recording, refusal, keeping old keys on failure, remove/reset, suspension and modifier-only dictation holds. | Physical recorder input and contention with another real application's shortcut. |
| Omarchy global shortcut | Registration and failure handling are covered with a fake shortcut registry. | Whether Hyprland delivers the chord to Electron. No conclusion from the registry fake. |

## Focus, running state and design audit

- `src/main/windows/popupWindow.ts`: ordinary hide only hides this window. It does not focus the main window or implement previous-application restoration. Native focus return is unverified. Open intentionally hides the popup before bringing main forward (`src/main/popup/popup.ts`).
- `src/renderer/src/popup/PopupApp.tsx`: showing focuses the prompt. Thread updates do not refocus it; the new renderer test keeps focus on a question choice across an update. Command+O uses the existing Open path.
- Escape, the Stop button, working words, owl and queue decisions already share `isThreadTurnRunning(current)`. Tests cover both `thread.status === 'running'` and an idle thread with `lastTurn.status === 'running'`, and transition back to completed. A question at rest queues a prompt without answering it. Slash-menu Escape has priority. Watcher keeps its existing room-level Stop behaviour.
- The popup entry imports `styles/global.css`, applies the same appearance settings and inherits Figtree. Its stylesheet uses `--tt-font-*`, `--tt-type-*`, `--tt-radius-*` and theme colour roles. Request cards use the main window's component and stylesheet. There is no shared spacing-token scale to substitute for its pixel gaps/padding. No clear token inconsistency was found; CSS and spacing are unchanged. The theme and scale token checks pass. Actual spacing, clipping, contrast, light/dark appearance and reduced-motion presentation were not visually checked in this work.

## Checks

`npm ci --ignore-scripts` installed this thread worktree's dependencies. `npm run typecheck` and `npm run lint` pass.

Each following file was run in its own invocation:

```sh
NODE_OPTIONS=--no-experimental-webstorage npx vitest run <file> --maxWorkers=1
```

The environment option disables this machine's Node experimental Web Storage globals, which otherwise shadow jsdom's localStorage in the test setup. No application or test configuration was changed for it.

| File | Passed |
| --- | ---: |
| `tests/unit/main/popup/popupWindow.test.ts` (new) | 8 |
| `tests/unit/renderer/popup/popupApp.test.tsx` (new) | 13 |
| `tests/unit/renderer/requests/agentRequestCard.test.tsx` | 49 |
| `tests/unit/main/popup/popupThreadSelection.test.ts` | 1 |
| `tests/unit/main/popup/popupFeed.test.ts` | 3 |
| `tests/unit/main/popup/popupShortcut.test.ts` | 8 |
| `tests/unit/renderer/popup/popupLogic.test.ts` | 12 |
| `tests/unit/renderer/features/settings/popupShortcut.test.tsx` | 6 |
| `tests/unit/shared/popup.test.ts` | 4 |
| `tests/unit/renderer/themeTokens.test.ts` | 113 |
| `tests/unit/renderer/scaleTokens.test.ts` | 4 |
| Total | 221 |

No full suite, Playwright, build, design capture/verification, or app launch ran. No baselines changed. The fallback to the owning thread and leaving native focus restoration to the existing window path are the assumptions used for this scoped polish.
