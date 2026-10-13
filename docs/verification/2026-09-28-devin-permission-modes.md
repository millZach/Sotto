# Devin permission modes — 2026-09-28

A new Devin thread on Bypass permissions failed its first prompt with "Native thread creation is not confirmed. Refresh its original provider; your prompt has not been sent." The report blamed some models. The cause was the permission setting.

## Reproduced cause

A probe spoke ACP straight to the installed Devin CLI 3000.10.31 in an empty folder. No prompt was sent, so no model ran.

- All 55 models Devin listed confirmed on `session/set_config_option`. None of them caused the failure.
- Setting the mode to `smart`, `plan` or `bypass` made Devin send a `current_mode_update` naming that mode and a `config_option_update`, both before its reply.
- The adapter failed any `current_mode_update` other than `accept-edits` as "Devin changed the session mode." That check predates the modes ADR-0022 offers. The failure closed the connection mid-creation, so Sotto reported creation as uncertain.

Smart, Plan, Ask and Bypass permissions all failed. Code and Ask first run Devin in `accept-edits`, so they worked.

## Against the native CLI

A temporary Vitest file drove `DevinAcpHost` against the installed CLI with Claude Opus 5.5 Medium and was deleted afterwards. It sent no prompts.

| Step | Before | After |
| --- | --- | --- |
| Create a thread on Ask first, Code | accepted | accepted |
| Create a thread on Smart | uncertain, thread in error | accepted |
| Create on Plan, Ask, Bypass permissions | not reached | accepted |
| Reopen all six after reconnecting | — | idle, mode kept |
| Move the Smart thread to Bypass, reopen it | — | idle, on Bypass |

## Against the fake Devin

`tests/fixtures/fakeDevinAgent.mjs` now announces a mode change the way the native CLI does. It also announces a restored session's saved mode on reopen, which the native CLI was not seen doing, because that is the harder case. `tests/integration/devinAdapter.test.ts` covers:

- Creating and sending on every mode Devin offers.
- Reopening a thread that has history after it moved from Smart to Bypass. A send made during the reopen goes out only after Bypass is set.
- Devin changing mode by itself, on a new thread and on a reopened one. The session still fails in both.

Before the fix, three tests failed on the fake that announces mode changes. With the fix, 48 passed and 6 were skipped.
