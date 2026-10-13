# Phase 3 main-process tools verification

Verified September 13, 2026 in `D:/Talk to Text Application/.worktrees/phase3-tools`, based on `bf500b4`. Scope: backend/main, IPC, preload, schemas, native dependency packaging. Renderer implementation and integrated product visual acceptance belong to the parallel renderer/integration workers.

## Delivered

- `window.sotto.terminal`: real node-pty sessions with input/output, resize, Ctrl+C, exit status, multiple retained processes, bounded sequenced ANSI scrollback, close and explicit reopen. Disk stores metadata for at most 32 sessions. Previously running records recover as `interrupted`; no process or scrollback resumption is claimed. Windows uses Windows PowerShell `-NoLogo`; macOS uses the user's `SHELL` or `/bin/zsh`, with login-shell arguments.
- `window.sotto.browser`: isolated main-owned Electron `WebContentsView` pages; navigate/back/forward/reload, canonical URL and title, explicit unavailable state, retained DOM state while detached, ordered mounting, close and lifecycle cleanup. Default ordinary links use the system browser; `AppSettings.webLinkDestination` persists an embedded override. Per-link destination overrides remain explicit.
- `window.sotto.gitChanges`: current HEAD-to-working-copy diffs, untracked/new/deleted/renamed files, staged/unstaged flags, binary/large/unavailable fallback, copy path and reveal (including deleted-file parent), per-workspace polling and revision events. No staging, commit or PR mutations.
- All use the existing Files service workspace identity and exact thread cwd resolver. No renderer-provided absolute directory is accepted. Every new IPC method validates the exact trusted main WebContents, exact mainFrame object, URL, role and argument count before touching a service. Files' existing schemas and IPC are preserved.

The renderer API and integration guidance are in `../phase3-orchestration/tools-contract.md` relative to the worktree directory. Source schemas in `src/shared/{tools,terminal,browser,gitChanges}.ts` are authoritative.

## Tests actually run

`npm run typecheck` passed for both Node and web TypeScript configurations. `npm run build` passed. Focused ESLint passed for the new services/contracts/preload/tests/probe and the modified packaged-resource verifier. `node scripts/verify-notices.mjs` passed, checking 169 components.

The final focused Vitest run passed **102 tests in 11 files**:

```text
tests/unit/main/terminalTools.test.ts
tests/unit/main/browserTools.test.ts
tests/unit/main/gitChangesTools.test.ts
tests/unit/main/toolsIpc.test.ts
tests/unit/main/filesBinding.test.ts
tests/unit/main/filesIpc.test.ts
tests/unit/main/settingsRepository.test.ts
tests/unit/main/security.test.ts
tests/unit/shared/settings.test.ts
tests/unit/release/externalDependencyMetadata.test.ts
tests/unit/release/packaging.test.ts
```

These cover session ownership/restart/exit, stale working-directory rejection, cross-thread isolation, strict IPC sender validation, preload rejection and event filtering, failed-browser-load regression, per-link routing, changed/new/deleted/binary/large files, staged+unstaged modifications, renames, two actual Git worktrees and a shared-directory case, project subdirectory scoping, unborn HEAD, junction fallback, polling and existing Files/settings/security/packaging seams. Test repositories configure identity locally inside their owned temporary directories; no global Git configuration changed. The full test suite was intentionally not run.

## Actual Electron and Windows checks

Command:

```powershell
node scripts/phase3-tools/run.mjs 'D:/Talk to Text Application/node_modules/electron/dist/electron.exe'
```

The script bundles the actual services and actual preload, creates bounded temporary test files/servers, launches the existing Electron runtime, and writes machine-readable evidence to ignored `artifacts/phase3-tools/native.json` and `asar.json`.

Observed runtime: Windows x64, Electron **43.1.0**, Chromium **150.0.7871.47**, Node **24.18.0**, module ABI **148**, N-API **10**. `node-pty` **1.1.0** loaded and ran successfully both from the loose worktree and an actual ASAR with node-pty unpacked.

Verified:

