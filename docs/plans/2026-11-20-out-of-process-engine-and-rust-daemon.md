# Out-of-process engine first, then Rust daemon behind thin Electron

Recorded November 20, 2026.

## Goals and non-goals

- **Goal 1 (fast win):** Eliminate Sotto's Electron main-thread freezes by moving the backend engine out of Electron's main UI/input process into a dedicated local child process, gated behind an Owl feature (`out-of-process-engine` in `src/shared/owlFeatures.ts`).
- **Goal 2 (clean Rust path):** Make that process boundary language-neutral so a Rust `sotto-host` (remote machines first, verified by `npm run test:referee`) and then a Rust `sotto-engine` (local desktop) can replace the Node engine behind the same boundary without a feature freeze or lost desktop features.
- **Explicit non-goals:** No native Rust UI rewrite (GPUI/Slint), no Tauri/WebView2 swap, no feature freeze, no breaking changes to `window.sotto`, and no removal or weakening of Sotto's embedded Chromium Browser, Test iPhone, Cloud iPhone, sealed `<webview>` visuals, or renderer `getUserMedia` microphone capture.

## Why this split

In Electron, the main process runs on the same OS thread that receives Windows keyboard/mouse input and dispatches it to the window. In Sotto's November 13–15, 2026 laptop recordings (`docs/perf/2026-11-15-laptop-main-window-and-freezes.md`), all 10 recorded hangs (1.6 s to 12.5 s) were in Electron's main process—none were in the renderer window.

Cutting only around `localRuntime` (`createAgentRuntime`) would leave `DesktopHostRouter`, `Watcher` remote bridges, `CouncilService`, `Plugins`, `Checkpoints`, and `PhoneAccess` in Electron main, forcing bidirectional IPC across a dozen tight internal references while leaving router/plugin/checkpoint work on the UI thread.

Instead, the split puts the **entire Sotto engine** in one Electron-free process and leaves Electron main as a **thin desktop shell**:

### Thin Electron Shell (`src/main/index.ts` and shell modules)

Owns only what needs Electron or OS UI access:

- Windows (`BrowserWindow` for main, floating widget, and popup), `Tray` (animated Owl), `Menu`, `Glass`, `Notification`, `powerMonitor`, `systemPreferences`, `clipboard`, `dialog`, `shell`, `autoUpdater`.
- Dictation hotkeys (`key-listener`), paste (`outputService`), and speech helpers (`parakeetHelper` utility process, `coreMlEngine`).
- Embedded Chromium / media surfaces: `BrowserService`, `CloudIphoneService` (whose `BrowserAgentServer` is already a loopback HTTP JSON-RPC server), `visualSandbox` (`<webview>` + dead proxy), `threadMediaScheme`.
- `TerminalService` (`node-pty`) — kept in the shell initially to keep Phase 2 bounded; can move later.
- `safeStorage` credential broker and `ipcMain` relay for `window.sotto`.

### Local Engine Process (`src/main/engine/`, zero `'electron'` imports)

Runs all Electron-free coordination together in-process so internal wiring stays direct:

- `createAgentRuntime`: coordinator, workspace, all provider adapters, Watcher, SQLite/JSON stores, git/worktrees, delegation, thread/branch moves, check queue, continue, next prompts, main checkout, usage, provider sign-ins.
- `DesktopHostRouter` and `DesktopHosts` (SSH launcher, Tailscale, remote host WebSockets).
- `CouncilService`, `Teams`, `OwnServers`, `Plugins` (`PluginToolServer`, `MeshyModels`, `ElevenLabsSounds`, `MailGrants`, copy/spending sync), `FilesService`, `Checkpoints`, `GitChangesService`, `PhoneAccess`, `LocalApps`, `RequestDraftService`, `RetainedDraftStore`, `ProductEvents`.
- Picture resizing uses the pure-Node `PictureMaker` worker (ADR-0203) instead of Electron's `nativeImage`.

### Process boundary (`EngineTransport`)

