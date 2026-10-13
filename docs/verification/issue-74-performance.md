# Issue 74: long-history renderer performance

Status: the measured long-history renderer regression is fixed. This lane uses a synthetic provider host with the real Electron renderer, controller, IPC and persistence. It makes no provider/network latency claims and starts no native provider or paid request. Windows results do not establish macOS performance.

## Reproduce and inspect

After a coordinated `npm run build`, with other builds and tests stopped:

```powershell
npx playwright test tests/e2e/workspace-performance.spec.ts --workers=1 --output=test-results/issue74-perf
```

The harness creates and removes an isolated `sotto-e2e-*` profile. Evidence retained in the repository:

- [Corrected baseline, before the fix](../../artifacts/issue74-performance/long-history-red.json)
- [Fixed renderer, full samples and environment](../../artifacts/issue74-performance/long-history-green.json)
- [80-message control capture](../../artifacts/issue74-performance/four-panes-80.png)
- [2,000-message long-history capture](../../artifacts/issue74-performance/four-panes-2000.png)

The measured source is an **uncommitted working tree** based on `2297f648b092ae2d4e04774a436a5dcfff0f64e5`, not that commit alone. The fixed `MessageContent.tsx` SHA-256 is `7285f74afaa081161b465745804e6d57dcaee87ef229915be3bda1593f7203ac`. Its source was unchanged between the measured build and hashing. Future runs capture this identity automatically.

## Workload and timing boundaries

Windows `10.0.26200`, Intel Core Ultra 9 275HX, 24 logical processors, 31.43 GiB RAM; Electron 43.1.0 / Chromium 150.0.7871.47. The viewport was 1600×1000 CSS pixels at devicePixelRatio 1.5. The run was isolated from the team's builds and functional tests.

Four panes retain separate Sotto thread IDs and models labeled Claude, Codex and Grok. These are **synthetic model labels**, not native provider performance tests. The control stores 80 messages per thread (320 total; 84,060 UTF-8 text bytes). The long case stores 2,000 per thread (8,000 total; 2,120,340 text bytes). Both alternate user prompts with Markdown replies containing headings, lists, inline code and fenced TypeScript. Only 80 messages per pane render in either case; the test checks that bound. Twenty measured sends add a user message and a completed reply to the first thread before streaming starts.

Each case performs 20 Enter submissions, 40 growing updates to one assistant message ID, and 32 pointer focus changes across all four panes. The requested update cadence is 50 ms (20 Hz), with actual emission intervals retained. The long case's actual intervals were p50 58.3 / p95 135.0 / max 144.5 ms; these are measured renderer scheduling intervals, not fabricated network delays. Intermediate versions can coalesce, but all 40 snapshots must arrive and the final text must render.

- **Local send:** document-capture Enter event → pending-message DOM → next `requestAnimationFrame` callback.
- **Renderer stream:** validated renderer-bridge snapshot callback → matching assistant text DOM → next frame callback.
- **Controlled transport:** test-event injection → validated renderer-bridge callback. This includes the fixture host, main controller, IPC, preload validation and scheduling. The final report includes all 40 arrivals, including coalesced versions.
- **Visible update gap:** time between frame callbacks showing different stream versions; the first gap starts at the first injection. This includes controlled transport and catches stale periods that per-render latency alone can hide.
- **Pane focus:** document-capture pointerdown → focused-pane DOM attribute → next frame callback. These focus samples run after the stream burst, with long histories retained; they do not establish focus responsiveness during simultaneous native-provider streaming.

A frame callback is a rendering opportunity, not a measured physical display timestamp. Callback timing excludes provider/network latency; it cannot remove shared-thread scheduling cost or the cost of the measurement listener itself.

## Results

All values are milliseconds, shown as **p50 / p95 / max**. Fixed-run figures:

| Measurement | 80 messages/thread | 2,000 messages/thread |
|---|---:|---:|
| Local-send DOM, 20 samples | 28.2 / 48.1 / 61.9 | 28.1 / 60.8 / 66.6 |
| Local-send next frame, 20 samples | 30.8 / 52.2 / 67.3 | 32.5 / 66.6 / 69.5 |
| Stream DOM, 38 / 32 rendered samples | 22.3 / 65.5 / 66.5 | 19.6 / 40.5 / 58.7 |
| Stream next frame | 39.1 / 68.7 / 83.3 | 38.9 / 101.4 / 114.5 |
| Controlled transport, all 40 arrivals | 22.4 / 65.9 / 90.7 | 153.7 / 229.6 / 238.4 |
| Visible stream update gap | 54.5 / 105.1 / 112.5 | 61.9 / 132.3 / 145.0 |
| Pane-focus DOM, 32 samples | 3.5 / 4.3 / 4.4 | 4.1 / 10.8 / 15.3 |
| Pane-focus next frame, 32 samples | 39.3 / 52.3 / 53.3 | 39.5 / 55.5 / 57.8 |

