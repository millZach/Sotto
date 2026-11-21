# The desktop engine runs in its own process behind a thin Electron shell

## Status

Accepted November 20, 2026, behind the `out-of-process-engine` Owl feature (`sentToStable: false`, [ADR-0072](0072-sotto-owl-is-a-windows-preview-release-track.md)). Follows `docs/plans/2026-11-20-out-of-process-engine-and-rust-daemon.md`.

Amends [ADR-0203](0203-a-headless-host-makes-a-phones-picture-copies-in-a-worker.md) decision 5: the desktop's engine now makes phone picture copies and tile thumbnails in the same pure-Node picture worker rather than calling Electron's `nativeImage`. Extends [ADR-0098](0098-main-records-a-minute-of-itself-on-this-computer.md): when the engine runs in its own process, Sotto measures main and the engine separately.

## Context

In Electron, the main process runs on the same operating-system thread that receives keyboard and mouse input and dispatches it to the window. In the November 13–15, 2026 recordings of Sotto on the owner's laptop (`docs/perf/2026-11-15-laptop-main-window-and-freezes.md`), all ten recorded hangs (1.6 s to 12.5 s) were in Electron's main process and none were in the renderer window.

Moving only `createAgentRuntime` out of main would leave `DesktopHostRouter`, Watcher's remote bridges, `CouncilService`, plugins, checkpoints and `PhoneAccess` on the UI thread, forcing chatty bidirectional IPC across a dozen internal references while leaving router, plugin and checkpoint work where it can still stall input.

At the same time, Sotto wants a clean path to replace the Node backend with a Rust `sotto-host` (remote machines first, verified by `npm run test:referee`) and then a Rust `sotto-engine` (local desktop) without a feature freeze or lost desktop features.

## Decision

**1. One thin Electron shell, one Electron-free engine.** The desktop splits into two halves:

- **Thin Electron shell (`src/main/index.ts` and shell modules).** Owns only what needs Electron or operating-system UI access: windows (`BrowserWindow` for main, floating widget and popup), tray and menu bar owl, application menu, Glass transparency, desktop notifications, `powerMonitor`, `systemPreferences`, clipboard, native dialogs, `shell`, `autoUpdater`, dictation hotkeys and paste helpers, speech helpers (`parakeetHelper`, `coreMlEngine`), embedded Chromium and media surfaces (`BrowserService`, `CloudIphoneService` and its loopback `BrowserAgentServer`, `visualSandbox`, `threadMediaScheme`), `TerminalService` (`node-pty`, kept in the shell initially to bound the rollout), the `safeStorage` credential broker, and the `ipcMain` relay for `window.sotto`.
- **Desktop engine (`src/main/engine/`, zero `'electron'` imports).** Runs all Electron-free coordination together in one process so internal references stay direct: `createAgentRuntime` (coordinator, workspace, provider adapters, Watcher, SQLite and JSON stores, git and worktrees, delegation, thread and branch moves, check queue, continue, next prompts, main checkout, usage, provider sign-ins), `DesktopHostRouter`, `DesktopHosts`, `CouncilService`, `Teams`, `OwnServers`, plugins (`PluginToolServer`, `MeshyModels`, `ElevenLabsSounds`, `MailGrants`, copy and spending sync), `FilesService`, checkpoints, `GitChangesService`, `PhoneAccess`, `LocalApps`, `RequestDraftService`, `RetainedDraftStore`, and `ProductEvents`.

A unit test enforces that nothing under `src/main/engine/` imports `'electron'`.

**2. Native Rust UI and Tauri are out of scope.** Sotto keeps Electron as its desktop shell and React as its renderer. `window.sotto` does not break, and Sotto's embedded Chromium browser, test iPhone, cloud iPhone, sealed `<webview>` visuals and renderer `getUserMedia` microphone capture stay whole.

