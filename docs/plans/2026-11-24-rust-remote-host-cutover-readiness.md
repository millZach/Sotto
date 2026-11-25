# Rust remote host cutover readiness

November 24, 2026. Tracking issue: [#2874](https://github.com/millZach/Sotto/issues/2874). Decision record: [ADR-0214](../adr/0214-rust-sotto-host-for-remote-machines.md) and its November 24 amendment.

## Why this plan exists

Owl turned the Rust `sotto-host` on for every remote host at once, though ADR-0214 decision 4 says it is opt-in per host and replaces Node only after it passes Node's suites. On forge it:

- refused about 50 commands it does not implement, with `InvalidRequest`;
- held 888 MB RSS at startup against a 628 MB `threads.sqlite`, where Node runs at about 500 MB;
- left one thread with 2,001 activity rows. Node's store then threw `Too many thread activities` on every save of that thread, after the switch back to Node;
- stripped all 208 Claude records in `claude-threads.json` down to six fields. On the rollback, Node refused the file, set it aside as `.corrupt-*` and started with none, so every Claude thread on forge lost its resume ("thread doesn't exist anymore").

Rust becomes the default **host program** on Owl only after all five gates below pass, in order. A gate is passed when its "done when" is true on `main` with CI green. Nobody's sense that it is ready counts. Nothing here changes stable: `rust-remote-host` stays `sentToStable: false` throughout.

## Gate 0: opt-in per host, off by default, one-press rollback

Built in #2874's pull request.

- Each saved remote host runs Node unless the owner picks Rust in its row's **Host program** control (Node | Rust). Only Owl shows the control. The choice is saved per host in `remote-hosts.json` and kept across Owl updates.
- The row shows the program chosen, marks Rust as a preview, and says when the host runs the other program until its next start. The program the host runs comes from its launch (Linux and macOS).
- One press switches back. For a host Sotto started that this computer is connected to, the press restarts it on Node, and that launch clears `use-rust-host`. Any other host clears it at its next launch from an Owl desktop.
- Every launch, boot change and update from an Owl desktop names the program: `useRustHost: true` or `false`. Stable names none and leaves the host as it is.
- Both host programs keep a thread's newest 2,000 activity records (`MAX_AGENT_ACTIVITIES`). Node reads and saves a longer list as its newest records instead of throwing. Rust writes at most 2,000 rows per thread, each at its own position. `tests/integration/rustHostActivityCap.test.ts` opens a database Rust wrote in Node's store.
- Every Rust provider store keeps what Node wrote: Claude, Codex, Muse, OpenCode, and the ACP stores for Grok, Devin, Cursor, Antigravity and Hermes. Each record keeps the fields Rust does not model, and an entry Rust cannot read stays on disk as it was. A store that is not a JSON object is moved aside as `.corrupt-*`, as Node does, never overwritten. `tests/integration/rustHostThreadStoreRollback.test.ts` checks all nine with Node's own parsers before and after a Rust load and save.
- The host's hello names its program (`hostProgram`), so the row knows what runs over the tailnet too. A host Sotto started that runs the other program offers **Restart on Node** or **Restart on Rust**.

**Done when:** the pull request for #2874 is merged and CI is green.

## Gate 1: command, hello and storage parity, with rollback safety

Issues: [#2876](https://github.com/millZach/Sotto/issues/2876) (commands and hello) and [#2880](https://github.com/millZach/Sotto/issues/2880) (storage and rollback).

- `coordinator.rs::dispatch_command()` handles every `REMOTE_COMMANDS` entry (`src/host/remoteCommands.ts`) and every v1 remote operation, with Node's behaviour. A rough name match on November 24 found 32 of 46 `REMOTE_COMMANDS` entries with no match.
- The Rust hello lists the same `features` and capabilities as Node's for the same data folder.
- **Rolling back to Node never loses or quarantines anything.** Every JSON store both hosts write survives Node → Rust → Node: the provider stores, which Gate 0 covers, and also `workspace.json`'s per-thread snapshot, `threads.json`'s bindings, `councils.json`, the plugin stores, `checkpoints.json`, `paired-clients.json` and `phone-access.json`. A record Rust creates passes Node's schema for its store, since today a thread started on Rust lacks `projectId`, `title` and `createdAt` and would make Node refuse the whole file. Node reads each provider store entry by entry, so an unreadable entry costs only itself. Claude's Rust-only `started` no longer turns a Node-created thread into a fresh session.

Storage and rollback (#2880) is built in its pull request; see ADR-0214's November 25 amendment. Commands and hello (#2876) are next.

**Done when:** a CI test fails on any command with no Rust handler, or a handler that is only an `InvalidRequest` stub, and on any hello feature difference; the test shows 0 of each. Every shared JSON store has a Node → Rust → Node round-trip test in CI, like `rustHostThreadStoreRollback.test.ts`, and a record Rust creates passes Node's schema.

## Gate 2: Node's black-box suites pass against Rust

Issue: [#2878](https://github.com/millZach/Sotto/issues/2878).

- `npm run test:referee`, `socketHostContract` and `hostServiceContract`, the remote drafts and reconnect suites, Watcher's remote-host tests, and the E2E specs that drive a remote host all run against the Rust `sotto-host` in CI.
- SQLite round trips across the two host programs (Node writes, Rust reads and writes, Node reads) cover `threads.sqlite`, `subagents.sqlite`, `usage.sqlite` and `memory.sqlite`.

**Done when:** all of them pass against Rust in CI on Linux and macOS, and Windows wherever the suite runs on Windows today.

## Gate 3: owner-scale memory and stability

Issue: [#2877](https://github.com/millZach/Sotto/issues/2877).

- A repeatable benchmark on an owner-scale data folder (about 600 MB `threads.sqlite`, the owner's thread count) measures RSS at idle and after a reconnect storm, for Node and for Rust on the same data.
- The likely cause of the 888 MB is that the coordinator reads every thread's messages and activities at start. Node reads them on demand (#918).

**Done when:** Rust RSS is strictly lower than Node's, under 150 MB idle as the target, with zero reconnect churn over the run. The numbers are in `docs/perf/`.

## Gate 4: canary soak, then forge, then the default

No issue until Gates 1–3 pass.

1. **Isolated canary.** Clone forge's `~/.sotto` into a separate data folder, and run Rust on it on its own port, never the real one. Run a working day of real threads through it from an Owl desktop, and check the row, Watcher and the iPhone.
2. **forge opt-in.** Only then pick Rust on forge's row, and soak for several days of normal use. Watch for refused commands, memory over Node's, reconnects, and any store state Node refuses after a switch back.
3. **Owl default.** After a clean multi-day soak, an ADR amendment changes what a host nobody chose for runs on Owl. The Node | Rust control and the one-press rollback stay. Stable is a separate decision, made later.

**Done when:** the canary and the forge soak each have a verification note in `docs/verification/` with no open defects, and the default change has its ADR amendment.
