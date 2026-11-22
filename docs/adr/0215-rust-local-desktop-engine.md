# Rust local desktop engine (`sotto-engine`)

## Status

Accepted November 21, 2026, behind the `rust-local-engine` Owl feature (`sentToStable: false`, [ADR-0072](0072-sotto-owl-is-a-windows-preview-release-track.md)). Implements Phase 4 of `docs/plans/2026-11-20-out-of-process-engine-and-rust-daemon.md`, building directly on [ADR-0210](0210-the-desktop-engine-runs-in-its-own-process.md) and [ADR-0214](0214-rust-sotto-host-for-remote-machines.md).

## Context

[ADR-0210](0210-the-desktop-engine-runs-in-its-own-process.md) separated Sotto's Electron desktop shell from its background coordinator and provider adapters across a language-neutral, length-prefixed JSON wire protocol (`EngineTransport`: Windows named pipe or POSIX Unix domain socket, authenticated by a per-launch 256-bit hex token). [ADR-0214](0214-rust-sotto-host-for-remote-machines.md) built `crates/sotto-core` with full SQLite store parity, workspace/coordinator ownership, all nine provider adapters, and native Git/file operations.

Because `EngineTransport` is already language-neutral and `crates/sotto-core` already owns the engine state machine, the local desktop engine can run natively in Rust without changing any Electron renderer code, preload channel, or on-disk file format.

## Decision

1. **Add `crates/sotto-engine` to the Cargo workspace.** `sotto-engine` is a standalone Rust binary (`publish = false`) built from `crates/sotto-core` with zero additional crate dependencies.
2. **Speak `EngineTransport` directly.** `crates/sotto-engine` connects to the shell's per-launch OS IPC endpoint (`--endpoint` / `SOTTO_ENGINE_ENDPOINT`, Windows named pipe or Unix domain socket), authenticates with `SOTTO_ENGINE_TOKEN` in its first 4-byte big-endian length-prefixed JSON `hello` frame (never logged), serves RPC requests (`req` → `res` / `res-chunk`), and pushes coalesced `shell` and `detail` broadcasts (`push`).
3. **Stage delivery behind `rust-local-engine` (`sentToStable: false`).** Owl desktop builds (`scripts/package-owl.mjs`) compile `sotto-engine` via `scripts/build-rust-engine.mjs`, bundle it into `resources/rust-engine/sotto-engine[.exe]` via `extraResources` (never inside `app.asar` and never in stable builds), and verify it with `--version` in `scripts/verify-packaged-resources.mjs`. On Owl startup (`createDesktopEngine.ts`), when `owlFeatures['rust-local-engine']` is enabled, Sotto launches `sotto-engine --accelerator` over `EngineTransport` (`src/main/engine/rustLocalEngineClient.ts`) in strictly read-only mode (no `engine.lock`, no `workspace.json` writes, zero split-brain with Node's `AgentControl`) to offload read-only SQLite thread-word search off the Node event loop, falling back transparently to TypeScript if the binary is absent or exits. The workspace asks it (`useThreadWordsAccelerator`) only after the writes a publish was holding have been posted and confirmed, and only while the store can be read. A store that cannot be read, or whose writes are held, answers nothing. The threads named are the ones this host lists, the same check the TypeScript read uses. With Keep local history off the file is not the record, and the search stays in memory. Full coordinator handoff remains gated behind future Owl promotion; stable builds ship and start nothing of it.

## Consequences

- Electron main remains a thin OS/UI shell while heavy provider I/O, JSONL parsing, SQLite writes, and Git reads move into multi-threaded native Rust.
- Remote hosts (`sotto-host`) and the local desktop engine (`sotto-engine`) share one `sotto-core` implementation and one set of on-disk formats.
