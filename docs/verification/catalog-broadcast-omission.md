# Model catalog omitted from a repeat broadcast

Issue #286, continuing `docs/verification/composer-typing-lag.md`. That change made the selected host's
catalog cross once instead of twice; this one stops sending it at all once a window already has it.

## What was measured

`AgentStateBroadcaster` (`src/main/agents/agentStateBroadcast.ts`) was fed the owner's real catalog —
608 models, read from `%APPDATA%\sotto\workspace.json` (`snapshot.models`), counts and byte sizes only,
never its contents — and its output serialised with `node:v8`'s `serialize`, which approximates what
Electron's structured clone puts on the wire:

| | before (`AgentState` sent whole) | after |
| --- | ---: | ---: |
| first publish (catalog present) | 649 KB | 649 KB + 37 bytes |
| unchanged repeat | 649 KB | 1.1 KB |

An unchanged repeat is 99.8% smaller. The first publish after a real change is unaffected. Detecting
"unchanged" with `isDeepStrictEqual` against the previous publish's catalog, for both the main window and
the widget, cost about 0.5 ms on the same 608-model catalog (`node:perf_hooks`, 50 runs) — paid once per
coalesced publish in main, not on the window's own thread, and not on every keystroke.

This part is unchanged by the review fix below: it measures what main encodes, not where a window puts the
catalog back together. That side was not separately measured before or after moving it — see "What was not
measured here".

### Where reassembly lives

The first version of this change put reassembly in the preload, ahead of `AgentContext` and the widget.
Review found that wrong: `contextBridge` clones every argument a main-world listener is called with on the
way back across the isolated-world boundary (confirmed against `contextIsolation: true` for both windows
in `src/main/windows/windowManager.ts`, and against `src/preload/hostClientBridge.ts`'s own listener-argument
wrapping, which calls the real, page-supplied listener through exactly that boundary). Putting the catalog
back on the preload side would have cloned the whole thing a second time crossing back to the page — most
of what omitting it was for. Reassembly now lives in the page: `wrapAgentBridge`
(`src/renderer/src/agents/agentStateCatalogs.ts`) wraps `window.sotto.agents` and `window.sottoWidget.agents`
where `AgentContext` and the widget obtain them, and the preload forwards the broadcast unparsed. Only the
small `{ revision, omitted: true }` marker crosses `contextBridge` when nothing changed.

A broadcast that arrives while a recovery (`bridge.get()`) is in flight is kept, the newest replacing
any earlier one. Main answers the fetch in order with its broadcasts, so a kept broadcast is older than
the answer: after a successful recovery it is not delivered, and only lends the cache a catalog it carried
in full. After a failed recovery it gets its own attempt. Nothing but a broadcast ever starts a recovery,
so a persistently failing fetch is retried at most once per broadcast.

`host.models` and the selected host's own `clientHosts[]` entry are keyed apart in both the broadcaster and
the page's cache — a `host:`/`client:` prefix rather than the host ID alone — so a future divergence
between them (they are the same array today, by construction) cannot flip both catalogs between full and
omitted on every publish.

`tests/unit/main/agentStateBroadcast.test.ts` and `tests/unit/renderer/agentStateCatalogs.test.ts` cover the
omission, the recovery when a window is missing the revision a broadcast names (including a broadcast kept
during recovery, never delivered after a successful fetch and retried after a failed one), and both `host.models` and
`host.clientHosts[].models` apart from each other. `tests/unit/preload/agentStateForwarding.test.ts` covers
the preload forwarding a broadcast unparsed.

## What was not measured here

The owner's installed app was not run for this change; `docs/verification/composer-typing-lag.md`'s
DevTools measurement of real per-keystroke latency has not been repeated with a live 608-model catalog and
a working thread. The byte and timing figures above stand in for that until it is.

## Build and test gates

`npm run typecheck`, `npm run lint`, and the unit suites under `tests/unit/main`, `tests/unit/preload`,
`tests/unit/renderer` and `tests/integration/ipc.test.ts` pass (3,794 passed, 1 skipped, across 285 files).
`npm run build` succeeds.

The combined branch was run against `main` (3ef46ad3, release 0.1.16) on the same specs, one at a time;
nine cases fail on both (`agents.spec.ts:19` and `:160`, `composer-short-window.spec.ts:79` and `:152`,
`effort-picker.spec.ts:43` and `:224`, `queued-steering.spec.ts:4`, `request-draft-recovery.spec.ts:123`
thread variant, `thread-creation.spec.ts:6`), and `agents.spec.ts:81` failed once and passed in five later
runs.

For this review fix, `npx playwright test tests/e2e/agents.spec.ts tests/e2e/agentVoice.spec.ts
tests/e2e/new-thread-settings.spec.ts tests/e2e/hosts.spec.ts tests/e2e/thread-activity.spec.ts
--workers=1` was run once against the combined branch: 11 passed, 2 failed
(`agents.spec.ts:19` and `agents.spec.ts:160`), both already on the nine-case list above.
`agents.spec.ts:81` passed. Nothing in this run failed that the base commit does not already fail.
