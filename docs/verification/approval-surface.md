# Approvals and questions reach the user again

September 21, 2026. Reported in conversation: "the approvals don't actually pop up for me to approve," and separately "when the model has a question, it kind of just asks the question and keeps on working, but I never actually see the question pop up." Two reports, one cause.

## Result

Claude Code threads had no approval surface. The adapter launched the CLI with `--permission-mode <mode> --permission-prompts host`, and in Claude Code 2.1.278 the second flag only says prompts are not force-denied; `--permission-prompt-tool stdio` is what makes the launching process the thing that answers them. Without it the CLI resolves anything that needed a person with its own denial and omits `AskUserQuestion` from the session's tool list, so the model has no structured way to ask and writes its question into the reply instead. The thread keeps working the whole time, which is why this read as two unrelated faults.

Sotto now passes both flags in every runtime mode, `full-access` included. A session whose tool list arrives without `AskUserQuestion` puts a plain-words error on the provider rather than letting the silence stand. Codex and Grok were probed and found healthy, but both answered an unrecognised request with a bare JSON-RPC `-32601` that nobody saw and that the provider reads as the user declining; a request whose method says only a person can answer it, on a known thread, now surfaces an error there as well. See ADR-0021.

## Evidence

- **The cause, measured directly.** The adapter's exact launch was replayed against the installed Claude Code 2.1.278, with and without `--permission-prompt-tool stdio`. Without it: no `can_use_tool` control request for a Write, the CLI denying it locally, and `AskUserQuestion` absent from `system/init`. With it: `{"subtype":"can_use_tool","tool_name":"Write",...}` arrives and `AskUserQuestion` is present. Checked in both `default` (approval-required) and `auto` permission modes, which covers the modes the reporter's threads use. All four modes were also confirmed to launch cleanly with the added flag.
- **The fix, in the running app.** `tests/e2e/approval-surface-live.spec.ts` (opt-in, `SOTTO_APPROVAL_SURFACE_LIVE=1`) creates a real Claude Code thread set to Ask for approval, sends a prompt needing a Write, and then a prompt asking the question tool. Both reached the window. Passed against Claude Code 2.1.278 on Sonnet.
  - `artifacts/approval-surface/claude-permission-reaches-the-user.png` — the Write request with its tool input, **Allow once** and **Deny**, and the composer saying "Allow or deny the request above to continue."
  - `artifacts/approval-surface/claude-question-reaches-the-user.png` — "Which cache should we use?" with the provider's stacked choices and descriptions, **Write my own answer**, and **Send answer**.
- **Grok, live.** Grok CLI 1.0.40 over ACP sends `session/request_permission` with the option shapes the adapter expects, and `_x.ai/ask_user_question` with its parameters directly under the underscored method rather than in the older envelope. Both map correctly; the fixture now covers the unenveloped shape too.
- **Codex, statically.** Every request method the adapter listens for (`item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval`, `item/tool/requestUserInput`, `mcpServer/elicitation/request`) is present in the installed 0.155.1 app-server. The end-to-end turn could not be run: the account's usage limit was reached. `thread/start` already refuses to proceed unless Codex echoes back the approval policy it was asked for, which remains the standing check there.
- **Regression cover.** `tests/fixtures/fakeClaudeThread.mjs` refuses to start a coding thread without both permission flags, and reports a session tool list so the missing-surface error can be driven. Integration tests assert the surface argument for all four runtime modes, the error when a session offers no question tool, and the quiet path when it does. Grok and Codex tests cover the renamed person-shaped request and the requests Sotto is never meant to answer. Each was confirmed to fail with its fix removed.

## Checks

- `npm run typecheck`, `npm run lint`, `npm run notices:verify` (174 components): clean.
- `npm test -- --maxWorkers=2`: 4,333 passed, 37 skipped, 1 failed — `tests/perf/longTranscript.perf.test.tsx`, which reports the same `drawnAtOpen: 64, drawnWhenExpanded: 55` on the unmodified tree and touches no code in this change. Pre-existing on this machine; CI is green on `main` for the same file.
- `npm run build`, then `npx playwright test` over `phase-three-requests`, `phase-three-personal-requests`, `request-draft-restart`, `request-draft-recovery`: 16 passed.
- Design baselines were not regenerated; the request surfaces render as before, they now receive requests. The two committed captures are new feature evidence.
