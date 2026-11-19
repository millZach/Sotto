# A Windows Hermes thread on your own model server starts in a new project — November 18, 2026

Issue #2684. On the laptop (Windows 11, Hermes Agent 0.23.2 from its official installer), a new Hermes thread on
Obsidian (`deepseek-v4.1-flash`, a keyless own model server) failed its first message with *Native thread creation is
not confirmed*. Screenshots are in `artifacts/hermes-windows-own-server-first-send/`.

## What the user's failure showed

- `turns.jsonl`: the `manual-send` ran 60.5 s and ended `provider-failed`. The creation record stayed at `starting`,
  and `hermes-threads.json` kept the thread with no Hermes session ID. Both Hermes threads made on the laptop were
  like this, each the first in its project.
- Hermes's log for the new project profile: ACP connection accepted at 21:52:42.8, the thread's seven tool servers
  registered by 21:52:45. Its `state.db` has the session, created at 21:52:44.6. Nothing more until Sotto closed the
  connection at 21:53:12.3, Sotto's 30 seconds after `session/new`.
- The server answers `/v1/models` in 0.19 s.

## Where Hermes stops

`hermes acp` was run outside Sotto against a fresh project profile with the same overlay, with a Python stack dump
after 20 s. `initialize` answered in 3.7 s and `session/new` never answered in 90 s. The stack is the one the
[16 November note](2026-11-16-hermes-windows-linux.md) found: `build_model_state` → `get_curated_nous_models` →
`hermes_user_agent` → `get_version_info` → `subprocess.run(["git", "rev-parse", "HEAD"], timeout=3)`, still in
`communicate()`. A `git.exe rev-parse HEAD` left from an earlier run had been hung for 32 hours with its parent gone.
The same command in a shell answers in 0.13 s. Writing another line to the ACP process's stdin did not release it.

With the fallback #2677 added for ChatGPT models (`build_model_state` returns only the current model), the same fresh
profile answered `session/new` in 4.2 s. That fallback was applied only to ChatGPT models, so own-server threads took
the stock path. It now applies to every Hermes process on Windows.

## The running app

A build of this branch ran from `out/main/index.js` on a throwaway profile (`--user-data-dir`), driven by Playwright
through `window.sotto.agents`, the commands the composer sends: connect Hermes, add a new project folder, start a
thread on Obsidian and send "Hello. Reply with one short sentence." The installed Sotto was not restarted.

| Build | Fresh projects | Result |
| --- | --- | --- |
| `main`'s Hermes code | 1 | *Native thread creation is not confirmed* after 34.4 s (`windows-main-not-confirmed.png`) |
| This branch | 3 | Replied each time, the turn ending 26.2 s after Send on a cold gateway and 12.2 s warm (`windows-fresh-project-reply.png`) |

## Focused checks

- `npx vitest run tests/unit/main/hermesEnvironment.test.ts tests/unit/main/hermes.test.ts`: 29 passed.
- `npm run typecheck` and `npx eslint` on the changed files passed.

These ran on Node 24.14.1, not the pinned 24.22.1. The full suite was left to GitHub CI.

## Not checked here

- A thread that already failed this way still fails on Retry. Sotto saved it without a session ID and does not create
  a session twice. Start a new thread.
- macOS and Linux are unchanged and were not rerun.
