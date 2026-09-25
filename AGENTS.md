# Sotto

Sotto is an Electron desktop app: a dictation tool that is becoming a voice development coordinator, driving Codex, Claude Code and Grok Build threads. This is a brief, not a specification. It names what is expensive to get wrong and leaves the rest to you. Where it does not reach, work out what Sotto would do from `CONTEXT.md`, the ADRs and the running app, and say in the PR what you worked out.

## What Sotto is

- **Private.** No analytics, no crash upload, no account. Dictation audio is never written to disk. Prompt text, transcripts, provider protocol bodies and keys never reach a log; adapters log stable event names only. The hosts Sotto contacts are the ones the README's "Privacy and cost" section names, each there for something the user asked for. A feature that would add a host, or send what the user said anywhere for any other reason, is an ADR and a README change before it is a patch.
- **The user answers every permission.** Authority lives only in policy records (ADR-0004). A memory, a repetition, an import or a provider's own confirmation is evidence, never a grant, and supervision may send follow-ups within its limits but approves nothing. A feature that would answer a request on the user's behalf is an ADR before it is a branch. The one standing exception is ADR-0029: by default a thread may open, navigate, click and type in Sotto's own browser without asking, until the user stops it for that thread or turns it off in Settings.
- **Threads are Sotto's.** Everything outside a provider adapter addresses a thread by its Sotto thread ID (ADR-0002). When you need the provider's own identifier, ask the adapter that owns it.
- **One key.** Main holds the OpenRouter key in the credential store (the `formatting` slot) and hands back only results. It pays for transcription, cleanup and OpenRouter-hosted reasoning (ADR-0006). Thread titles, branch names and commit and pull request drafts are not on it: each is a side call to the thread's own provider (ADR-0026). Asking for a second key is a product decision, the way the xAI reply voice got one.
- **Plain words.** A control's name says what a press does. An error says what happened, whether anything was lost and what to do next. Nothing announces itself unasked. Write UI copy and docs the way `CONTEXT.md` and `README.md` are written: short sentences, the glossary's nouns, no marketing, no error codes.
- **Windows first, Apple silicon macOS second.** CI, the design captures and the release procedure are built around those two. A third platform is unbudgeted rather than forbidden. It needs an ADR covering the release path, the runtime manifest and the design gate before a target goes into `electron-builder.yml`.

## Read first

- `CONTEXT.md` is the glossary and the nearest thing to a description of how Sotto thinks. Write in its terms. When the work gives Sotto an idea it has no word for, coin one and add the entry in the same PR; reusing a word that already means something else is the failure this rule exists to prevent.
- `docs/adr/` records decisions. Read the ones that touch your area before changing it. When a change contradicts one, say so in the PR and amend or supersede the ADR. `docs/agents/domain.md` has the rules.
- For anything a user sees, `README.md` for the overview and `docs/guide.md` for the detail. For threads and the coordinator, `docs/agent-control.md`.

## Where things are

Only what the tree does not say for itself.

- `src/main/agents/` is the coordinator (`control.ts`) and the three provider adapters (`claude.ts`, `codex.ts`, `grok.ts`). `src/main/ipc/registerIpc.ts` registers every channel.
- `src/renderer/src/agents/` is the Threads page: panes, composer, sidebar, pickers. `features/` holds the other pages, `state/` the app context and hooks, `widget/` the floating widget's own renderer.
- `src/host/` is the headless host entry, its socket server and the remote command allow-list. It runs under plain Node, is built on its own by `scripts/build-host.mjs`, and must never import Electron. `src/main/hosts/` is the desktop's side of remote hosts: saved hosts, the SSH launcher, the launch script it runs on the host machine, and the router that joins every connected host's threads.
- `src/shared/` is what both processes use: types, zod schemas, `settings.ts`, `channels.ts`, `themes/`. The renderer reaches main only through `src/preload/` (`window.sotto`).
- Tests live under `tests/`, never in `src/`: `unit/` mirrored by source area, `integration/` over real child processes and the fake providers in `fixtures/`, `e2e/` Playwright specs that launch the built app locally, `perf/` benchmarks. Every adapter passes `tests/integration/adapterContract.ts`.
- `docs/`: `adr/` decisions, `verification/` evidence notes, `perf/` measurements, `research/` source studies, `plans/` implementation plans, `ci.md`, `release/`, `agents/`. `artifacts/<slug>/` holds the screenshots and JSON a verification note cites: the images the note names or describes, not every intermediate capture. The folder is 190 MB of committed images and every clone downloads all of it.
- Archival, not authoritative: `design/` (including `design/archive/`, where the early notes and the memory-first prototype spec now live), `handoff/`, `.superpowers/`. Code, `CONTEXT.md` and ADRs win.