The long case improved from stream p95 **1,150.6 ms to 101.4 ms** (about 91% lower), while rendered versions increased from 9/40 to 32/40. Local send, typing and pane-focus feedback stay within the specification's 100 ms target. Main-process acknowledgement of a send, measured later, does not; see [Concurrent input and main-process backlog](#concurrent-input-and-main-process-backlog). Controlled transport still grows with stored history and is an explicitly retained limitation; these results do not promise low network or native-provider latency.

The regression guard keeps local send below 100 ms, pane-focus p95 below 100 ms, stream-render p95 below 200 ms and maximum visible-update gap below 200 ms. The stream allowance is a test guard of four requested update periods, chosen to catch the observed second-long starvation while permitting coalescing and desktop frame scheduling; it is not a provider or product SLA. Raw maxima remain in the report rather than disappearing into a percentile.

## Acceptance checks

- Compare four mixed-model panes with 80 versus 2,000 stored messages each; retain explicit fixture sizes, update cadence, repeated samples and environment.
- Measure captured Enter to local pending-message DOM/frame opportunity against the workspace's 100 ms local-feedback target.
- Separate validated renderer snapshot arrival to visible streaming text from controlled fixture/controller/IPC/preload transport time. Count coalesced updates and require the final update.
- Measure captured pointerdown to the focused-pane attribute/frame opportunity. Retain the bounded 80-message rendered page.
- Preserve the desktop interface: existing four-pane composition, Sotto type/color/copy, Markdown/code rendering, scroll behavior, focus indication, and explicit unavailable-provider states. No layout, branding, copy or animation redesign is in scope. Inspect actual 1600×1000 Electron captures; the parent issue's layout lane covers minimum width.
- Retain the original slow result and the verified fixed result. The performance reproduction itself is the regression test; no shallow timing unit test substitutes for it.

## Diagnosis record

The first instrumentation version installed one observer per stream version. Deferred rendering legitimately skipped intermediate versions, leaving observers alive. That version's measurements are retained as `artifacts/issue74-performance/instrumentation-red.json` but are not the product baseline. The corrected harness uses one stream observer, records all arrived snapshots, and separately counts rendered/coalesced versions.

The corrected baseline (`long-history-red.json`) measured local-send next-frame p95 34.7/35.1 ms at 80/2,000 messages per thread, and stream next-frame p95 97.3/1,150.6 ms. Both runs received all 40 snapshots; 25/9 versions rendered. The long-history slowdown is distinct from provider or network latency.

Ranked falsifiable hypotheses:

1. Deferred Markdown rendering is starved by continuous higher-priority snapshots. Rendering incoming text directly should remove the late final render without materially changing controlled transport.
2. Replaced but unchanged history objects cause repeated React work. Retaining equivalent history references should reduce renderer work if deferral alone does not explain the delay.
3. Repeated large snapshot parsing dominates the renderer thread. Reducing stored history while retaining the same 80 displayed messages should reduce transport and render delay; transport is measured separately to distinguish this case.

The first hypothesis was confirmed by changing only `MessageContent` scheduling: remove `useDeferredValue(text)` and render the current text while retaining the existing `memo`/`useMemo` boundaries. The original 80/2,000-message reproduction then passed in 56.4 seconds. Markdown, links, diagram source/stream-completeness handling, thread IDs, provider routing and delivery reconciliation keep their existing implementation. The large measured transport cost remains visible instead of being attributed to a provider.

Validation: production build passed; 27 focused Markdown, diagram and bounded-fixture tests passed; focused ESLint passed. The final benchmark source adds source-identity metadata and strengthens guards against the measured local-send maximum and visible-update gap; the saved green samples satisfy those guards. A final quiet rerun of those test-only additions is pending the parent task's broader functional suite.

## Rendered verification

Inspected the actual fixed Electron long-history screenshot and the pre-fix screenshot. The four-pane arrangement, readable Sotto type, dark palette, focused-pane border, scroll containers and fenced-code presentation remain intact. The first pane follows the streamed response; the other three retain their own histories and input controls. The provider limitation “Claude can't steer a running turn” and unavailable token/context/estimate states remain visible. Existing project, model and thread labels are intentionally retained operating context; no new interface copy or decorative elements were added, and no copy/animation redesign was appropriate to this timing-only fix. Minimum-size and light-mode verification belong to the issue's separate layout lane; this performance capture does not claim them or macOS coverage.

## Concurrent input and main-process backlog