- **Wire:** Length-prefixed frames over a local named pipe / Unix domain socket (or loopback socket with a per-launch random secret). Deliberately not Electron-only `MessagePort`, so a Rust daemon speaks the exact same wire in Phase 4.
- **Pass-through forwarding:** Electron main relays push/detail payloads from Engine to Renderer without re-running Zod validation or cloning whole snapshots, protecting thread-switch latency (#2733, #2737).
- **Reverse-RPC from Engine to Shell (~10 verbs):**
  1. `openExternal`, `openPath`, `revealInFolder`, `clipboardWrite`
  2. `credentials` broker (`safeStorage` seal/unseal — avoids credential migration risk in Phase 2 and Phase 4)
  3. `browserAgentServerUrl` (loopback HTTP URL of Electron's `BrowserAgentServer`)
  4. `terminal.acquireStart`, `terminal.hasRunning`, `terminal.endHost`
  5. `visual.read`, `visual.added` (for `visualSandbox`)
  6. `notify`, `sendToWindow(channel, payload)`
  7. `windowFocus` and `windowVisible` state pushes from Shell to Engine
  8. Cached `FilesBinding` table pushed to Shell so `BrowserService`, `CloudIphoneService`, and `TerminalService` resolve thread folders locally without blocking IPC round-trips

## Phased rollout

Every phase ships behind an Owl gate, leaves normal feature work unblocked, and stands on its own as a valid stop-point.

### Phase 0: ADR, Owl gate, and freeze baseline

- Add `out-of-process-engine` (`sentToStable: false`) to `src/shared/owlFeatures.ts` (ADR-0072).
- Write an ADR recording the Thin Shell / Engine boundary and confirming that native Rust UI and Tauri are out of scope.
- Record baseline numbers from `tests/e2e/main-freeze.spec.ts` and `tests/perf/ownerScaleWorkBudget.perf.test.ts` before moving anything.

### Phase 1: Extract the in-process engine seam (still in-process)

- Extract the engine wiring out of `src/main/index.ts` into `src/main/engine/` behind a single `createDesktopEngine(shellBridge)` entry point.
- Add a CI-enforced test verifying nothing under `src/main/engine/` imports `'electron'`.
- Wire the cached `FilesBinding` mirror for `BrowserService`, `CloudIphoneService`, and `TerminalService`, and switch engine-side image resizing to `PictureMaker`.
- Keep running in-process at the end of Phase 1 so all existing unit, integration, and Playwright tests stay green with zero behavioral change.

### Phase 2: Run the TypeScript engine out-of-process on Owl (kills Electron freezes)

- Bundle `out/engine/index.js` alongside `scripts/build-host.mjs` and launch it as a separate child process when `out-of-process-engine` is enabled.
- Implement `EngineTransport` (pipe/UDS/loopback + per-launch auth token + typed request/push framing + pass-through forwarding to `windows.sendToMain`).
- Wire lifecycle and diagnostics:
  - Ordered shutdown through `registerHostQuitDrain` (flush stores, release `cloudIphone`, stop providers, prevent orphaned child processes on crash).
  - Unexpected-exit detection with a plain-word recovery notice (never silent data loss).
  - Separate engine hang and CPU recording in Settings › Performance (ADR-0098) so Electron main stalls and engine stalls are measured independently.
- **Verification gate:**
  - `tests/e2e/main-freeze.spec.ts` shows Electron main-process stalls near zero under owner-scale streaming.
  - Playwright specs pass with `SOTTO_OWL_FEATURES=out-of-process-engine=1`.
  - Dogfood on Owl across Windows, macOS, and Omarchy; flip `sentToStable: true` once proven.

### Phase 3: Rust `sotto-host` for remote machines (`rust-remote-host` Owl flag)

- Add a Cargo workspace (`crates/sotto-core`, `crates/sotto-host`) in this repository with a shared `CARGO_TARGET_DIR`, a crate/license allow-list (`cargo deny`, matching ADR-0018), and CI jobs for Windows, macOS, and Linux.
- Implement host protocol v1 socket server, SQLite stores via `rusqlite` (opening existing `threads.sqlite`, `usage.sqlite`, `subagents.sqlite`, `memory.sqlite` in place with `PRAGMA recursive_triggers = ON`), coordinator/workspace, and adapters (Claude and Codex first, then the remaining providers).
- **Verification gate:**
  - Passes `npm run test:referee` and `socketHostContract`.
  - Shadow read-only run against a copy of forge's data matches the Node host frame for frame.
  - iPhone and Android clients connect without changes.
- Ship opt-in per remote host on Owl: the SSH launch script deploys a single static binary with no Node 24 requirement.

### Phase 4: Rust local engine (`sotto-engine`, `rust-local-engine` Owl flag)

- Layer the desktop-only engine services (`DesktopHostRouter`, `DesktopHosts`, `Watcher` master, `Council`, local `Plugins`, `Checkpoints`, `Files`/`GitChanges`, `PhoneAccess`/`LocalApps`) onto `sotto-core`, speaking the exact Phase 2 `EngineTransport` wire protocol.
- Flip the local engine binary from Node to Rust behind `rust-local-engine` on Owl—no changes to Electron shell or React renderer.
- Once proven on Owl across all three platforms and the Playwright suite, graduate to stable and retire the TypeScript engine, `src/host`, and JS-only copy/Zod guardrails (`copySites`, `zodSchemaSites`, `codeSizeBudget`).

### Phase 5 (optional, independent): Rust OS helpers

- Independently replace PowerShell-compiled `native/key-listener/win32.cs`, `native/key-listener/darwin.swift`, OS paste helpers, and `node-pty` (`portable-pty`) with Rust if maintenance or packaging warrants it.
- Keep renderer `getUserMedia` microphone capture unless a Rust capture path is measured at equal or better transcription quality without Chromium's echo cancellation, noise suppression, and automatic gain control.

## Key risks to watch

1. **Added hop latency on thread switches:** Phase 2 introduces `Engine → Electron main → Renderer`. Forwarding pre-encoded payloads without double Zod validation or extra cloning is required to avoid regressing `#2733`.
2. **Playwright specs that evaluate inside `main`:** ~113 specs inspect main directly. Keeping the in-process path as the stable default during Phase 2 and adding a thin test hook on the engine bridge keeps Playwright working in both modes.
3. **Claude session history (`claudeHistory.ts`) in Phases 3–4:** Today it invokes `@anthropic-ai/claude-agent-sdk` via Node to read and fork sessions. Rust will need either native Claude JSONL session parsing pinned by golden tests or a small optional fallback while Claude Code's session format evolves.
