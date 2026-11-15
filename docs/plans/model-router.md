# Model router: a routed thread's model and effort are chosen for each message

Branch `feat/model-router` (worktree `.worktrees/model-router`, from `origin/main` cd02ed610). Requested by Drake on November 13, 2026. On November 14 the owner approved an Owl feature pull request and merge after required GitHub checks. App launches and live provider runs remain outside this landing.

## Goal

A Claude Code thread can be **routed**. For each message the user sends on a routed thread, Sotto first asks a classifier (a side call to the user's own Claude Code, ADR-0026) which Claude model and effort the message should run on, by Anthropic's guide "Which Claude model should you build with?" (claude.dev, November 9, 2026), then puts the thread on that model and effort and sends the message. The switch sits at the foot of the model menu beside Dynamic's.

## Acceptance criteria

1. **Switch.** On a Claude Code project thread on this computer that no thread delegated to, the model menu's foot shows a **Model routing** toggle under Dynamic's. It exists only where the Owl feature `model-router` is on. It is disabled, with a one-line reason, while the thread is Dynamic, and Dynamic's toggle is disabled while the thread is routed. Main refuses the same combinations.
2. **Chip.** While a thread is routed its model chip shows the Claude mark and **Auto** in place of a model name. Once the router has chosen for this thread, the chosen model's name follows in the accent colour ("Auto · Opus 5.5"), and the effort chip shows the chosen effort, fixed, with the reason "Model routing chooses the effort." While the classifier is being asked, the chip carries the existing pending mark. Resting on the chip (or focusing it by keyboard) shows a card with the chosen model, effort and the classifier's reason. Accessible name: "Choose model. Model routing is on, now Opus 5.5, Medium".
3. **Routing a send.** A user's send (typed, dictated, from a paired phone, or a queued follow-up when its turn comes) on a routed thread at rest runs the classifier, then `configure-thread` with the picked model and effort when they differ from what the thread runs on, then the send. Steers, wake-ups, Watcher's and delegation's sends, Council judges, and threads that cannot be routed are sent exactly as today.
4. **Stay on the first model.** Settings → Threads has a **Model routing** group with a toggle **Stay on the first model**, off by default. Off: any message may move the thread to a bigger or a smaller model. The classifier is told to keep the model for a go-ahead, a status question, an aside or a follow-on step, to move up when the work needs a bigger model, and to move down only when the message clearly starts a new, smaller job. On: the router chooses the model only for a thread's first message (a thread with no provider session yet, read from `nativeSessionStarted`, never from an empty history; typing waits to start a new routed session until that pick); every later message keeps the thread's model and the router changes only the effort, and a thread that already has a session when routing is turned on keeps its model.
5. **New threads.** The model menu in Settings' **New threads start with** row has the same toggle at its foot, saved as `modelRouter.newThreads`; a new Claude Code thread then starts routed (as `dynamicThreads.newThreads` does for Dynamic). If both are on, Dynamic wins and the routing toggle shows why.
6. **Choosing a model by hand turns routing off.** Pressing a model in the menu on a routed thread sends `set-thread-routed false` and then the model change, so the press is never overridden.
7. **Failure is quiet and safe.** If Claude Code is disconnected, the classifier takes longer than 20 s, or its answer cannot be read, the message is sent on the thread's current model and effort. Nothing is lost and no error dialog shows; the chip's card says "Model routing did not answer. Sent on Opus 5.5, Medium." A `configure-thread` that does not come back accepted is **not confirmed**, whatever the cause: a refusal, a lost acknowledgement, a change the CLI took only part of, or a restart that failed after the adapter had recorded the pick (`claude.ts` `unconfirmedSettings` and `restartWithSettings` both record the pick before the outcome is known, and only a guarded Watcher configuration is rolled back). The router cannot tell these apart from the exception, so it does not try: the message is still sent, the router names no settings, and the card says "Claude Code did not confirm the model change. The chips show what this thread runs on." The chips already do: they read the thread's own record, which the adapter brings into line with the CLI at its next launch, and they carry the existing pending mark while a change is unconfirmed.
8. **Privacy.** The classifier call goes only to the thread's own provider and account. Prompt text, the classifier's reason and model names never reach a log; main logs event names only (`model-router-chose`, `model-router-kept`, `model-router-failed unavailable|timeout|unreadable`). The reason is kept in memory only and is gone after a restart.
9. **Stable and other providers see nothing.** With the Owl feature off, no toggle, setting row, bridge or behaviour exists and a saved `routed` mark stays whole and does nothing.

## Approach

### The classifier

- Transport: the existing side call. `ShortTextTarget` (`src/main/agents/host.ts:225`) gains `effort?: string`; `writeShortTextOn` in `providers/claude/claude.ts` uses `target.effort ?? sideWritingEffort(...)`. `ShortTextPurpose` gains `'model-route'`. The command is the one ADR-0026 names (`claude --print --safe-mode --tools "" --permission-prompts none --no-session-persistence --output-format json --model … --effort … --system-prompt <instruction>`, material on stdin), so the classifier can read nothing and do nothing.
- Classifier model and effort: constants in `src/shared/modelRouter.ts`, chosen from the benchmark below: **Opus 5.5 at low** (Drake's pick, November 13, 2026).
- Instruction: Sotto's routing rules and its own task summary in `src/main/agents/modelRouterInstruction.ts`. The pre-PR review removed the copied article. The older benchmark instruction remains local evidence for classifier selection; it is not byte-identical to the shipping summary and its scores do not validate that summary.
- Material: for a first message, `User message:\n<text>`. For a later message, a `Thread so far` block first: `Current model`, `Current effort`, `Previous user message` (first 300 characters) and `End of the last reply` (last 400 characters), exactly as `run_benchmark.py`'s `material()` builds it. The user's text is cut at 4,000 characters.
- Answer: one line of JSON `{"model","effort","reason"}`. The parser takes the first `{…}` object in the reply (Opus sometimes wraps it), accepts `model` in haiku | sonnet | opus | fable and `effort` in low | medium | high | xhigh, cuts `reason` at 120 characters, and treats anything else as unreadable.
- Mapping to the catalog: among `state.host.models` with `providerId === 'claude'` and not `legacy`, the entry whose `modelLine` is the picked tier; never a hard-coded id. A thread holding a variant of the same entry (`opus[1m]`) keeps its held id (`catalogEntry`, `chosenModelId`), so the same model is not a switch. An effort the entry does not list falls to the nearest one it does. `max` and Ultracode are never chosen.

### Where it runs

- New module `src/main/agents/routedSend.ts` holds all router logic for main (control.ts is under a size cap, `tests/fixtures/codeSizeBudget.json`). `control.ts` calls it from `dispatchPending`, beside the start-handover step and before the outbox push: the one point direct sends and queued follow-ups share, where the thread is at rest, its lane is held and later sends queue behind `threadPrompts`.
- The hook routes only when: the feature is on; the command is `send`; it is not a wake-up or automatic send and has no `origin` other than a phone's user send; the thread is routed and `whyNotRouted(thread)` is undefined; no next-turn choice of model or effort is waiting or on its way for the thread; and the user has not set the thread's model or effort by hand since its last message. Every such change from outside the router comes through the `configure-thread` case, pressed at rest or kept for the next turn and sent when the thread rests, so that case marks the thread and the next user send takes the mark and goes unrouted, once (added after inspection 3).
- Before the classifier is asked the coordinator's state is saved, because a prompt that goes at once is otherwise held in memory until the outbox write; if that save fails the send is refused with the existing "Could not save this prompt" error (added after inspection 2).
- It applies the pick with `this.dispatch({ type: 'configure-thread', commandId, threadId, modelId, reasoningEffort })`, always naming both, never through `admitCommandShell` (which would take the lane the send already holds). On an unstarted thread that writes the thread record and the first send launches on it.
- That dispatch has two outcomes for the router. Accepted: the pick is in force and the record is `chose`. Anything thrown: `unconfirmed`. The router does not infer a refusal from `settingsUnconfirmed(threadId)` being false, because a failed restart leaves the pick on the adapter's alias with no outbox entry to show for it. It catches the exception, clears the command error its own configure may have set, records `unconfirmed` with the reason and no model or effort, and lets the send go. Whatever the configure left in the outbox reconciles as any unconfirmed change does. The adapter's rollback rules are not changed here.
- The chip's model name and the effort chip always read the thread's own `modelId` and `reasoningEffort`, never the router's record; the record adds only the pending state, the reason and the failure line.
- Shell state gains `routerPicks`, one entry per thread, in memory only like `nextTurnSettings`: `{ threadId, state: 'choosing' | 'chose' | 'kept' | 'failed' | 'unconfirmed', modelId?, reasoningEffort?, reason? }` (`failed` is the classifier not answering; `unconfirmed` is the configure not coming back accepted, and carries no model or effort). It changes only on a routed send, so a provider update costs nothing more. At most 100 threads' picks are kept, the newest, a deleted thread's goes with it, and the desktop joins every host's picks and shows at most the 1,000 its schema takes (added after inspections 1 to 3).
- `src/renderer/src/agents/shellCache.ts`: `cacheableShell` drops `routerPicks` beside `nextTurnSettings`, and `readShellCache` discards any it finds, so the startup cache in localStorage never holds a reason and a restart never restores a stale pick.

### The mark, the setting, the gate

Copy Dynamic's path end to end (ADR-0191):

- `src/shared/owlFeatures.ts`: `{ id: 'model-router', name: 'Model routing', owlSince: '2026-11-13', owner: the new ADR, sentToStable: false }`.
- `src/shared/modelRouter.ts` (new): settings schema `{ stayOnFirstModel: boolean, newThreads?: true }` built at module scope, default `{ stayOnFirstModel: false }`, a field-at-a-time parser, `whyNotRouted`, `isRoutedThread`, the tiers and efforts, the material builder, the answer parser, the catalog mapping and the stay rule. Pure functions, so both processes and the tests share them.
- `src/shared/agents.ts`: thread field `routed: z.literal(true).optional().catch(undefined)`, command `set-thread-routed`, create option `routed`, `routerPicks` on the state. `src/shared/threadLanes.ts`: the command rides the thread's lane.
- `src/shared/settings.ts` + `src/main/ipc/registerIpc.ts` patch allow-list + the Owl gate in `src/main/storage/settingsRepository.ts` / `repositories.ts`: `modelRouter`.
- `control.ts` (`modelRouterEnabled` dependency, setter, route, create), `host.ts`, `workspace.ts`, `runtime.ts`, `index.ts`: `setThreadRouted`, as `setThreadDynamic`. `setThreadDynamic(true)` refuses a routed thread and `setThreadRouted(true)` a Dynamic one.
- `src/host/remoteCommands.ts`: `set-thread-routed` is host-local, as `set-thread-dynamic` is.

### Renderer

- `src/renderer/src/agents/RouterSwitch.tsx` (new): `useRouterSwitch` and `useNewThreadsRouterSwitch`, shaped like `DynamicSwitch.tsx`'s hooks, with no first-use question (nothing leaves the thread's own provider).
- `ModelPicker.tsx`: `foot` already takes a node; the callers stack both toggles. One new optional prop, `shownName`, replaces the model's name on the chip ("Auto"); `suffix` carries the chosen model, `pending` the classifier wait, `card` the reason.
- `ThreadOptions.tsx`: on a routed thread the effort chip is the existing `FixedEffortChip` with the routing reason, and a model press turns routing off first.
- `AgentAccountSettings.tsx`: the new-threads toggle. `DynamicThreadsSettings.tsx`'s page (Settings → Threads) gains the **Model routing** group with **Stay on the first model** and one line under it: "A new model re-reads the whole conversation at full price, and a smaller one loses the earlier reasoning. On, a thread keeps the model its first message got and later messages change only the effort."
- `newThread.ts`: `startsRouted` beside `startsDynamic`.
- Styles reuse `threadChips.css` and `modelPicker.css` tokens; no new stylesheet.

### Documents

`CONTEXT.md` (**Routed thread**, **Model routing**, **Router pick**), a new ADR `docs/adr/0207-a-routed-threads-model-and-effort-are-chosen-for-each-message.md`, and a short **Model routing** section in `docs/guide.md` after Dynamic threads. `npm run i18n:extract` and commit what it writes to `src/locales`.

## Key decisions and trade-offs

- **Classifier sees the prompt plus a little of the thread.** Half of Drake's real follow-ups are things like "update?", "just merge it now", "yes". Alone they are unroutable; with the current model, the previous message and the end of the last reply they route correctly in the benchmark.
- **The model may move up or down; staying is a switch, off by default** (Drake's pick, November 13, 2026, after first choosing strict staying). Strict staying strands a thread that opens with a small question on a small model: three of the benchmark's 23 follow-ups were that case. The guide's costs still hold (a new model pays the cache-write price on the whole conversation, and a move down loses the earlier reasoning), so the classifier's rules make a switch the exception: keep for go-aheads, status questions, asides and follow-on steps; move up when the work needs it; move down only for a clearly new, smaller job. Effort changes keep the cache and are free.
- **Effort runs one level above the guide** (Drake's pick, November 13, 2026). Real work starts at high where the guide says medium, and goes to xhigh when the message shows it is harder than usual. Light requests keep the guide's low or medium. The guide's own figures put Opus at medium about 2.5 points under high on SWE-bench Pro for about 70% of the cost.
- **All four models are choices** (Drake's pick), as the guide has them.
- **Three rules come from a video review of the guide** (youtube.com/watch?v=XtykeVoSmP8, transcript read November 13, 2026; one developer's experience, not a measurement, so each applies only where the guide leaves room). Between Opus and Fable, checkable work (tests, regression cases, a build) and review or audit work go to Opus, and work resting on judgment, design or new ideas goes to Fable. A thread already at xhigh whose user reports another failure moves up a model at high rather than staying. And Fable is kept for clear cases, since on a subscription it is the scarce model.
- **The chip reads "Auto" and then the pick.** Drake asked for the Claude mark, no model name and the host's judgment on the rest. Showing the chosen model after "Auto" keeps what the thread runs on visible at a glance, as every other thread's chip does; an affordance on an existing surface, so no mock-up (AGENTS.md).
- **A pick is applied as an ordinary `configure-thread`.** No new provider path: the Claude adapter already changes model and effort live over its control channel with no restart.
- **The pick's reason lives in memory.** Persisting it would put model-written text about the prompt in a second store; a restart losing it costs nothing.
- **The shipped instruction is Sotto's own summary.** The pre-PR review removed the article copy, retaining the task categories and the owner's effort and continuity choices. The existing benchmark measured the earlier instruction. A future live comparison must use a benchmark folder carrying the new instruction; the opt-in live suite deliberately checks those bytes before calling the provider.

## Non-goals

- Routing Codex or any other provider, Watcher, delegated threads, Dynamic threads, or threads on another machine.
- Choosing speed (fast mode), `max` effort or Ultracode.
- Reading attachments, skills or files to classify; only the message text is read.
- A classifier setting in the UI, per-project routing rules, routing history, or a usage report.
- The iPhone and Android clients: they show the thread's model and effort as they do today.
- Compacting before a model switch.
- Capping the router at Opus when the subscription's Fable limit is nearly used. Worth adding once the router is in use; it needs Sotto's per-model limit reading.

## Assumptions and sources

| Assumption | Source |
|---|---|
| A model switch re-writes the whole conversation cache; moving down drops earlier reasoning; effort changes are free | The guide, "Switch at a natural break"; Claude Code prompt-caching docs (Drake's 2026-10-21 research) |
| A Claude thread at rest changes model and effort live (`set_model`, `apply_flag_settings`), with no restart | `src/main/agents/providers/claude/claude.ts:186-200, 1342` |
| `dispatchPending` is the shared pre-outbox point; nothing enforces a send-acknowledgement deadline | `src/main/agents/control.ts:5340-5403`; recon of main, renderer and host |
| `client.write` already takes an effort; only `ShortTextTarget` hides it | `src/main/agents/subscriptionClaude.ts:111-115`, `host.ts:225`, `claude.ts:876` |
| Catalog ids for this account are aliases (`opus`, `fable`, `sonnet`, `haiku`), each listing low…max | live catalog from Claude Code 2.1.323 |
| The classifier answers in 2–5 s | benchmark, 12 configurations × 78 prompts, November 13, 2026 |

## Benchmark (done before this plan)

Round 1, below, chose the classifier on the first rules (the guide's own effort levels, no move down mid-thread). Round 2, after it, re-tests the chosen classifier on the rules as they now stand.

`~/Developer/Reports/model_router/benchmark/`: 78 prompts (44 real ones from Drake's Claude Code history, 34 written to cover every row of the guide's table; 55 first messages, 23 follow-ups), labelled independently by the host and by a blind Fable labeller (same model on 74 of 78, same model and effort on 65). Each configuration ran every prompt once through the real side-call command.

| Classifier | Accepted pick | Model = host label | Too low | Too high | Median | p90 |
|---|---|---|---|---|---|---|
| Opus low | 99% | 90% | 0 | 0 | 2.5 s | 3.0 s |
| Opus medium | 99% | 90% | 0 | 0 | 2.8 s | 3.6 s |
| Opus high | 99% | 88% | 0 | 0 | 3.0 s | 4.2 s |
| Opus xhigh | 99% | 90% | 0 | 0 | 3.3 s | 5.1 s |
| Sonnet xhigh | 99% | 87% | 0 | 0 | 3.3 s | 4.7 s |
| Sonnet high | 99% | 81% | 1 | 0 | 2.8 s | 3.7 s |
| Haiku xhigh | 96% | 87% | 0 | 0 | 4.2 s | 5.9 s |
| Sonnet low | 96% | 79% | 1 | 0 | 2.0 s | 3.0 s |
| Sonnet medium | 96% | 76% | 1 | 0 | 2.0 s | 3.5 s |
| Haiku high | 87% | 78% | 2 | 0 | 3.2 s | 4.4 s |
| Haiku medium | 85% | 60% | 5 | 0 | 2.0 s | 3.3 s |
| Haiku low | 77% | 47% | 12 | 0 | 1.8 s | 3.0 s |

"Accepted" is a pick either labeller called defensible. With 78 prompts one prompt is 1.3 points, so the top five are tied on accuracy; Haiku below xhigh and Sonnet below high are measurably worse.

The five leaders were then run three times each. Accepted picks held (77, 77, 77 of 78 for Opus low, Opus medium, Sonnet xhigh and Sonnet high; 75, 73, 75 for Haiku xhigh). What separates them is consistency, the prompts that got the same model in all three runs: Opus low 75 of 78, Opus medium 71, Sonnet xhigh 71, Sonnet high 70, Haiku xhigh 64. Opus low is the most consistent and the fastest of the top group, so it is the classifier.

### Round 2: the rules as they now stand

`~/Developer/Reports/model_router/benchmark/v2/`: the revised rules (effort one level above the guide, moves up and down, the Opus and Fable tie-breakers), 81 prompts (the 78 above and three follow-ups that should move down or drop effort), relabelled by the host and by a fresh blind Fable labeller (same model on 75 of 81, same model and effort on 65).

| Classifier | Accepted pick | Model = host label | Too low | Too high | Unreadable | Median | p90 |
|---|---|---|---|---|---|---|---|
| Opus low, run 1 | 98% | 89% | 0 | 0 | 0 | 2.6 s | 3.6 s |
| Opus low, run 2 | 98% | 89% | 0 | 0 | 0 | 2.5 s | 3.3 s |
| Opus low, run 3 | 98% | 86% | 0 | 0 | 1 | 2.5 s | 3.7 s |
| Sonnet xhigh | 100% | 91% | 0 | 0 | 0 | 3.7 s | 5.3 s |
| Opus medium | 98% | 88% | 0 | 0 | 0 | 2.8 s | 3.8 s |
| Haiku xhigh | 91% | 86% | 2 | 1 | 0 | 4.9 s | 6.9 s |

Opus low gave the same model in all three runs on 78 of 81 prompts and the same model and effort on 73. Its two repeated misses are both effort calls (a hand-off to a worker run at low; a passkey rewrite sent to Fable at xhigh where both labellers wanted Opus or Fable at high). Its one unreadable answer in 243 was prose with a tool-call-shaped block in place of the JSON line; criterion 7 covers it. Sonnet xhigh's single run was clean on all 81, two prompts better than Opus low, which is inside the noise of one run; Opus low stays the classifier for its speed and its consistency across runs, and the constant is one line to change.

## Risks

- **Moving down loses the earlier reasoning** and re-reads the conversation. Drake chose to allow it; the rules keep it rare, and **Stay on the first model** turns it off.
- **Usage.** Every routed send adds one small Opus call (under 200 output tokens; the earlier instruction used about 6k cached input tokens) to the subscription's limits.
- **The benchmark is small and half synthetic.** It ranks classifiers; it does not prove the router beats always using Opus at medium. The guide's own advice is to measure on real work, which only use will do.
- **Reentrancy.** `configure-thread` is dispatched from inside a send's `dispatchPending`. The builder must confirm the Claude adapter's "refuses while dispatching" guard is not yet set at that point, and that a throw leaves the send intact.
- **A configure that is not confirmed** can leave the thread on either the old settings or the pick, and can stop the CLI (ending background work it still ran) before the message is sent. That is what an unconfirmed chip press does today. The router claims nothing in that case and the chips converge on what the CLI runs at its next launch.
- **The model changes under a thread's other state**: unconfirmed settings, a kept next-turn choice, a spare CLI. The hook skips routing when a choice waits and otherwise goes through the same command a chip press does.
- **The shipping summary is not benchmarked.** No live provider run is part of this landing. The classifier choice is supported by the earlier instruction's benchmark, and accuracy of the rewritten summary remains unmeasured.

## Verification

Run with the pinned Node: prefix each with `fnm exec --using=v24.22.1`. Never `npm test`, Playwright, design capture or an app launch (Drake's rule).

1. `npm run typecheck` and `npm run lint` pass.
2. `npx vitest run tests/unit/shared/modelRouter.test.ts` (new) passes: answer parsing (plain, wrapped, wrong model, wrong effort, no JSON), catalog mapping (tier to entry, `opus[1m]` kept, effort not listed), the stay rule (first message, later message, routing turned on mid-thread), `whyNotRouted` for each refused kind, and that the material builder's output equals `run_benchmark.py`'s for one first message and one follow-up fixture.
3. The pinned lists the change touches pass, one file at a time: `tests/unit/shared/owlFeatures.test.ts`, `tests/unit/shared/interfaceCatalogs.test.ts` (after `npm run i18n:extract`), `tests/unit/host/remoteCommands.test.ts`, the settings repository test, and the code-size, copy-site and zod-schema-site tests. `tests/integration/settingsHistoryIpc.test.ts` passes (the patch allow-list).
4. A new unit test of `routedSend.ts` with a fake host passes: a routed send classifies then configures then sends; an unrouted thread, a wake-up, a steer and a Council judge are sent untouched; a classifier timeout, a null answer and an unreadable answer send on the current settings; a configure that is refused, one whose acknowledgement is lost, one the CLI took only part of, and one whose restart fails after the adapter recorded the pick all still send, record `unconfirmed` with no model or effort, and leave no command error; with **Stay on the first model** on, a later message never changes the model, and with it off a later message can move the model up and down; a kept next-turn model choice skips routing.
5. The startup cache's own test (`tests/unit/renderer/shellCache.test.ts` or where `cacheableShell` is tested) gains two cases: a shell with a router pick serializes with no `routerPicks` and no reason text, and a cached shell that holds one reads back without it.
6. **Real program, same inputs, old against new.** A live test gated by `SOTTO_ROUTER_LIVE=1` (never in CI) reads `SOTTO_ROUTER_BENCHMARK` (the benchmark folder), asserts the TypeScript instruction is byte-identical to `v2/router_instruction.md`, runs all 81 prompts of `v2/dataset.json` through the TypeScript material builder, `ClaudeSubscriptionClient.write` and the TypeScript parser at the chosen classifier setting, and writes `runs/sotto-<model>-<effort>.json`. `python3.14 v2/score.py` must then show it within two prompts of the Python runs of the same configuration in round 2, with no more "too low" picks than they had.
7. **By hand, Drake's.** In a build of this branch installed with `sotto-install`: turn Model routing on in a new Claude thread, send a trivial question and a hard task in two threads and see the chip name different models; send "yes" after a proposal and see the model stay; turn **Stay on the first model** on and off; press a model by hand and see routing go off; check the chips at 820×560. No build or install happens without Drake asking for it.