## Design direction

Sotto's look is quiet: one room under a thin strip, set in Figtree, dark by default, with colour coming from the chosen theme rather than the component (ADR-0011, and `CONTEXT.md` under Main window). Read those before proposing a look; the character is the part that is hard to get back. What every UI change keeps:

- Colour comes from a theme role through a `--tt-*` token. `themeTokens.test.ts` checks every stylesheet on its `owned` list for literals; a new stylesheet goes on that list.
- Light, dark and reduced motion all checked. Text meets 4.5:1 on the surface it sits on.
- Desktop-native: a window with a drag strip, a tray and a floating widget, not a page in a frame. Verify at 1600x1000, 1280x800 and the 820x560 minimum; nothing overflows or clips at the minimum.
- The whole app works from the keyboard, and the keyboard path is designed rather than inherited. Focus moves in the order the eye does, every control has an accessible name that says what a press does, anything that opens answers Escape, controls inside the drag strip opt out of dragging, and a new shortcut checks against the global dictation hotkey before it claims a chord.
- Voice and memory are gated for the beta (ADR-0012, ADR-0013). Anything that speaks, listens, manages a thread or reads memory asks the gate before it exists: `useVoiceCoordinatorEnabled()` or `useMemoryEnabled()` in the renderer, the setting read once at start in main, the snapshot's `voiceCoordinator` field in the widget. Gate it and leave it whole; the setting turning back on restores all of it, tests included.
- When the direction is not settled (a new surface, a restyle, anything with two good answers) build an HTML mock-up first, offer variants, and record the user's pick in the plan or ADR. An affordance added to a surface that already exists needs no mock-up. Load the `tastify` skill when it is available.

## Gotchas the code does not confess

