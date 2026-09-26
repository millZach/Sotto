# A settings chip press, to paint and to confirmed - September 26, 2026

Issue #319. The model and permissions chips used to show the provider's confirmed value only, so a press painted
nothing until the provider had answered and the window had drawn the answer, and every chip went dead in between.
Now a press paints at once and the provider's confirmation arrives behind it: for permissions as the pending mark and
its caption going, for model and effort as nothing at all. The two are measured separately below.

## Numbers

One press is one permission-mode change on the composer's chip, in the window's own React tree (jsdom) over the whole
host stack of `tests/fixtures/threadSettingsStack.ts`: the coordinator, the workspace, provider selection and the real
Claude or Codex adapter over the fake client the adapter contract uses, each a real child process, with the thread's
session running. Each figure is the median of six presses, and the range is across four runs on the same machine.

| Provider | Change | Press to painted selection | Press to main's reply | Press to confirmed on screen |
| --- | --- | ---: | ---: | ---: |
| Claude | in place (Allow edits and Ask for approval) | 2.7-3.2 ms | 13-15 ms | 39-40 ms |
| Claude | restart (Full access and Allow edits) | 2.3-2.6 ms | 105-112 ms | 122-128 ms |
| Codex | in place (Full access and Allow edits) | 2.3-2.5 ms | 17-18 ms | 41 ms |

- **Press to painted selection** is from the click on the option to React committing the chip with the new choice
  and its pending mark. The slowest single press in any run was 7 ms.
- **Press to main's reply** is when the `configure-thread` reply reached the window.
- **Press to confirmed on screen** is when the window drew the state carrying the provider's confirmation and let go
  of the press: the pending mark and caption went. This is also when the chip used to paint the new choice, since it
  showed only what the window had drawn, so it is the "before" figure for press to paint.

So on the fake clients a press now paints 14 to 50 times sooner than it did, and a Claude change into or out of Full
access, which starts Claude Code again, no longer holds the chip for its restart. With the real Claude Code that restart
is about 1.5 seconds (#317), which is the wait the pending mark now covers instead of a dead chip.

The step from reply to confirmed on screen, about 25 ms for an in-place change, is the window committing main's
broadcast as a transition. A reply that arrives before that broadcast is not drawn on its own (#306), so the press is
held until the broadcast commits; that is the window's own scheduling and the same for the old chips.

## What these numbers are and are not

- "Painted" is the frame React commits. jsdom lays nothing out and paints nothing, so a real window adds its own layout
  and paint to every column alike, and there is no IPC hop between window and main here. The provider times are the
  fake clients', with no model and no network; a real CLI takes longer, most of all Claude Code starting again.
- The timers are `performance.now()` around the press, main's reply and the store's release of the press. Nothing a
  thread says is read or reported.
- Taken on the Windows development machine (24 cores, Node v24.14.1) with nothing else running. Read them as sizes,
  not budgets.
- Grok and Devin were not timed. Their chips run the same code in the window; only the provider's side differs, and
  `docs/perf/2026-09-25-settings-light-path.md` covers that side.

## Re-run

```sh
SOTTO_PERF_BENCH=1 npx vitest run tests/perf/settingsPressToPaint.perf.test.tsx --maxWorkers=1 --disable-console-intercept
```

It is skipped without `SOTTO_PERF_BENCH=1`, because it starts real child processes and asserts no time. The behaviour
it times is pinned in the default run by `tests/unit/renderer/threadOptions.test.tsx` (a press shows at once; a refusal
puts it back and says so; two presses during one save send one more save for the last; the pending mark stays until the
window draws the confirmation) and `tests/unit/renderer/agentCommandLanes.test.tsx` (a prompt sent while a press is
pending reaches main at once and runs on the pressed mode).