**3. Language-neutral process boundary (`EngineTransport`).** When `out-of-process-engine` is on, the shell launches the bundled engine (`out/engine/index.js`) as a child process and connects over a local named pipe (Windows) or Unix domain socket (macOS and Linux) authenticated with a per-launch random token, carrying length-prefixed JSON frames. It deliberately avoids Electron-only `MessagePort` so a Rust daemon can speak the exact same wire later.

- **Pass-through forwarding.** The shell forwards engine push and thread-detail payloads straight to `windows.sendToMain` without re-validating them through zod or cloning snapshots, protecting thread-switch latency.
- **Reverse-RPC from engine to shell.** The engine reaches OS and Electron surfaces through a small, typed `EngineShellBridge` (~10 verbs): opening external links, paths and folders, writing the clipboard, sealing and unsealing credentials through `safeStorage`, calling Electron's loopback `BrowserAgentServer`, coordinating terminal start locks and running-terminal checks, reading visuals for `visualSandbox`, sending notifications and window pushes, receiving window focus and visibility updates, and pushing a cached `FilesBinding` table to the shell so `BrowserService`, `CloudIphoneService` and `TerminalService` resolve thread folders locally without blocking round-trips.

**4. Engine-side picture resizing uses the pure-Node picture worker.** Tile thumbnails, phone picture edge copies and Meshy photo redraws in the engine run through the pure-Node `PictureMaker` worker (ADR-0203) instead of Electron's `nativeImage`, keeping the engine free of Electron imports.

**5. Lifecycle, recovery and separate performance recording.** Ordered shutdown runs through `registerHostQuitDrain` so stores flush, cloud iPhone sessions release, providers stop and no child engine is orphaned on crash. An unexpected engine exit surfaces a plain-word recovery notice rather than failing silently. Settings › Performance records Electron main and the engine independently (ADR-0098).

**6. Phased behind `out-of-process-engine`.** Stable continues running the extracted engine in-process until the out-of-process path is proven across Windows, macOS, Linux on Omarchy and the Playwright suite, when `sentToStable` flips to `true`.

## Baseline (November 20, 2026, commit `477a70004`)

Recorded before extracting `src/main/engine/` on Windows x64, Node 24.14.1:

- `tests/perf/ownerScaleWorkBudget.perf.test.ts`: 24 passed, 2 skipped (all counts within committed owner-scale budgets).
- `tests/e2e/main-freeze.spec.ts` (`SOTTO_PERF_BENCH=1`, `valid: true`, 230 padding threads + owner history + 40 remote threads):
  - Nothing streaming: main event-loop delay max 44.63 ms, mean 10.48 ms, p99 12.26 ms, 0 stalls >= 100 ms; keystrokes p50 9.6 ms, p95 14.2 ms, max 16.5 ms; 60.0 fps, 8.0 broadcasts/s.
  - 1 thread streaming: main event-loop delay max 18.92 ms, mean 10.77 ms, p99 17.15 ms, 0 stalls >= 100 ms; keystrokes p50 5.85 ms, p95 13.2 ms, max 25.7 ms; 59.8 fps, 18.9 broadcasts/s.
  - 3 threads streaming: main event-loop delay max 24.13 ms, mean 11.11 ms, p99 18.60 ms, 0 stalls >= 100 ms; keystrokes p50 7.85 ms, p95 11.9 ms, max 13.2 ms; 59.9 fps, 19.0 broadcasts/s, 1 window long task (55 ms).

## Consequences

- Extracting `src/main/engine/` in Phase 1 keeps all existing tests green in-process while enforcing the zero-Electron import rule and decoupling `BrowserService`, `CloudIphoneService` and `TerminalService` through the cached `FilesBinding` mirror.
- Running the engine out-of-process in Phase 2 removes coordinator, Watcher, router, store, plugin and adapter CPU bursts from Electron's UI/input thread without changing `window.sotto` or any renderer code.
- Any Rust `sotto-host` or `sotto-engine` built later plugs into the same `EngineTransport` wire protocol without touching the Electron shell or React renderer.