- A new setting goes in `src/shared/settings.ts` (type, schema, default) and on the patch allow-list in `src/main/ipc/registerIpc.ts`. Miss the list and the toggle snaps back on save; `tests/integration/ipc.test.ts` catches it.
- The renderer has no network. Anything that fetches runs in main behind a preload bridge.
- Production dependencies are exactly `zod` and `node-pty` (the terminal, loaded on demand and kept external so its helper layout survives packaging; ADR-0018). Everything else is a devDependency or a Node builtin (`node:sqlite` is the memory store, `fetch` in main is the network). `scripts/release-external-dependencies.mjs` fails the release when another name appears and the test suite will not warn you first. A new runtime dependency is an ADR.
- Waiting is not the assertion. Test deadlines are generous on purpose (`vitest.config.ts`, `docs/ci.md`), and a deadline that is never reached costs nothing. A slow suite is slow because of real sleeps, real child processes and repeated setup, so that is where to make it faster. A test that needs a lost acknowledgement scripts one instead of shortening a deadline. Stopwatch budgets are opt-in through `SOTTO_PERF_ASSERT=1`; live provider suites are gated by `SOTTO_*_LIVE` and never run in CI.
- `npm run design:verify` compares captures against committed baselines. Regenerate with `npm run design:capture` only when the look changed on purpose, and say so in the PR.
- Worktrees go under `.worktrees/` or `.claude/worktrees/`, and a new generated `artifacts/` folder gets a line in `.gitignore` and `eslint.config.mjs`. Anywhere else, lint and the suite go red on the copies.
- Never link `node_modules` into a throwaway worktree on Windows. `git worktree remove --force` and `rm -rf` both follow a junction and empty the real folder; it happened while reproducing a failure on `main` and cost a full reinstall. Run `npm ci` in the worktree, or use `git stash` in place.
- A worktree you made is yours to remove. When the work is merged or abandoned, `git worktree remove <path>` it (the branch stays); a checkout with `node_modules` is 1.4 GB, and 160 of them once held 107 GB on the development machine (ADR-0019). Never make a worktree inside a thread's own worktree under `%APPDATA%\sotto\thread-worktrees`; make it under the repository's `.worktrees/` and remove it the same way.
- New threads share the project checkout by default (ADR-0014). An explicitly new worktree starts on first send with a short `sotto/<token>` branch; generated naming may replace only that temporary branch, and a user or agent branch change wins. Worktree-backed threads follow their checkout without a branch notice; the notice belongs to shared project folders. Existing sessions keep their folders. Missing owned worktrees are restored on their recorded branch when possible; moved, replaced, locked, or occupied checkouts are refused without removing work.
- Files are UTF-8 without a byte order mark. A BOM has broken the build before.

## Before opening a pull request

Run CI's gates (`docs/ci.md`). The worker cap matches the runner, so a local pass means what a CI pass means; run them however is fastest while working, and in this form before you call them green.

```sh
npm run typecheck
npm run lint
npm test -- --maxWorkers=2
npm run notices:verify
```

Then the Playwright specs that touch the changed surface (`npm run build && npx playwright test tests/e2e/<spec>`), and a two-axis review of the diff: once for standards against this file, once for spec against the issue. The `/code-review` skill does both where it is available. Fix every finding you can and name the ones you could not.

These documents are how Sotto remembers itself, so a change that makes one wrong fixes it in the same PR: `CONTEXT.md` when a term is new or has moved, an ADR when you decided something rather than followed something, `README.md` and `docs/guide.md` for anything a user sees, `docs/ci.md` for a gate, and a note in `docs/verification/` with its screenshots in `artifacts/<slug>/` when you proved the work in the running app.

## Commits

- Subject: one plain-English sentence in the imperative, short enough to take in at a glance. "Let a thread name itself from its first exchange", not "feat(threads): auto title". No type prefix, no trailing period.
- Body: prose paragraphs on what changed and why, for someone reading `git log` in a year. Skip it only when the subject is the whole story.
- One commit per coherent change. Review fixes after the PR opens are their own commits, with subjects that say what they fix.

## Branches and pull requests

- Branch from `main` as `feat/`, `fix/`, `chore/`, `perf/`, `test/` or `prototype/` plus a short slug (`fix/ci-fixture-deadlines`). One PR closes one issue or one explicit batch of issues.
- Title: the commit subject, or one sentence covering the batch. Body: the template in `docs/agents/pull-requests.md`.
- CI (`Gates (Windows)`) is green before merge, and a red gate is fixed at its cause. Merges into `main` are merge commits; release commits are `Release X.Y.Z` on `main`.
- Once the PR merges, delete its branch on GitHub (`git push origin --delete <branch>`). Its commits are in `main` and the PR keeps the history; a branch with work `main` does not have stays.

## Issues and releases

Issues are GitHub Issues on `millZach/Sotto` through `gh`: `docs/agents/issue-tracker.md`, with the triage labels in `docs/agents/triage-labels.md`.

Releases are cut by hand on the Windows PC and the Apple silicon Mac and published to `millZach/Sotto-releases`. The procedure is `docs/release/releasing.md`; read it before touching `electron-builder.yml`, the `package:*` scripts or the version.