The first pass measured typing, sending and pane focus only after the stream burst. A second section now streams one growing reply in the first pane at a requested 100 ms cadence while the test clicks, types and sends in the other three panes. The stream continues until every interaction has finished (minimum 80 updates, cap 240), so no interaction can fall after the burst on a slower run. All guards are soft so a miss in the 80-message case still records the 2,000-message case.

Two harness corrections came first. The original fixed 80-update burst ended before the last focus changes on some runs (9 or 10 of 12 occurred during streaming), and its maximum visible-gap guard also counted lateness of the injector's own timers, which share the renderer event loop (requested 100 ms, actual up to 243 ms). The guard now bounds per-version staleness, from injection to the frame showing that version. The raw gap is still reported.

### Diagnosis

With 2,000 messages per thread, renderer-side feedback stayed fast during streaming (typing and focus p95 under 50 ms), but the prompt took 1.5 to 3.4 seconds to clear after Enter, and each Playwright click took about a second to dispatch. Both returned to normal as soon as the stream stopped. The prompt clears only after the main process accepts the send, so the delay pointed at the main process rather than rendering. A new measurement records it directly: captured Enter to the first animation frame with an empty prompt.

Ranked hypotheses:

1. The main process falls behind because each host update copies and sends every thread's full history several times. Removing redundant copies should shorten transport and send acknowledgement without changing renderer timing.
2. Workspace persistence rewrites the full snapshot on every update. Its clone and disk write would dominate the per-update cost.
3. Renderer-to-main commands during streaming (focus selection, draft saves) trigger their own full publishes. Removing them would reduce the cost only while interacting.

Temporary main-process timing, since removed, confirmed the first. At 2,000 messages, each `AgentControl.get()` deep copy took about 7.5 ms, and each state publish took about 17.6 ms in listeners. `personalChats.configurationChanged()` called `get()` again only to read configuration (7.5 ms), and the main and widget IPC sends took about 5 ms each. Each host update also published twice: once from `acceptSnapshot()`, and again when the fire-and-forget state write completed, even though that write changed no draft evidence. The 2,000-message run recorded 1,219 publishes for 339 host updates, with 23 seconds of cumulative event-loop lag. Workspace persistence cloning cost about 6 ms per update but coalesces while a write is outstanding, which ruled it out as the primary cause. Commands contributed about 100 of the publishes.

### Fix

- `AgentControl.configuration()` returns a copy of the configuration alone. Main-process callers that only need configuration (provider selection, enabled providers, membership, reasoning, personal chats and prompt generation) use it instead of copying the full state. The provider switch reads these on every native host event, so production gains beyond this fixture.
- A completed state write publishes again only when the draft persistence evidence differs from what was last published. A write that confirms a draft (`saving` → `saved`) or fails still publishes, so a fresh renderer that received no command response still gets its evidence. Unit tests in `tests/unit/main/threadDrafts.test.ts` cover both, plus the configuration copy.

No renderer, IPC schema, delivery reconciliation, thread identity or provider binding changed.

### Results

Same harness and machine. The before run uses the prior controller with the renderer fix already present. Values are milliseconds, p50 / p95 / max.

| Measurement, 2,000 messages/thread | Before | After |
|---|---:|---:|
| Send acknowledged while streaming, 8 samples | 1,947 / 2,290 / 2,290 | 789 / 931 / 931 |
| Send acknowledged, no stream, 20 samples | 658 / 803 / 823 | 579 / 822 / 1,006 |
| Controlled transport while streaming | 114 / 169 / 208 | 51 / 145 / 172 |
| Controlled transport, isolated burst | 108 / 155 / 164 | 65 / 87 / 99 |
| Injection to display while streaming | 161 / 227 / 285 | 92 / 201 / 223 |
| Typing next frame while streaming | 28 / 44 / 44 | 23 / 41 / 41 |
| Concurrent section duration | 24.1 s, cap reached, 6 of 12 focus changes during the stream | 14.3 s, all 20 interactions during the stream |

At 80 messages per thread the two runs match within noise. Send acknowledgement is 238 to 287 ms p50 in both, because the send is durably recorded before the prompt clears. Evidence: [concurrent-red.json](../../artifacts/issue74-performance/concurrent-red.json), [concurrent-green.json](../../artifacts/issue74-performance/concurrent-green.json).

The new guard requires a maximum send acknowledgement under 1,500 ms while streaming. It catches the measured backlog (2,290 ms) with margin over the fixed result (931 ms), but it is not a product target. Acknowledgement still grows with stored history, because every publish and command response carries every thread's full history across IPC. Removing that cost needs incremental or per-thread state delivery, which is outside this fix. The pending message itself still appears within the 100 ms local-feedback target: next frame max 45 ms while streaming at 2,000 messages. Acknowledgement at p50 789 ms remains a partial result against #74's local-feedback criterion, not a pass. Windows only; synthetic provider; no provider or network latency is claimed.
