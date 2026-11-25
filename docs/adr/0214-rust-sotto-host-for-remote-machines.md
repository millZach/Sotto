# Rust `sotto-host` for remote machines

## Status

Accepted November 20, 2026, behind the `rust-remote-host` Owl feature (`sentToStable: false`, [ADR-0072](0072-sotto-owl-is-a-windows-preview-release-track.md)). Follows Phase 3 of `docs/plans/2026-11-20-out-of-process-engine-and-rust-daemon.md` and builds on [ADR-0210](0210-the-desktop-engine-runs-in-its-own-process.md).

Extends [ADR-0018](0018-native-pty-lifecycle-and-packaging.md)'s dependency discipline to the Rust workspace through `deny.toml`. Leaves host protocol version 1 ([ADR-0025](0025-headless-host-and-client-identity.md)) and all on-disk SQLite and JSON stores unchanged.

## Context

Remote headless hosts (`src/host/`) currently ship a ~7 MB JavaScript bundle that requires Node 24 on the remote machine, holds ~500 MB of working set under owner-scale thread counts on forge, and shares one V8 thread across JSONL parsing, WebSocket framing, SQLite reads, and provider orchestration.

Phases 1 and 2 (ADR-0210) isolated the desktop engine behind a thin Electron shell without freezing features or dropping desktop capabilities. Phase 3 starts replacing the headless host first—as a standalone Rust binary (`sotto-host`) in this repository—where `npm run test:referee` (`docs/verification/2026-11-19-referee-harness.md`) already acts as a language-neutral black-box oracle against the TypeScript host.

## Decision

**1. One Cargo workspace in this repository.** Rust code lives under `crates/` in a single workspace (`Cargo.toml` at the repository root), outside npm the same way `apps/ios/` and `apps/android/` are:

- `crates/sotto-core`: host identity (`host.json`), single-instance lock (`host-listener.lock`), pairing and signed sessions (`paired-clients.json`), SQLite store readers/writers (`threads.sqlite`, `subagents.sqlite`, `usage.sqlite`, `memory.sqlite`), host protocol version 1 types, and (in later Phase 3 PRs) coordinator, workspace, and provider adapters.
- `crates/sotto-host`: the headless host executable implementing CLI parsing (`--data`, `--port`, `--key-file`), atomic listener descriptor publication (`host-listener.json`), HTTP/1.1 routes (`/v1/health`, `/v1/pair`, `/v1/session`, `/v1/revoke`, `/v1/admin/*`), and RFC 6455 WebSocket + RFC 7692 `permessage-deflate` framing.

Developers and worktrees should point `CARGO_TARGET_DIR` at one shared folder outside `.worktrees/` to avoid duplicating Rust build artifacts across worktrees (matching ADR-0041's disk discipline). `/target/` is gitignored and ignored by ESLint.

**2. Same files on disk, both ways.** `sotto-core` opens Sotto's existing `threads.sqlite`, `subagents.sqlite`, `usage.sqlite`, and `memory.sqlite` files in place using `rusqlite` with bundled SQLite (including FTS5) and sets `PRAGMA recursive_triggers = ON` on every connection so trigger semantics match Node's `node:sqlite`. Neither a migration nor a separate database format is introduced; users can move back and forth between the TypeScript host and the Rust host over the same data folder.

**3. Strict crate and license policy (`deny.toml`).** Every Rust dependency is checked against `deny.toml`, allowing only permissive licenses (MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, Zlib, Unicode-3.0, CDLA-Permissive-2.0) and forbidding copyleft crates (GPL, AGPL, LGPL). No prompt text, transcript, provider protocol body, or secret ever reaches a log.

**4. The TypeScript host stays the referee.** `sotto-host` ships opt-in per remote host behind `rust-remote-host` on Owl. No feature freeze is imposed: TypeScript host changes keep landing normally, and `sotto-host` is held to `npm run test:referee` and `socketHostContract` before replacing the Node host on any machine.

**5. Cross-platform Rust CI and opt-in release packaging.** `.github/workflows/ci.yml` runs `cargo clippy --workspace --all-targets --locked -- -D warnings`, `cargo test --workspace --locked`, and the cross-language parity suites (`rustHostFoundation.test.ts`, `rustHostProviders.test.ts`, `rustHostAllProviders.test.ts`, `rustHostLaunchScript.test.ts`) on Windows, macOS, and Linux whenever Rust host files change (plus `cargo-deny check licenses bans sources` on Linux). `.github/workflows/rust-host-release.yml` and `scripts/build-rust-host.mjs` package stripped release binaries with SHA-256 checksums, and `src/main/hosts/launchScript.ts` launches `host/sotto-host` only when explicitly opted in via `useRustHost: true` (leaving the Node host unchanged by default).

## Consequences

- Remote hosts gain a path to a single static binary with no Node 24 requirement and true multi-threaded I/O and parsing.
- iPhone and Android clients keep speaking host protocol version 1 without changes.
- Phase 4 (`sotto-engine`) builds directly on `crates/sotto-core` and plugs into ADR-0210's `EngineTransport` wire protocol.

## Amendment, November 24, 2026: per-host opt-in, built (#2874)

Decision 4 said opt-in per remote host, but Owl shipped it as opt-in per desktop: every SSH launch from an Owl desktop sent `useRustHost: true`, so every remote host ran `sotto-host` on its next start. On forge that host refused about 50 remote commands it does not implement, held 888 MB RSS against a 628 MB `threads.sqlite`, and left one thread with 2,001 activity rows, which Node's store then refused on every save. Choosing Node again did not help either, because a launch either named Rust or named nothing, and naming nothing keeps the host's `use-rust-host` marker.

What changed:

- **The host program is chosen host by host.** Each saved remote host has a **host program**: Node unless the owner picks Rust on that host's row in Settings > Hosts & phones, in a Node | Rust control (Zach's pick among three prototypes: on the row, one press, no confirm). The choice is saved with the host in `remote-hosts.json` (`runtime`) and kept across Owl updates. `rust-remote-host` stays an Owl feature with `sentToStable: false`, and now gates only that control and the program each launch names.
- **Every launch from an Owl desktop names the program.** Launch, boot changes and updates, over SSH or the socket, send `useRustHost: true` or `false`. `false` clears the marker, and a detached host Sotto started that runs the other program is stopped and started on the one named, the way the boot unit already was. A desktop with no choice to make, such as stable, names nothing, and the host keeps what it has. A launch reports the program the host runs (`runtime`) where the system can say (Linux and macOS), for the row to show.
- **A switch restarts the host now** when Sotto started it and this computer is connected: the desktop stops it and connects again over SSH, and that launch starts the program chosen. Any other host takes the choice at its next start, and the row says so.
- **Both engines keep a thread's newest 2,000 activity records.** Rust writes keep at most `MAX_AGENT_ACTIVITIES` rows per thread, each at its own position, and Node reads and saves a longer list as its newest 2,000 instead of throwing. `tests/integration/rustHostActivityCap.test.ts` opens a database Rust wrote in Node's store.

Rust becomes the default on Owl only after the five gates in `docs/plans/2026-11-24-rust-remote-host-cutover-readiness.md` pass.
