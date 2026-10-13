# Claude settings on a running session, against the installed CLI

Evidence for issue #317 and the September 25 amendment to `docs/adr/0023-working-reads-the-providers-agent-tasks.md`. Windows 11, 2026-09-25. **Claude Code 2.1.283**, the installed and signed-in client (`claude --version`), with the Agent SDK types pinned at 0.3.270.

The check is `tests/integration/claudeSettingsLive.test.ts`, run with `SOTTO_CLAUDE_LIVE=1`. It makes a synthetic project in a temporary folder, creates one thread, which starts its CLI, and then changes the thread's effort, model and permission mode through the adapter, the way a chip press does. It sends no prompt and runs no model turn. After each change it asks the CLI what it will use for its next request (`get_settings`, whose `applied` field reports `effort` and `model`), and it listens for the permission mode the CLI reports on its own system frames. It printed the CLI version, the IDs of the models it moved between, whether each value matched and the timings; no prompt, reply or key.

## What the CLI did

| Request | Answer | Read back |
| --- | --- | --- |
| `apply_flag_settings` with `effortLevel` | success | `applied.effort` matched the level sent |
| `set_model` | success | `applied.model` changed to the model sent |
| `apply_flag_settings` sent with the model change, carrying the thread's effort | success | `applied.effort` still matched after the model change |
| `set_permission_mode` to `acceptEdits`, and back to `default` | success | a system frame reported `permissionMode: acceptEdits`; `get_settings` does not report the mode |

These runs predate a review fix. A model change that names no level now clears the old one (`effortLevel: null`), as a Codex model change takes the new model's default, instead of carrying the thread's level, and the check now reports that read-back as `kept` or `cleared`. The check was run again on the finished branch, on Claude Code 2.1.283: 1 passed, 6.7 s. All three requests were acknowledged, the model moved from `claude-opus-5-5` to `claude-fable-5-1`, the effort read back as `cleared` after the model change, and each change stayed on one process. Press to accepted was 166 ms for effort, 668 ms for the model and 5 ms for the permission mode, against 1,446 ms to stop and start again.

Every change reached the process that was already running: the adapter's runtime for the thread was the same object before and after, and every change logged `claude-settings-applied-live`.

Two things the run found:

- **`default` and `opus` are the same model here.** The catalog lists both, and `set_model` from one to the other left `applied.model` at `claude-opus-5-5`. The check now moves on through the catalog until the CLI reports a different model; on this account that was the second press, to `claude-fable-5-1`.
- **A real model change takes longer than the others.** Moving to `claude-fable-5-1` took 670 to 820 ms from press to accepted, against about 80 to 100 ms for the alias that named the same model. Sotto's own part of a press is a few milliseconds, as the permission-mode presses show, so the rest is the CLI answering. It is still about half the restart it replaces.

## Timings

Four runs. The first two changed the model between two names for the same model; the last two reached a different one. "Stop and start again" is the old path on a running session: the adapter stops the thread's CLI, then a settings change starts it again. "Start only" is the second half of that, the path a thread with no running CLI still takes.

| Run | Effort | Model | Permission mode | Mode back | Stop and start again | Start only |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 52 ms | 97 ms (same model) | 33 ms | 6 ms | 1,593 ms | 1,053 ms |
| 2 | 61 ms | 80 ms (same model) | 33 ms | 4 ms | 1,551 ms | 1,010 ms |
| 3 | 91 ms | 668 ms | 5 ms | 4 ms | 1,581 ms | 1,049 ms |
| 4 | 142 ms | 823 ms | 5 ms | 4 ms | 1,301 ms | 771 ms |

These are single presses on the development machine while other agents' test suites were running on it, so read them as sizes. They are press to adapter accepted, not press to the chip settling in the window.

## What this does not cover

- Full access. Entering or leaving it still starts the CLI again, by design, and the live check does not launch a CLI with bypassing allowed.
- A refused or lost answer. The installed CLI refused nothing it was sent, so those paths are proved against the scripted CLI in `tests/integration/claudeSettings.test.ts` and the adapter contract, not here.
- Background work. The live check runs no turn, so it starts no agent; applying a change while one runs is proved against the scripted CLI.
- macOS. Run on Windows only.

## Re-run

```powershell
$env:SOTTO_CLAUDE_LIVE = '1'
npx vitest run tests/integration/claudeSettingsLive.test.ts --maxWorkers=1 --disable-console-intercept
```
