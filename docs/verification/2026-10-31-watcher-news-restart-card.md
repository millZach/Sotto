# Watcher news in a stopped-thread card

Investigated October 31, 2026 against `bde56ebfe86ba8bf4bf758b58de9f8c2553e4ae3`, the main commit in Drake's reported `0.1.43-owl.20261031.2` build. Local records were read without changing them. The app was not launched or driven.

## What the reported card shows

- `src/renderer/src/agents/RestartStopped.tsx`, `RestartBands` / `RestartBand`, renders the clock band under Search threads. This is the usage-limit restart band, not a notification or a needs-you card.
- `restartWords.ts`, `restartGroups`, groups published `scheduledRestart` records by provider and reset time. An absent `at` selects `restartBandLead`'s "didn’t say when its limit resets" and `restartBandRest`'s "Send again once it resets".
- The smaller button is `thread.title`. The current Watcher gets the literal label `Watcher`; `watcher-history` gets its stored title. It is not a last-message preview.
- `watcherNews.ts`, `WATCHER_WAKE_UP_PROMPT`, is the internal text whose first words became that title. `firstMessageTitle` truncates it to `Sotto has news of watched threads. It is in the note that…`, exactly the reported line.

## The local record behind it

The app's data folder is `~/Library/Application Support/sotto`.

- `limit-restarts.json` has one record: Sotto thread `f9be1a1d-3ba7-4c3e-95ea-f5e86bfff1da`, provider `claude`, stopped at `2026-10-30T02:22:14.695Z`, restarts `0`, no `at`. That is **October 29, 7:22:14.695 pm MST**, not a fresh October 31 stop.
- `workspace.json` gives that thread the exact leaked title above, `titleSource: default`, `titledFromFirstMessage: true`, `kind: watcher-history`, and `workspaceSettledAt: 2026-10-30T20:20:08.448Z`. It was already earlier Watcher history by October 30, 1:20 pm MST.
- `threads.json` binds it to Claude adapter ID `2854b4e4-ec42-4f4b-ad02-33fcd9069917`. `claude-threads.json` binds that to native Claude session `3a54c0fc-5da3-42b6-8b02-7ee29269da21`, native title `Watcher`, model `native:claude:model:fable`.
- `threads.sqlite` has the internal first user message `cb019092-8080-4728-adff-f751f50b0d0f` at position 0, `2026-10-25T21:53:16.763Z`; its ID is in `wake_ups`. This is a recorded Sotto delivery, not someone typing the same words.
- The last assistant error is message `6fbbaeea-0111-4829-87b5-498f6ec48584`, position 1664. Its `message-added` event is sequence 45644 at `2026-10-30T02:22:14.643Z`.

The matching native record is line **26782** of `~/.claude/projects/-Users-drakemorey-Library-Application-Support-sotto-watcher-workspace/3a54c0fc-5da3-42b6-8b02-7ee29269da21.jsonl`. Claude Code version `2.1.314` recorded:

```json
{
  "type": "assistant",
  "timestamp": "2026-10-30T02:22:14.643Z",
  "message": {
    "model": "<synthetic>",
    "content": [{
      "type": "text",
      "text": "You've reached your Fable limit. Switch to another model, or manage usage credits at https://claude.ai/settings/usage?from=cc_cli_limit_message, to continue."
    }]
  },
  "apiError": "model_requires_usage_credits",
  "error": "rate_limit",
  "apiErrorStatus": 429,
  "errorDetails": "429 {\"type\":\"error\",\"error\":{\"type\":\"rate_limit_error\",\"message\":\"This request would exceed your account's rate limit. Please try again later.\"},\"request_id\":\"req_011CgXdBka3KznqgzQ6hW17q\"}",
  "isApiErrorMessage": true
}
```

Earlier attempts at lines 26762 and 26772 have the same credit-limit wording. None of these retained errors contains a reset timestamp, "resets at" phrase, retry-after value or rate-limit headers.

## Causes and scope

**Internal title: confirmed defect.** The first-message title path used raw history. Automatic and requested generated titles also used raw exchanges. A store read for an offscreen thread additionally omitted its wake-up marks, so filtering only an in-memory message would not fix it. The normal displayed-message and summary paths already hide recorded Watcher news, but the title had been saved before those projections.

The fix applies the existing `watcherWakeUpsAsShown` rule to all three naming paths and preserves wake-up marks in stored-history reads. At startup it repairs an old first-message title only when its source is automatic, the recorded opening is a hidden/partly hidden wake-up, and its exact first-message title matches the saved title. User titles, ordinary user messages that happen to use those words, and generated titles are not renamed. The repair reads the opening message, not the full conversation.

