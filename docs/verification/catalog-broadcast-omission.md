# Model catalog omitted from a repeat broadcast

Issue #286, continuing `docs/verification/composer-typing-lag.md`. That change made the selected host's
catalog cross once instead of twice; this one stops sending it at all once a window already has it.

## What was measured

`AgentStateBroadcaster` (`src/main/agents/agentStateBroadcast.ts`) was fed the owner's real catalog --
608 models, read from `%APPDATA%\sotto\workspace.json` (`snapshot.models`), counts and byte sizes only,
never its contents -- and its output serialised with `node:v8`'s `serialize`, which approximates what
Electron's structured clone puts on the wire:

| | before (`AgentState` sent whole) | after |
| --- | ---: | ---: |
| first publish (catalog present) | 649 KB | 649 KB + 37 bytes |
| unchanged repeat | 649 KB | 1.1 KB |

An unchanged repeat is 99.8% smaller. The first publish after a real change is unaffected. Detecting
"unchanged" with `isDeepStrictEqual` against the previous publish's catalog, for both the main window and
the widget, cost about 0.5 ms on the same 608-model catalog (`node:perf_hooks`, 50 runs) -- paid once per
coalesced publish in main, not on the window's own thread, and not on every keystroke.

`tests/unit/main/agentStateBroadcast.test.ts` and `tests/unit/preload/agentStateCatalogCache.test.ts` cover
the omission, the recovery through `AGENT_GET` when a window is missing the revision a broadcast names, and
both `host.models` and `host.clientHosts[].models` apart from each other.

## What was not measured here

The owner's installed app was not run for this change; `docs/verification/composer-typing-lag.md`'s
DevTools measurement of real per-keystroke latency has not been repeated with a live 608-model catalog and
a working thread. The byte and timing figures above stand in for that until it is.

## Build and test gates

`npm run typecheck`, `npm run lint`, and the unit suites under `tests/unit/main`, `tests/unit/preload` and
`tests/integration/ipc.test.ts` pass (2,325 passed, 1 skipped, across 174 files). `npm run build` succeeds.

`npx playwright test tests/e2e/new-thread-settings.spec.ts tests/e2e/effort-picker.spec.ts
tests/e2e/agents.spec.ts tests/e2e/queued-steering.spec.ts` was run against this change and, separately,
against the base commit (`d56ceb89`, before this branch). The same five cases failed identically on both:
`agents.spec.ts`'s native-subscription-selection and manual-mode cases, both `effort-picker.spec.ts` cases
that read a saved reasoning effort, and `queued-steering.spec.ts`'s keyboard steering case. They are
pre-existing failures, unrelated to this change.