1. Real PowerShell ConPTY input/output, exact owned cwd, a shell-observed 101-column resize, two retained sessions, focus/list isolation, and exit code 7.
2. A real HTTP server running inside the PTY answered `PTY_HTTP`. Ctrl+C returned the shell prompt; subsequent input executed. The probe waits for the prompt before sending the next command because interrupt acknowledges signal delivery, not completion.
3. Persisted running-session metadata became `interrupted` after service restart. Explicit reopen created a different live PTY ID.
4. Actual privileged host preload/IPC returned terminal state. An actual visited local HTTP page had no `window.sotto`, `window.sottoWidget`, `require`, `process`, or opener. Its WebContents had no preload and used a separate Electron session.
5. Two native views preserved page input state across detach, focus changes and stale cleanup of a different page. Actual browser history back/forward/reload worked.
6. Popup requests were denied without launching an OS URL; downloads were cancelled; file/javascript/data/credential-bearing navigation requests were rejected. Only HTTP(S) top-level destinations are accepted. Permissions are denied by request, check and device handlers; session resource requests cannot use Sotto/file/custom protocols.
7. Default `openLink` called actual `shell.openExternal`; Chrome reached the owned loopback endpoint. Four probe-created Chrome tabs from verification attempts were identified by exact owned page title/loopback URLs, closed, and their absence verified. Unrelated user tabs were preserved.
8. A closed, owned HTTP listening port produced an explicit unavailable state. Closing and disposing destroyed owned browser contents, leaving the host intact. Owned probe Electron/Node processes were absent after the final run.

The native probe exposed a real lifecycle defect during implementation: Chromium can report `did-finish-load` for its internal error document after navigation failure. BrowserService now keeps the unavailable state through that event, and a focused regression test verifies recovery only after explicit reload. Browser close also now waits for `destroyed` and suppresses late events that could recreate a closed page in renderer state.

## Native packaging

`node-pty` is a pinned production dependency; `node-addon-api` is its transitive dependency. Full upstream MIT texts for node-pty, winpty and node-addon-api are included in third-party notices. `electron-builder.yml` enables native rebuilding and explicitly unpacks the entire `node_modules/node-pty` tree, covering native modules, Windows ConPTY/WinPTY helpers and Unix spawn-helper. Rollup retains `node-pty` as a dynamic external; release dependency inventories and production-module checks were updated.

The probe actually packaged a small ASAR and exercised the same TerminalService against the unpacked native/helper layout. Additionally, the normal packaged-resource verifier now starts an owned PTY resolved from the packaged application's own `app.getAppPath()` and checks output/exit in its isolated probe launch. That full Sotto packaged verifier hook was added and statically checked; a full electron-builder application directory/installer was **not** built in this task. macOS ABI/runtime execution remains unverified on this Windows machine.

npm replaced this worktree's `node_modules` junction with a local directory when installing with `--ignore-scripts`; it did not mutate the main shared directory. Tests used the existing main Electron executable and this worktree's node-pty prebuilds. The integrator must install the merged dependency set in its own runtime environment.

## Integration acceptance still required

- Renderer and visible end-to-end product experience: terminal emulator sizing/input/scrolling, pinning/focus, settings control and per-link menus, Git selection/reading-position preservation, themes and overlays. No renderer source was changed here.
- Native browser views composite above the DOM. Renderer must call `mount(bounds:null)` before overlays, when hiding/leaving the panel, and when changing active pages. Remount using measured bounds after layout/zoom changes. Main detaches on host resize/reload/crash and orders asynchronous mount requests.
- Subscribe to terminal events before reading a snapshot; buffer pending output, replay with PTY input disabled, then apply only events newer than the snapshot sequence. Hiding does not close a PTY. Live ANSI history is bounded to 524288 UTF-16 code units per terminal and is not persisted to disk.
- Browser pages and isolated session cookies are retained for the app process lifetime, not restored across restart. Native browser login/download/permission workflows are intentionally unavailable; users can explicitly open the destination externally.
- Git previews are capped at 512 KiB; lists at 2000 entries and bounded Git process output. Polling runs every two seconds for up to eight watched workspace tokens. Filesystem changes during a preview can return a refresh-needed fallback. Renderer should preserve selection/scroll and reject late results for an old target.
- The independent provider/renderer integration, full suite and full packaged Sotto runtime remain the integrator's checks. Nothing was pushed or commented externally.