Sibling paths read the repaired published title: `ThreadSidebar.tsx` uses `row.thread.title`; `threadFacts.ts` builds list/search/attention rows from the published title and summary; `threadAlerts.ts` uses the published title for notifications. `control.ts`'s existing `presentedSummary` removes internal news from the summary's last user message. The regression checks both the complete state and the shell state consumed by list surfaces.

**Missing reset: no parser defect established for this event.** The retained provider output identifies a credit requirement and contains no reset to parse. `claudeTurnFailure.ts` reads result/error text for a reset epoch or clock phrase; `limitRestart.ts` keeps an unknown-time record without a timer. This matches ADR-0144 decision 3. That ADR explicitly rejects hourly retries when a provider gives no reset.

Claude Code's documented `SDKRateLimitEvent` has an **optional** `resetsAt`; the usage-credit rejection fields do not establish a default reset window. The adapter already reads rate-limit events for usage, but the full historical SDK result/event stream was not retained here. The native transcript and Sotto event store cannot prove that no unretained frame had a timestamp. There is no evidence supporting a parser/scheduler change or an invented reset. Source checked through Context7: [Claude Agent SDK TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript).

There is already a prompt-free probe in `claudeLimits.ts`: the experimental `get_usage` control request, with passive events as its fallback. Other providers can supply a reset from an exhausted window through `providerQuota.ts`. Neither gives this historical credit rejection a proven matching window; retrying a model turn or choosing a quota window would add an assumption, not recover the missing timestamp.

**Obsolete band: confirmed defect.** The same thread was already read-only Watcher history. The old restart record survived because that kind is not `isThreadClosed`, and `restartGroups` allowed it while Watcher was on. `WatcherHistoryRefusal` forbids sending there, so "Send again" was impossible. `LimitRestart` now drops that record when a conversation becomes history and when saved history is read at startup. Active threads with an unknown reset keep the existing policy.

## Relation to #1962

Inspected [#1962](https://github.com/millZach/Sotto/pull/1962), head `1ded1c3b995cd2d1f6f7a05aea9fcd47f5a5d1ab`, still open at verification. Its three `control.ts` changes suppress automated "Steered", "Reconciled" and "Sent to" notice text. Its notification changes route clicks to Watcher's room. The added `threadNavigationDelivery.test.ts` cases assert `notice` stays unchanged for Watcher/move sends and still acknowledges a user's send. They do not exercise a thread title, summary or restart band.

It fixes a related notice leak but neither defect fixed here. This branch starts from the same main commit, needs none of #1962's changes and changes different `control.ts` lines. A merge-tree check against that head is recorded in the PR.

## Regression and checks

Before the first implementation edit, the focused new cases in `tests/unit/main/threadTitles.test.ts` failed **5/5**: internal-only current/history naming, the next visible exchange, and repair of current/history saved titles. The same command passed **5/5** after the fix:

```sh
NODE_OPTIONS=--no-experimental-webstorage npx vitest run tests/unit/main/threadTitles.test.ts -t 'internal Watcher news|internal-news|visible user exchange'
```

The two additional preservation cases keep a manually chosen matching title and a matching ordinary user prompt intact. The complete single file passed **27/27**.

Before editing `limitRestart.ts`, the new focused cases failed **3/3**: retirement with no reset, retirement with a known reset, and an unknown-reset history record read at startup. The identical command then passed **3/3**:

```sh
NODE_OPTIONS=--no-experimental-webstorage npx vitest run tests/unit/main/limitRestart.test.ts -t 'read-only history|earlier Watcher conversation'
```

The complete single file passed **18/18**. The Node option disables this machine's Node 25 experimental web-storage global for the test runner. No test was removed, skipped or weakened. Focused runs naturally filter the other tests; both complete files pass.

`npm ci --ignore-scripts` installed this worktree's dependencies. `npm run typecheck`, `npm run lint` and `git diff --check` all passed. The diff was reviewed against the report and the repository's rules: no new dependency, setting, schema, permission, host, UI string or renderer change.

## Not verified

No app launch, screenshot capture, Playwright, design capture/verification or full suite was run, per Drake's instructions. GitHub runs CI. The original SDK result/rate-limit frames and historical transport headers were unavailable; the retained native errors are the evidence above. No live data file was repaired during investigation; the persisted title and restart-record repairs take effect when this change runs.
