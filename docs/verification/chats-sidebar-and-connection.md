# Chats sidebar width and staying connected — 2026-09-23

Zach reported two things on the Chats page: the chat list widened every time a title was regenerated and could not be resized, and the Codex and Claude connections behind Chats kept needing Connect pressed again.

## Causes

The chat list stood in the page grid's `auto` column with no width of its own, and titles do not wrap, so the column took the width of the longest title. Nothing about it was adjustable.

The Chats providers run apart from Threads (ADR-0010) and nothing connected them at launch: every restart left them disconnected until Connect was pressed. A provider that stopped mid-session stayed down, where Threads retries. Connect reached only the selected chat's provider. Sotto keeps no logs, so how often a provider stopped mid-session could not be counted; the launch gap alone reproduces the screenshot Zach sent.

## What changed

- The chat list has its own remembered width (`sotto.chats.sidebar`, apart from the Threads sidebar), a resize handle on its right edge with the same keyboard path as Threads, and Collapse sidebar. Collapsed, each chat is its provider's mark in a tile, with a ring when it is replying or needs an answer. Zach chose the provider tiles from three variants in `docs/prototypes/chats-sidebar-rail-prototype.html`.
- Chats connect at launch to every provider with a saved chat, plus the coordinator's provider. A drop, or a failed automatic connect, is retried after 5, 15, 45, 120 and 300 seconds, then the error waits for Connect. Disconnect holds that off until Connect or a restart. ADR-0010 carries the amendment.
- The chat header stops short of the window's controls, which covered Disconnect.

## Evidence

In the built app with the E2E provider fixtures, a Codex chat with a long title and a Claude chat:

- `artifacts/chats-sidebar-rail/expanded-820.png`: at the 820x560 minimum the long title ends in an ellipsis and the header's actions clear the window controls.
- `artifacts/chats-sidebar-rail/collapsed-1280-dark.png` and `collapsed-820-light.png`: the collapsed rail with one provider tile per chat, the current chat marked, in both appearances. Focus moved to Expand sidebar on collapse, and nothing scrolled sideways at either size.

`tests/e2e/phase-three-ui.spec.ts` restarts the app after Disconnect and now finds the chat sendable with no Connect press. That journey passed end to end once the spec's older 11.5px label check (it fails on `main` too) was relaxed for the run.

Tests: `tests/unit/renderer/personalChatsView.test.tsx` covers the width, keyboard resize, separate storage, collapse, the rail and focus; `tests/integration/personalChatReconnect.test.ts` covers launch connect, the retry waits, running out of waits, a client that exits as it starts, Disconnect and close.

## Limits

Not checked on macOS. When one Claude chat's process ends, the Claude adapter marks every Claude chat disconnected (`claude.ts`, shared with Threads); the retry covers the symptom and the adapter is unchanged. Five Playwright journeys fail the same way on `main` and on this branch: in `phase-three-ui.spec.ts` the project-review journey and the 11.5px usage label; in `request-draft-recovery.spec.ts` the thread question-closed journey; in `request-draft-restart.spec.ts` the thread structured-text journey and legacy option choices.
