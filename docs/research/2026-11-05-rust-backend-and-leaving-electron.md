# Moving Sotto's backend to Rust and leaving Electron

Researched November 4 to 5, 2026, at `894240ead` on `main`, after Dynamic threads merged. "Backend" here is Zach's word for main, `src/shared` and `src/host` together; `CONTEXT.md`'s noun for the process that owns the providers is **host**. Nothing was built, no spike was run and no product code changed. Starts from [the October note](2026-10-26-native-app-options.md) and does not redo its survey of toolkits.

Five read-only passes read the code and primary pages. The history, the token counts and the forge measurements I took myself. I re-read the claims the conclusion leans on: the classes in the live host bundle, the three uses of Electron's binary as Node, `Window::add_child` being `unstable`, Microsoft's WebView2 privacy page, the CDP dependence of the never-blink spec, how the design gate compares images, and the crate versions on crates.io.

Tags: **[m]** measured, **[d]** documented (a file, ADR or primary page says so), **[i]** inferred from code or pages read, **[e]** estimated, my judgement. Lines are non-blank. "Could not verify" is at the end.

## The answer

**How long.** Not a week. Leaving Electron on all three systems takes about **14 weeks** of wall-clock time with most agent work on it. My 80% range is 9 to 27 weeks. The Rust backend alone, still under Electron, is about **8 weeks** (5 to 15). In tokens, about 200M Claude output tokens (110M to 550M), which is five or six weeks of everything Claude did on forge last week. [e] I am confident it is weeks and not days. I am only moderately confident in the range, because nothing was built.

**What a week does buy.** A first draft of the backend that compiles and passes the host contract on Linux, on a bigger build machine than forge, with everything else stopped. I put that at about 1 in 4. A shippable replacement in a week is under 1 in 50. [e] Zach's guess is right about the typing and wrong about what comes after it. Section 8 says what would have to be true.

**Is it worth it.** On what can be measured today, not now, not for the first three goals. The Rust side of these figures is a guess until the spike, so the spike can overturn this. [e]

- **Memory:** an estimated 4 to 8% of the owner's process tree as measured October 26; the share today is unknown. Provider CLIs and the Parakeet model hold most of it, and no port changes them.
- **CPU and speed:** steady idle is already about 0.5% of one core. Main's work per streamed chunk is about 0.3 ms against about 8 to 25 ms in the renderer and seconds in the provider. Nobody would feel it.
- **Install:** a real gain, from 115 MB to about 30 to 45 MB on Windows, but only once Electron leaves that system, in the last two steps. The Rust backend alone gains nothing here.
- **Rust itself:** a real gain if Zach wants it for its own sake. That is his call, and the numbers cannot make it for him.

**The first step.** Take a heap snapshot of the Node host. On forge it holds 504 MB for 89 threads, which the per-thread figure from #1618 and #1636 does not begin to explain. That costs half a day, needs no Rust, and may fix more than a port would. If Zach still wants Rust after that, run a three-day read-only Rust host on a copy of forge's data and hold it to the bar in section 7.

**Where this differs.**

- **From Zach's guess:** he is right that 40+ weeks is wrong, and a week is about 14 times too short, for the reasons in section 8.
- **From the October note:** its "40+ weeks" was engineer-weeks and the wrong unit, as Zach said. In wall-clock agent time it is about a third of that. I agree with its "not worth it now", for a different reason: the gain, not the effort.
- **Also from the October note:** the order changes. The October staged path moved the shell first. I would move the shell last, because that keeps the Playwright harness working through the port. And the Tauri spike now has to start with the browser, which is the biggest blocker.

## What the October note says that no longer holds

| October note | Now | Tag |
| --- | --- | --- |
| Main holds 1.3 GB, mostly the speech model | Parakeet moved to its own helper (#1795, Oct 29). Main is 297 to 300 MB private on a Windows runner, 398 to 434 MB working set on forge. The helper is 750 to 970 MB. | [d] `docs/perf/2026-10-29-speech-model-helper-memory.md` |
| Agents folder 73,022 lines | 93,095 lines, 272 files | [m] |
| `src/main` not totalled; about 92,000 lines of "main logic" | 135,803 lines, 525 files | [m] |
| Tests about 290,000 lines | About 345,000 | [m] |
| 229 specs, about 510 tests | 266 specs, 598 tests | [m] |
| Electron-coupled shell about 11,200 lines | 12,831 on the same areas; 14,145 with dock, popup and IPC | [m] |
| About 210 `window.sotto` members | 102 top members, 238 leaves | [m] |
| `portable-pty` on ConPTY unverified | It uses ConPTY: `ConPtySystem`, `CreatePseudoConsole` from kernel32 | [d] wezterm source |
| Rust speech binding not named | Official `sherpa-onnx` crate 2.0.1, Oct 27, with a Parakeet example | [d] crates.io, k2-fsa repo |
| Tauri multi-webview unverified | Exists, `unstable` only in 2.12.5, deadlocks in Windows sync handlers, 23 open issues under that flag | [d], [m] |
| Host "Keep: already plain Node, 4,159 lines" | Still free of Electron, but its import closure is 117,033 lines | [m] |
| Playwright cannot drive a Tauri window, unverified | It can on WebView2 through `connectOverCDP`. Not on WKWebView or WebKitGTK. | [d] |

What still holds: the versions of the candidates, the platform hooks every option shares, the Node sidecar option, the Tauri updater and signing facts, and the Wayland shortcut gap (Tauri plugins #3267, still open).

**#1618 and #1619, read in full.** #1618 found the model and thread-state tails, and Zach chose to keep the model loaded. #1619 found steady idle about 0.5% of one core across the whole tree, and that the CPU in the October note was the first-run usage import. Of that import's 29 s busy, SQLite's own exec was 11.5 s. [d] Neither issue found anything a language change fixes on its own.

---

## 1. Inventory

Test counts are files and lines that reach the module, which is reachability and not proof of behaviour. Rows overlap, because a test counts in everything it reaches. `phones`, `teams`, `ownModelServers`, `themes`, `productEvents` and `files` were rated from size and imports only, and `src/shared` is assessed as a whole rather than module by module. Grades are [e]: **S** mechanical, **M** real logic with stated behaviour, **L** ordering or a provider protocol pinned mostly by tests, **XL** behaviour that lives in tests and hand-won fixes, or no Rust equivalent.

### `src/main/agents`: 93,095 lines

| Family | Lines / files | Tests: files / lines | Grade | Behaviour pinned only by tests or a comment |
| --- | --- | --- | --- | --- |
| Coordinator (`control`, `runtime`, drafts, follow-ups) | 14,030 / 39 | 357 / 85,776 | XL | Reserve the admission before any publish or await (`control.ts:4285`). A microtask makes one run's snapshots share one write (`:6651`). `watcherDue` holds only for the synchronous step (`:3870`, #1070). |
| Workspace, stores | 11,885 / 17 | 281 / 67,074 | XL | `undefined` equals absent, and a wrong "same" skips a write (`sameSnapshot.ts:5`). Adapters seed synchronously (`workspace.ts:3679`). Every path marks a changed thread (`:495`, #925). |
| Provider adapters | 24,592 / 72 | 295 / 49,455 | L; Claude and Codex XL | Running publishes before the prompt's message (`cursor.ts:1174`, #765). An unreadable user message refuses the frame (`codex.ts:121`, #680). A lagging replay must not replace a longer reply (`devin.ts:851`). |
| Watcher | 12,664 / 32 | 112 / 31,603 | XL | A finish as the next turn starts shows only in the update between them (`watcherWakeUp.ts:1092`). One synchronous pass (`:500`, #1023). A send pauses on a sentinel (`watcher.ts:3440`). ADR-0073 covers most outcomes at 36,047 words. |
| Delegation, Dynamic | 5,754 / 15 | 39 / 8,787 | L | `pausedAsSent` tells Grok's reservation from Muse's `turn/started` (`delegation.ts:2052`). Dynamic has no module of its own: it is spread through `delegation`, `workspace` and `control`. |
| Worktrees, git | 8,714 / 22 | 92 / 24,188 | L | `startedAfter` rejects reads begun before a switch (`gitStatus.ts:140`). Process-wide turn maps (`threadWorktrees.ts:226`, #1312). |
| GitHub, babysitting | 2,040 / 10 | 19 / 6,100 | M | |
| Usage | 4,568 / 18 | 36 / 10,002 | M | Already on a worker. |
| Side calls | 1,504 / 11 | 31 / 5,184 | S | One cold process per call. |
| Host seam, pairing | 3,860 / 8 | 203 / 45,638 | L | Protocol v1, mirrored on phones. |
| Thread tools, pages | 3,404 / 27 | 47 / 9,574 | M | |

The folder changes fast: 233 non-merge commits in the last 7 days (+15,551, −4,314). [m] 29 modules, 2,504 lines, are imported by no test. [m]

### Provider adapters

Every adapter has a live suite (`SOTTO_*_LIVE`, never in CI). [m]

| Provider | Transport | Lines: main / all / wire | Live suites | Protocol status |
| --- | --- | --- | --- | --- |
| Claude | `--print` stream-json, stdio | 2,684 / 4,499 / 124 | 4 | `get_usage` experimental; transcripts read directly |
| Codex | `app-server` JSON-RPC, stdio | 2,352 / 4,119 / 172 | 6 | Documented, schema per version (ADR-0005); rollout log read directly |
| Muse | `muse serve`, stdio | 2,180 / 2,916 / 140 | 3 | Docs omit the methods Sotto calls |
| Grok | ACP 1, stdio | 1,659 / 2,034 / 152 | 1 | Docs 404; vendor `_x.ai/billing` |
| Cursor | ACP plus `cursor/*`, stdio | 1,334 / 2,114 / 296 | 2 | Model and mode undocumented |
| Devin | ACP, stdio | 1,250 / 1,917 / 160 | 2 | Docs cover Desktop, not the CLI |
| DeepSeek | `dsh --profile acp`, stdio | 1,058 / 1,466 / 181 | 1 | Probed; floor is 0.2.1-rc.2 |
| OpenCode | HTTP, event stream | 1,911 / 3,808 / 723 | 3 | Checked at 2.0.31 |

The wire is small and `tokio::process` with serde handles it. [e] The cost is each state machine: uncertain delivery, replay against the live stream, restarts. Five of the eight protocols are thin, undocumented or probed. Clients change shape per release (ADR-0042). [d] Sotto's fake providers are plain `.mjs` processes and survive a port as they are. [i]

### Stores

| Store | Schema | Written from | Grade | Tests | Hand-won behaviour |
| --- | --- | --- | --- | --- | --- |
| `threads.sqlite` (242 MB on forge) | 9 tables, 5 indexes, 9 migrations plus a projection rebuild | Main reads with `query_only`; all writes on a worker | L | 370 in 45 files, 25 direct | Reads lay unconfirmed writes over the window once (`threadStoreWorker.test.ts:89`). A gone worker hands writes back (`threadStore.ts:340`). Removals wait for the disk (`sqliteDurability.ts:18`). Text chunks never split a surrogate pair (`workspace.ts:103`). |
| `usage.sqlite` | 9, 6, 3 triggers | Own worker: writer and read-only reader | M | 108 in 12 | One custom function, `usage_model`. |
| `subagents.sqlite` | 6, 4 | Main | M | 157 in 11 | Attached file of erased hashes (`subagentStore.ts:73`). |
| `memory.sqlite` | 9, 2, 3, with FTS5 | Main, plus the launch script over SSH | M, policies are authority | 167 in 14 | Authority rows (ADR-0004). |
| JSON (`src/main/storage`, 1,064 lines) | | fsync and rename, corrupt backup, Windows retry | S to M | 865 in 57, mostly incidental | `atomicJsonStore.ts:164` |

Checkpoints are off main since a 1.19 s freeze at 860 MB. [d] `walCheckpointer.ts` is gone (#1457), though ADR-0016 still names it. [m]

**Would `rusqlite` read these files unchanged?** Very likely, not proven. A separate `sqlite3` 3.53.4 opened all four read-only with `quick_check` passing. [m] No schema object needs a custom function. [m] `rusqlite` 0.41.1 bundles a newer SQLite with FTS5. [d] One difference: Node sets `DEFAULT_RECURSIVE_TRIGGERS` and `rusqlite` does not, so set the pragma. [m], [d]

### Host protocol, host and remote hosts

| Area | Lines | Tests | Grade | Pinned only by tests |
| --- | --- | --- | --- | --- |
| `src/host` | 5,139 | With the socket tests below | L (`socketServer.ts` 2,095) | Retry on another listener answered from a receipt (`socketServer.test.ts:140`). Two hosts judge one crashed lock stale (`hostLock.test.ts:58`). |
| `src/main/hosts` | 10,390 | 684 cases in 17.3k lines across host and socket files | L | Stays off when switched off during a reconnect's close (`desktopHostConnections.test.ts:196`). Tailscale SSH fallback (`desktopHostsTailnet.test.ts:510`). |
| `socketFrames.ts` | 301 | | S to M | Compression stays hand-written: tungstenite has no permessage-deflate. [d] |
| `socketHostService`, `desktopHostRouter`, `desktopHosts` | 1,834, 2,000, 2,005 | | L | Each observed detail once on reconnect (`socketThreadDetail.test.ts:83`). No held delta from before a whole read (`:445`). |
| Launch script | 1,026 of Node, piped over SSH | | M to L | Boot unit runs `exec "$node" "$entry"` (`launchScript.ts:268`). |

Surface: 73 socket requests, 15 pushes, 69 commands, 90 features, 13 HTTP routes, 7 error codes. [m] "Version 1 and nothing else" means `v` stays 1 and growth is only through optional fields, `features` and hello's `accepts`. [d] `docs/host-protocol.md`

**The host is not 5,139 lines.** The value-import closure of `build-host.mjs` and the store worker is 422 files and **117,033 lines**: 244 of 272 agents files (90% of the files, 96% of the lines), 41 other main files, 116 shared and all of `src/host`. [m] Every adapter, `AgentControl`, `WorkspaceHost` and `WatcherService` are in the live 5.69 MB `index.js`. [m] So a host-first port is the backend port, less the desktop's host client and the shell.

### The rest of `src/main`, `src/shared` and the preload

| Area | Lines | Tests: files / lines | Grade | Behaviour pinned only by tests |
| --- | --- | --- | --- | --- |
| `index.ts`, root | 3,129 | 25 files | L | Boot and quit order |
| `windows` | 1,898 | 12 / 2,604 | XL | Widget focus, topmost after paste, Linux inset fix |
| `hotkeys` | 1,927 | 21 / 4,829 | L | Chord routing, lost key-ups |
| `output` | 1,182 | 15 / 2,909 | L | Paste timing per OS; forge proofs |
| `app` | 1,472 | 16 / 3,935 | L | Quit drain, shutdown |
| `tray` | 876 | 11 / 1,981 | M | Owl pauses on lock and on motion |
| `notifications` | 404 | 4 / 841 | M | Click opens the thread |
| `updates` | 582 | 3 / 873 | M | A refused restart restores the app |
| `popup`, `dock`, `startup` | 325, 118, 106 | 2, 1, 3 files | M, S, S | Panel behaviour |
| `ipc` | 871 | 18 / 6,188 | M | Patch allow-list, role gates |
| `tools/browser*` | 1,585 | 10 e2e / 1,919 | XL | Input and capture on a hidden page |
| `tools/cloudIphone` | 961 | 1 e2e named, plus tools tests | XL | Stream in an isolated view |
| Sealed pages | 310, plus preload 95 | 6 e2e / 1,458 | XL | Containment, on Chromium only |
| Other `tools` | about 2,000 | 32 / 7,321 for all tools | M | Git, checkpoints |
| `terminals`, `tools/terminal.ts` | 419 | 5 / 548, plus specs | M | Display and zoom in e2e |
| `asr` | 1,578 | 9 / 1,418 | M | Helper lifecycle |
| `llm`, `council` | 1,665, 1,820 | 14 / 3,506, 3 / 740 | M, L | Council's logic is thinly tested |
| `phones`, `omarchy`, `teams`, `ownModelServers` | 1,023, 909, 725, 751 | 9, 7, 2, 7 files | M | Omarchy has forge proofs; others not read |
| `performance` | 1,348 | 7 / 1,195 | L | The V8 inspector has no Rust form (ADR-0098) |
| `themes`, `settings`, `media`, `productEvents`, `files` | 802, 496, 76, 620, 363 | 5, 8, 3, 10, 18 files | S to M | Settings allow-list |
| `src/main/e2e` | 611 | Rewritten with the harness | M | |
| `src/shared` | 21,445, 166 modules | 88 files / 7,337 | M, and doubled | 107 modules are imported by both renderer and backend, so most stays in TypeScript and also needs a Rust twin. 4,467 `z.` sites, 906 named schemas, 71 `.refine`, 46 `.catch`. Serde has no direct form of those. |
| `src/preload` | 1,255 | 30 / 3,414 | M | Schema check per member. Bridge: 232 channel constants, 238 `window.sotto` leaves, 175 `ipcMain` handlers. |

Also cross-cutting: 607 Lingui `t` strings in 63 main files, so Rust needs catalogues or message codes. [m], [i] Whether a module's behaviour is pinned "only" by tests comes from a keyword search, so these lists are examples and not complete.

### Electron-coupled API use

The 9 direct imports are correct, but they understate. [m] `index.ts` injects Electron through narrow interfaces, so the behaviour is still Electron's: 86 main files carry Electron-shaped names, and 39 test files mock `electron`. [m], [i]

| API | Sites | Tauri 2 or Rust equivalent | Match |
| --- | --- | --- | --- |
| `app` | 83 uses | `AppHandle` | Partial |
| `BrowserWindow`, `BaseWindow` | 26, 2 | `WebviewWindow`, `Window`; no mouse forwarding or `showInactive` seen | Partial |
| `WebContentsView` | 4 | `Window::add_child`, `unstable` only | Partial |
| `webContents.debugger` | 29 CDP names | WebView2 only | Windows exact, else none |
| `<webview>` tag | sealed pages | None | None |
| `session` | 7 | data directory, incognito, proxy | Partial |
| `protocol` | 3 | `register_*uri_scheme_protocol`, origin differs per OS | Partial |
| `ipcMain`, `ipcRenderer`, `contextBridge` | 175, 6, 4 | commands, channels, capabilities | All rewritten |
| `safeStorage` | 1 | `keyring` plus own crypto | Partial, **safety-critical** |
| `Tray`, `Menu`, `nativeImage`, `nativeTheme` | 2, 4, 10, 5 | Tray events do not fire on Linux | Partial |
| `globalShortcut` | 2 | Plugin; Wayland #3267 open | Partial |
| `powerMonitor`, `systemPreferences`, `webFrame` | 4, 6, 1 | None; per-OS calls | None |
| `Notification` | 3 | Plugin; no desktop click described | Partial |
| `clipboard`, `shell`, `dialog`, `screen` | 8, 18, 4, 6 | Plugins, not opened | Likely |
| `utilityProcess`, `process.parentPort` | 1, 1 | Child process with pipes | Partial |
| `autoUpdater`, `electron-updater` | 2, 2 files | Updater plugin | Partial |

Also safety-critical: permission handlers, the browser's scheme filter, navigation guards, the sandboxed preload. Under Tauri, browser pages must hold no IPC capability. [i]

**Three paths use Electron's binary as Node**, which the October note does not list. [m]

- `claudeHistory.ts:22` runs the official SDK's history read and fork.
- `providerClients.ts:606` runs npm for client updates.
- `sshAskpass.ts:137` runs the askpass script.

Askpass ports easily. The other two need a bundled Node or a rewrite against files and feeds Sotto does not own. Bundling Node gives back about 127 MB installed, measured on Linux. [m]

### PTY, speech, native helpers

- **PTY.** `node-pty` 1.1.0 at one site, `tools/terminal.ts:145`, with `onData`, `onExit`, `write`, `resize`, `kill`. ADR-0018's `terminals/service.ts` no longer exists. [m] `portable-pty` covers it, though the crate's last release is February 2025. [d] Grade M.
- **Speech.** `parakeetHelper.ts` loads `sherpa-onnx-node` 1.13.8 in a utility process. [m] The official Rust crate has a `nemo_parakeet` example and a blocking `decode`. [d] Keep a helper process, because #1787's reason was partly Windows' heap not returning pages, which Rust does not change. [i]
- **Capture is in the renderer**: `getUserMedia` with echo cancellation, noise suppression and gain control, then an AudioWorklet (`microphoneConstraints.ts`, `audioRecorder.ts:297`). [m] WebKitGTK's `enable-media-stream` defaults to off. [d] Capturing in Rust drops those three Chromium filters, so transcript quality needs re-measuring. [i]
- **Native helpers stay as child processes**: `native/key-listener` (873 lines), `native/coreml-asr` (119 lines), `apps/omarchy` (1,333 lines). [m]

### Browser and test iPhone

The biggest blocker. Today each page is a `WebContentsView`, with partitions per workspace, phone and cloud session, and 29 CDP names for trusted input, touch emulation, full-page capture, console and network errors, and element picking. Hidden capture parks the view in a hidden `BaseWindow`. Sealed pages are a `<webview>` guest in a memory partition behind a dead SOCKS5 proxy. [m]

| Need | WebView2 | WKWebView | WebKitGTK |
| --- | --- | --- | --- |
| CDP, trusted input | Yes [d] | None found [d] | None found [i] |
| Touch and device emulation | Through CDP [i] | User agent and zoom only [d] | Same [i] |
| Screenshot | CDP | `takeSnapshot` [d] | `get_snapshot` [d] |
| Console and network errors, element picking | CDP | Injected script only [i] | Same [i] |
| Separate storage | `data_directory`, each folder adds a process group [d] | macOS 14+ [d] | `data_directory` [i] |

**Lost on macOS and Linux:** trusted agent clicks, the test iPhone's touch, full-page capture, error reporting, element picking. [i] Script-only input is untrusted, so agent clicks and touch have no equal there. Observation through fixed scripts already exists (`browserAutomation.ts:255`) and carries over. ADR-0060 rejected an overlaid view because it does not scroll or clip with the transcript, and Tauri #15682 is that same shape, so sealed pages need a new design and a containment proof per engine. [i]

### Updates and packaging

| Today | Lines | Under Tauri |
| --- | --- | --- |
| `electron-builder.yml`, `installer.nsh` | 137, 63 | Rewrite. tar.gz and pacman are not Tauri targets. [d] |
| 20 release scripts | 2,612 | Mostly rewrite [e] |
| Notices, generate and verify | 704 | Rewrite for crate licences [e] |
| 4 release workflows | 1,354 | Edit [e] |
| Release packaging tests | 3,194 in 27 files | Rewrite [e] |
| `electron-updater`, Owl provider | about 110 | Updater plugin. A signing key is mandatory and losing it blocks updates. Channels are endpoints. [d] `updateService` (448) ports. |

**Crossing from an Electron build.**

- **Windows:** Sotto uses NSIS. `electron-updater` 6.8.9 runs the feed's exe with `--updated /S --force-run`, and skips signature checks with no `publisherName`, so it can launch a non-Electron installer. [m], [i] That installer must find the old folder and old uninstall entry itself, so a bridge installer is needed. [i]
- **Mac:** stable has no updater. Owl uses Squirrel.Mac, which verifies signatures, and a same-identity Tauri app is untested. [d], [i]
- **Linux:** the next pacman package. [d]

**Data lost without work:** web storage (22 calls in 9 files), browser partitions and so site sign-ins, and `credentials.json`, which is sealed with Electron's `safeStorage`. It can be opened outside Electron on Windows and Mac, from Chromium's source. [m], [d] Re-sealing it or asking again is a decision for Zach.

---

## 2. The tests

This is the biggest factor. **Most of the tests cannot catch a Rust port as they stand.**

| Class | Files | Lines | Tests | Under a Rust backend [e] |
| --- | --- | --- | --- | --- |
| In process, with fakes | 671 | 127,753 | 6,568 | Port, or dies with its module; part rebinds |
| Adapter in process, fake provider child | 158 | 30,216 | 1,458 | Fake providers unchanged; the rest rebinds or ports |
| Host over a socket or child | 59 | 17,439 | 756 | Survives across a boundary, with a harness |
| Playwright | 266 | 51,063 | 598 | Launch and main-process calls rewritten |
| Renderer | 422 | 79,616 | 4,682 | Unchanged while `window.sotto` stays |
| `src/shared`, or no imports | 88 | 7,337 | 733 | Unchanged; a Rust twin needs its own tests |
| Pure logic in `src/main` | 117 | 10,587 | 905 | Machine-translated |
| Reads source or docs as text | 52 | 5,330 | 316 | Doc tests stay; TypeScript readers are rewritten |
| Scripts, helpers | 61 | 5,682 | 197 | Follow their code |
| **Total** | 1,894 | 335,023 | 16,213 | |

Classified by regex over each test's imports, with about 14 names per class checked by eye. [m] Fate of the 16,213 [e]: about 5,500 unchanged (34%), up to 1,433 over an existing wire (9%), up to 2,900 with a new driver (18%), 5,354 ported or dropped (33%), 598 Playwright (4%), about 430 rebound or rewritten (3%).

**Could they run against Rust across a process boundary?** Some, after a harness is built. Of the 9,687 test sites bound to backend code (186k lines, more than the 164k lines they test), this is how they reach it [m]:

| Level | Tests | Lines |
| --- | ---: | ---: |
| Code in a child, reached by socket | **179** | 3,632 |
| Test spawns a child, no socket client | 347 | 5,836 |
| Real socket, both ends in the test | 907 | 20,456 |
| Adapter in process, fake provider child | 893 | 21,007 |
| Coordinator in process, in-memory provider | 2,007 | 47,772 |
| Single module in process | 5,354 | 87,292 |

So the net that exists today is 179 tests, under 2% of the backend-bound ones. **I estimate 25 to 35% can realistically rebind to a boundary.** [e] The rest are ported or dropped.

**What cannot cross, backend-bound only (unit / integration / perf)** [m]: fake timers 156 / 30 / 2; `vi.mock` 93 / 20 / 21; spies 567 / 624 / 20; `vi.fn` 1,953 / 334 / 7; private access through `as unknown as {` 185 / 254 / 39; synchronous test bodies 2,164 / 47 / 14; injected clocks 849 / 136 / 41; held gates 201 / 80 / 2; microtask flushes 104 / 18 / 13. In favour: integration already asserts by `expect.poll` (1,449 sites), which tolerates a boundary.

**What a driver needs** [i]: launch flags for short deadlines, a clock moved over the wire (`tokio::time::pause` on the Rust side [d]), named failpoints for the in-process gates, inspection calls for the private reads, and a scriptable Rust `E2EAgentHost` (85 importers). A generic driver for the 5,354 single-module tests is not realistic: they import 1,388 symbols from 475 modules. [m], [e]

**The contract suites prove the pattern and little more.** `hostServiceContract.ts` is 9 sites and already runs over a real socket to a child. `adapterContract.ts` is 38 sites and 206 `expect` lines, but its top is an in-process TypeScript `AgentHost`, so only its bottom crosses. [m]

**Options by class** [e]: A = TypeScript harness over a boundary, B = Rust tests, C = golden traces recorded from TypeScript.

| Tests | Cheapest |
| --- | --- |
| Pure 905 | B, machine-translated |
| Other single-module 4,449 | B, rewritten natively; some die |
| Coordinator 2,007 | A with a driver; B for internals |
| Adapter tests and contract | B spawning the same fake providers, plus C |
| Socket and child 1,433 | A |
| Playwright | A, over CDP on Windows |

Machine translation elsewhere loses independence: one translator writing code and test means correlated errors. [i] 261 backend test titles name an issue and 97 an ADR. The words carry over, but the timing they pin was JavaScript's. [m], [i]

**Seams for traces.** Fake providers record what they receive in `requests.jsonl` and `violations.jsonl` and are controlled by files, so they are language-neutral (42 script fixtures, 4,711 lines). `service.events()` and the host wire are usable too. No recorder or golden format exists: `toMatchSnapshot` is in 0 files. [m]

**Playwright.** Launch is one helper (`support/sottoLaunch.ts:66`). 75 specs are page-level, 72 go through a helper that calls main, and 113 evaluate in main directly. A test RPC of 15 to 20 verbs covers most, and 19 specs import backend code. [m], [e] CI runs only 4 specs; the full suite is local and I found no duration for it. [d]

**The budget tests.** `copySites` dies. `streamingCopyBudget` and `ownerScaleWorkBudget`'s code dies and their rules hold, so they are rebuilt as test-only counters at the same seams. The copy problem moves: state crossing from Rust to a webview is serialised per update, so budget bytes per update at that boundary. Take TypeScript baselines before porting. [i]

**Run cost.** A full pull request run is about 88 runner-minutes, and a `main` run 138.5 runner-minutes and 68 minutes wall. [m] Six Windows shards at 627 to 775 s each.

### The test removal in thread ababee31

Zach started thread ababee31 to remove low-signal tests the way [T3 Code's #22557](https://github.com/pingdotgg/t3code/pull/22557) did. It has not landed and nothing here waits for it, so the figures below are scenarios. [e]

**What T3 did.** [d] About 11,000 of 25,928 tests (43%), by Haiku agents reading every file against one rubric, merged October 21. Its server package lost 35% of its tests (7,478 to 4,840) and 46% of its wall time. Summed test time across packages fell 59%. Its rubric deleted type-redundant tests, trivial logic, real or fake timers, mock-call mirrors, smoke tests, duplicate table cases and wall-clock perf asserts. Review then restored 22 auth boundary tests the swarm had cut as "timing".

**What it does to the numbers.** Test lines are already about 345,000, not 290,000. 43% would leave about 197,000. Backend-bound tests are the ones the port cares about:

| Backend-bound tests | Today | In proportion, 43% | At T3's server rate, 35%, falling mostly on single-module tests |
| --- | ---: | ---: | ---: |
| Single-module, in process | 5,354 | about 3,050 | about 2,800 |
| Coordinator, in process | 2,007 | about 1,140 | about 1,400 |
| Socket, child, or adapter with a fake provider | 2,326 | about 1,330 | about 2,100 |
| **Total** | **9,687** | **about 5,520** | **about 6,300** |
| Could rebind to a boundary | 2,400 to 3,400 | 1,400 to 1,900 | 2,200 to 3,000 |
| As a share | 25 to 35% | 25 to 35% | 35 to 48% |

The keep list decides which column Sotto lands in. Only 335 of 950 backend test files (35%) name a keep-list word in their file name, and only 5 name a race. [m], rough. So the rubric has to read test bodies, because races do not show in file names.

**How it changes the estimate: a little.** Rust tests fall from 110,000 to 140,000 lines to about 65,000 to 95,000. Tokens fall from about 200M to about 170M, or four to five weeks of forge's burn. Wall-clock falls about a week at the likely figure, from about 14 to about 13 weeks, and the backend from about 8 to about 7.5. The high end stays at 27, because it is set by phase D, real use and the shell, which do not shrink. The headline figures in this note are from before the removal. A week stays out of reach: none of the serial work gets shorter. [e]

**Does it help or hurt the safety net?** It helps the cost, and it is mixed for the net.

- **It helps.** What stays is what can cross a boundary. Mock-call mirrors would not have crossed anyway (2,294 backend `vi.fn` sites), and type-redundant tests mean nothing in Rust. Less translated test code also means less of the correlated error in section 2.
- **It does not help.** The 179 tests that reach real code across a boundary do not grow, and the driver and recorder are still to build. A higher share is not a stronger net: in the better column the number that can rebind still falls by about 10%.
- **It can hurt.** A rubric asks whether a test catches real bugs in code that is staying. A port asks whether a test pins what the code does, because every line changes. Four things look low-signal by the first question and matter by the second:
  1. **Timing tests.** T3's rubric deletes them and Zach's keep list keeps races, and T3's swarm cut 22 real boundary tests that way. Sotto's backend tests have 188 fake-timer sites and 1,026 injected clocks, and its unwritten ordering lives there.
  2. **Pure input-and-output tests.** 905 tests that run in 16 s in total. Trivial logic to a rubric, and the cheapest oracle a port has, since they translate by machine.
  3. **Tests that name their reason.** 261 backend test titles name an issue and 97 an ADR. Those are the hand-won fixes.
  4. **Shell behaviour off the keep list.** Widget focus, topmost after paste, lost key-ups, paste timing, quit drain and a refused restart (`windows`, `hotkeys`, `output`, `app`, `updates`). Section 1 found these only in tests. A shell port would lose its only record of them.

**Net.** If the removal follows the keep list, reads test bodies and leaves those four alone, it helps a port on balance. If it follows T3's timer rule, it removes the part of the net that is hardest to rebuild. [e]

**Cheap ways to keep the option,** none of which slows the removal: tag the commit before it, so golden traces can still be recorded from the full suite; keep a manifest of removed tests with the rubric's reason for each, so a port can restore the ones it needs; and exempt, or check by hand, the four groups above. These are not sent to ababee31.

---

## 3. The renderer

**Which shell.** Tauri 2 with system webviews as the end state, reached last. Until then Electron stays a thin host over the Rust backend. [e] Only this exit meets the install goal, and thin Electron meets the typed-backend goal with no renderer risk.

| Shell | Engine | Install | Status | One Chromium |
| --- | --- | --- | --- | --- |
| Tauri 2, system webviews | WebView2, WKWebView, WebKitGTK | Drops about 330 MB. Pinned WebView2 adds about 180 MB. Linux needs `webkit2gtk-4.1`, 133.55 MiB. [d], [m] | `tauri` 2.12.5, `wry` 0.57.1 [m] | No, and versions float outside Sotto's releases [d] |
| Tauri with `tauri-runtime-cef` | CEF | Chromium stays | 3.0.0-alpha.6, Oct 14; open issues include idle 100% CPU on Linux and keyboard handling [m] | Yes |
| Plain `cef-rs` | CEF | 157 MiB Windows, 129 Mac, 300 Linux, minimal bz2 [m] | `cef` 156.3.0. No window or tray layer. [m], [i] | Yes |
| Servo | Servo | Unknown | v0.7.0 "Tech Demo", Verso archived. Out. [m] | No |
| Electrobun | System or CEF | 14 or 100 MB [d] | v2.0.6. Main is Bun, not Rust. Out. [m] | Optional |
| Thin Electron plus a Rust process | Pinned Chromium | Unchanged | Proven | Yes |

CEF gives up most of the install and memory gains: the renderer, GPU and utility processes stay. [i] It is also the only route to CDP on all three systems, so it is the fallback if Zach will not give up the browser tools on Mac and Linux. Tauri's own page calls it "hundreds of megabytes larger". [d]

**A new privacy finding.** Under [Microsoft's WebView2 privacy page](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/data-privacy), WebView2 collects required data "regardless of the Windows Diagnostic data setting". Crash minidumps go to Microsoft unless `IsCustomCrashReportingEnabled` is set. SmartScreen is on by default, and an app that leaves it on must tell its users. [d] AGENTS.md says no analytics and no crash upload, and the README names the hosts Sotto contacts. So WebView2 needs an ADR and a README change before anything else. Whether `wry` exposes those two settings is not verified.

**What losing one Chromium does.**

- **CSS and web APIs are mostly fine.** A probe of WebKitGTK 2.52.6 on forge (`CSS.supports` and `typeof`, under Xvfb and X11, so parsing only) passed `color-mix`, `oklch`, `:has`, `@container`, `@starting-style`, `light-dark`, popover, view transitions, `roundRect` and more. [m] Sotto does not use anchor positioning, `ctx.filter` or `letterSpacing`, where Safari's gaps would bite. [m]
- **What breaks.** `-webkit-app-region` (16 files, 42 hits, must be rewritten with `startDragging`), `<webview>`, the mic path, and hidden-window suspension. [m], [d] `calc-size()` in `threads.css:36` degrades. `dragDropEnabled` must be off for HTML5 drag on Windows, and 14 files use it. [d], [m]
- **Hidden windows.** Dictation records in a renderer that is often hidden in the tray. Tauri's default "can throttle timers and even unload the whole tab" after about 5 minutes, and `background_throttling` works only on macOS 14+. [d] Test it, or move capture to Rust. [e]
- **Windows.** Widget and popup are transparent, frameless and always on top at a per-platform level. Tauri has no level and no `type: 'panel'`, and #14924 reports NVIDIA transparency faults. [d] ADR-0052, ADR-0084, ADR-0150.

**Watcher's scene.** Canvas 2D on two DOM canvases plus in-memory glyph and field canvases, about 0.3 ms a painted frame, 1.8% still and 6.1 to 6.5% in flight, in headless Chromium. [d] ADR-0126 The rule is ADR-0126 decision 6 and ADR-0149 decision 5; the fix is `768e2966b`, and `invalidate()` keeps the last frame.

- **The gate is lost.** `watcher-scene-steady.spec.ts:41-47` uses a CDP screencast, which is possible on WebView2 and not on WebKit. It needs a compositor-level recorder. [m], [i]
- **Not proved on WebKit.** Atomic resize-and-draw. WebKitGTK 2.52 changed canvas replay and composition scheduling. [d] Bug 280210 and Tauri #10702 cover the DMABUF renderer on NVIDIA, which is forge's class of GPU, and the usual flag has a reported cost. [d] No handler exists for context loss, and Safari has no `contextlost`. [m], [d] Only a spike proves any of this. The first step would be MiniBrowser in a nested Hyprland on forge. [e]

**Composer and IME.** ProseMirror has Safari branches, and WebKitGTK reports an Apple vendor so it takes them. [m] Chromium-shaped and unproven on WebKit: the read-only tab stop (`PromptEditor.tsx:142`), the keydown guard (`:147`) and the inline atom with `popover` (`SkillPill.tsx:147`). [i] IME checks are `isComposing || keyCode 229` in `composerKeys.ts:7`, but `isComposing` alone at three other sites. WebKit bug 165004 was that exact fault and closed in April 2026. [m], [d] Composition tests are synthetic and no real IME is tested anywhere. [m] Spellcheck is off by default on WebKitGTK. [m] Find-in-page has no uses. [m] Dictation is an OS paste into a normal paste handler, so it assumes no Chromium event order. [i]

**Accessibility.** No axe. `getByRole` in 248 unit and 260 e2e files, `contrast` in 81 test files, none reading the platform tree, so a move loses no test but nothing proves the new trees. [m], [i] Tauri #15624 reports WebView2 content unreadable after reactivation. WebKitGTK's own accessibility tests "run, not yet passing" (Igalia, Sept 2025). [d] WKWebView needs a VoiceOver pass.

**Design gates.** `design:verify` is local and in no workflow. [m] Two things run:

- `designCapture.ts` compares a capture to its baseline with a tolerance: channel noise up to 6, changed pixels up to max(100, 0.05%), total delta up to max(1,000, 0.5%).
- `verify-design-captures.mjs` checks each committed baseline's SHA-256 and geometry.

There is one flat set of 157 baselines, drawn on Windows, none for Mac or Linux (ADR-0062). [m] An evergreen WebView2 update could turn it red with no Sotto change, and rasterisers differ per OS. [i]

**Cheapest useful gate** [e]: Windows pixels on a CI-pinned WebView2, layout and contrast assertions through Playwright's WebKit, and hand notes for Mac and Linux. Lost: automatic catch of paint faults on WKWebView and WebKitGTK. Three engines' worth of baselines would be about 470 committed images.

**IPC.** Tauri's events are "not designed for low latency or high throughput" and may run out of order; channels are the route. JSON under 8,192 bytes and raw under 1,024 go through `eval`, and larger payloads take a second round trip. [d] Load today is 15 broadcasts a second per streaming thread. [d] No primary page compares Tauri with Electron, so this needs a spike. The preload's schema checks lose their isolated world. [i]

**Renderer memory.** WebView2 is the same engine, so assume no saving. [i] Forge's WebKitGTK on a blank page: WebProcess private dirty 92 MiB, and a second same-origin view started a second WebProcess unless made as a related view. [m], [d] Electron on Windows with fake providers: window renderer 135 to 156 MiB, widget 107 to 113, GPU 111 to 118. [d] No owner-scale renderer split exists on any engine. [m]

---

## 4. A gradual path

**Can a Rust host replace parts of the Node one behind the protocol?** Not parts, in my judgement. The import closure alone does not prove that. The barriers are ownership and order: the requests act on state one runtime owns, adapters seed the workspace synchronously (`workspace.ts:3679`), publish order is synchronous (216 `this.publish(` lines), the thread store reads synchronously, and read-without-copy shares frozen objects by identity. Slicing by request would need that state held across two processes. [m], [i] The other seams are smaller and remove no Node: the usage worker, the thread store's writer, and a front door proxying to Node. [e]

| Path | Ships in steps | Keeps features moving | Test net during the move | Gain arrives | My view |
| --- | --- | --- | --- | --- | --- |
| **Big bang**: Rust and Tauri together, on a branch | No | Only if the branch chases `main` | Rebuild everything first | At the end | No. Two changes of engine and language with no working system between them. |
| **Host first, shell last** (below) | Yes, with a stop at every step | Needs `src/main/agents` down to about a quarter of today's rate, or features written twice [e] | Socket tests carry over; Playwright works throughout | Hosts first, install last | **This one, if at all** |
| **Leaves first**, as Node-API addons in process | Yes, every module | Yes, and each module has one implementation at any time | Vitest keeps calling the same surface | Only when Node finally leaves. A native addon under V8 is also how main held 1 GB (#1787). | The fallback if a freeze is not acceptable. Serves Rust for its own sake, not memory. [e] |

The leaves-first path also breaks the host's "no native modules" rule, and state moved into Rust values loses JavaScript identity unless it is kept explicitly, through references and `napi_strict_equals`: 67 `WeakMap` lines and `===` on frozen shared objects rest on it. [m], [d], [i]

**The steps of the path I would use.** Weeks are wall-clock, and include the overlap in section 8. [e]

| Step | What ships | If you stop here you keep | Weeks |
| --- | --- | --- | --- |
| 0. Measure, no Rust | Heap and CPU profile of the Node host, any fix they point to, golden wire frames, owner-scale baselines | A memory fix if there is one, and the first drift check for iPhone and Android | Under 1 |
| 1. Spike, not shipped | Read-only Rust host on a copy of forge's data | The numbers to decide with | About 0.5 |
| 2. Usage store in Rust | First Rust binary in the release, on three systems | The toolchain. No gain a user sees. | 1 to 2 |
| 3. Rust host for remote machines | Per-host opt-in on Owl, Node host stays as the fallback | Hosts need no Node. Measured host memory and CPU. | 4 to 12, counting steps 0 to 2 |
| 4. Desktop's local threads on the Rust runtime | Thin Electron | A typed backend, one Chromium, no renderer risk | 1 to 3 more |
| 5. Tauri on Windows | WebView2 is the same engine and has CDP, so this is the cheap half | Windows install saving. Mac and Linux stay on thin Electron, at the cost of two shells. | 2 to 5 more |
| 6. Tauri on Mac and Linux | Browser tools and test iPhone redesigned, gates moved | All of it | 2 to 7 more |

**Which ADRs each path changes.** Zach's rule is that reversing one needs a prototype for him first, so these are names only. [i], from code and titles.

- **Step 2:** 0003 (`node:sqlite`); the dependency rule in AGENTS.md, 0018 and 0071, since each crate and binary is an ADR.
- **Step 3:** 0025 (host under plain Node, plain archive), 0054 (boot unit pins Node), 0016 (worker write path), 0040 and 0077 (host update), 0042 (npm under Electron's Node), 0190 (size budget counts TypeScript), 0013 and 0072 (gates read in the new language).
- **Step 4:** 0018 (PTY), 0071 (helper and crate), 0098 (V8 profiles).
- **Step 5:** 0020 and 0154 (CDP browser), 0029 (grant stays, its means change), 0060 (sealed pages), 0084 and 0150 (window material), 0009, 0030, 0117, and a new ADR for WebView2's data against the README.
- **Step 6:** 0045, 0047, 0052, 0062, 0093, 0096, 0099. 0126 and 0149 keep their rule and move their gate.
- **Big bang:** all of the above at once, so the prototypes come first and in one batch.
- **Leaves first:** the same list by the end, but earlier and in a different order: 0025 and the host's no-native-modules rule at the first module, the dependency rule in AGENTS.md with 0018 and 0071, 0003 and 0016 when the stores move, 0190 throughout.
- **Keep on every path:** 0002 Sotto thread IDs, 0004 authority, 0014 and 0041 worktrees, 0026 side calls, 0027 git by CLI, 0028 broadcast shape, 0033 and 0050 phone access, 0043 approval surface, 0058 outbox write, 0073 Watcher, 0076 restart resume, 0078 and 0083 usage, 0081 and 0191 delegation and Dynamic, 0187 team trust, and the provider ADRs.

---

## 5. The gain for each goal, each step

### The baseline

**Memory** [m] unless tagged.

| What | Figure | Where |
| --- | --- | --- |
| Owner's Windows tree, Oct 26 | 4,783 MB private, of which provider CLIs about 3.5 GB | October note. Not re-measured since #1795 and #992. |
| Forge's Node host | **504 MB PSS**, plus 116 MB in swap. High-water 815 MB. 11 threads. Almost all anonymous memory. | Live, 8.8 h up, Nov 4 |
| Forge's host data | 89 threads with messages, 11,605 messages, 53,629 activities holding 165 MB of payload, `threads.sqlite` 254 MB | Read-only query |
| 10 Claude CLIs under that host | 1,016 MB PSS | Same sample |
| Bare Node 24.22.1 | 47 MB RSS; binary 126.9 MB | |
| Electron main, empty profile | 192 MB, V8 heap 45 MB | #1618 [d] |
| Electron main with the model in its helper | 297 to 300 MB private (Windows runner), 398 to 434 MB working set (forge) | [d] |
| Parakeet helper | 750 to 790 MB loaded, 944 to 970 MB after a transcription | [d] |
| Clean shell, 7 processes | 298 MB private | October note |

**The surprise in that table.** #1618 put thread state at about 155 KB a thread on seeded threads, and #1636 then removed about 132 KB of that. Even 155 KB across 89 threads is about 14 MB, yet the host holds about 450 MB over bare Node. [d], [i] Forge's threads are far longer than those seeds, so some of the gap is expected, but nobody has split it. That gap is the first thing to explain. If it is parsed objects, Rust wins a lot. If it is 165 MB of payload strings held for no reason, V8's one-byte strings are already compact, and a TypeScript fix wins as much as a port. [i] Nobody has looked.

**CPU** [m].

| What | Figure |
| --- | --- |
| Whole tree, steady idle, Windows | About 0.5% of one core (#1619) [d] |
| Forge's host, 120 s sample, with 10 CLIs live | **16.3% of one core** |
| Forge's host, 8.8 h average | **7.0% of one core** |
| Those 10 Claude CLIs, same sample | 6.7% |

**Install** [m], stable 0.1.42 on Linux, unpacked from the release: 420 MB installed.

| What | MB |
| --- | ---: |
| Electron binary | 225.0 |
| Locale packs | about 47 |
| `LICENSES.chromium.html` | 20.0 |
| `icudtl.dat`, `resources.pak`, GL, SwiftShader, FFmpeg, Vulkan, crashpad | 36.5 |
| **Electron's own files** | **about 330 (79%)** |
| Renderer | 26.8 |
| Main bundle, host bundle, preload | 10.6, 5.8, 0.5 |
| sherpa and ONNX Runtime | 33 |
| zod, node-pty, Claude SDK | 4.0, 2.2, 1.5 |

Installers: Windows 115 MB, Mac dmg 148 MB, Linux package 135 MB, Linux tar.gz 139 MB. The host archive is 2 MB and needs Node on the machine. [m]

### Step by step

Estimates need the spike. A blank means no change.

| Step | Memory | CPU and speed | Install |
| --- | --- | --- | --- |
| 0. Measure | Unknown until measured. Could be hundreds of MB on a host. | Finds what the host's 7 to 16% is | |
| 1. Spike | The number that decides this | Per-update CPU against Node | Real binary size |
| 2. Usage in Rust | Under 50 MB, by replacing a V8 worker [e] | First-run import shorter, but 11.5 s of its 29 s busy was SQLite, which is C either way [d] | +3 to 10 MB [e] |
| 3. Remote hosts | Host 504 MB to perhaps 100 to 250 MB [e]. Desktop unchanged. | Host 7% of a core to perhaps 2 to 4% [e]. On forge's 16 logical cores that saves about 0.2% of the machine. | Archive 2.28 to 3 to 8 MB [e]. **127 MB of Node off the host** [m], if no CLI needs it. |
| 4. Thin Electron | **About flat.** Main 300 to 430 MB becomes a thin main of perhaps 150 to 190 MB plus Rust at 100 to 250 MB. [e] | Backend leaves main. Renderer unchanged, one more hop. | **About flat**: 16 MB of JS out, 15 to 40 MB of binary in [e] |
| 5. Tauri on Windows | Main's 150 to 190 MB leaves. Edge's browser, renderer and GPU processes remain. [i] | Same engine; unmeasured | Installer **115 to 30 to 45 MB** [e]. Pinned WebView2 adds about 180 MB installed. [d] |
| 6. Tauri on Mac, Linux | Needs a spike; blank-page WebKit is not comparable | Watcher's cost on WebKit unmeasured | Mac 148 to about 45 to 60 MB; Linux 135 to about 35 MB plus system WebKit 133.55 MiB [e] |
| All of it | **About 0.2 to 0.4 GB of 4.8 GB, 4 to 8% of the owner's tree** [e] | Backend's share falls; nobody feels it | About 75 MB off the Windows installer [e] |

If Claude's history and npm keep needing Node, add back about 40 to 50 MB compressed and 127 MB installed. [e] For a user with few threads and dictation off, the percentage is better: a 298 MB shell might become 150 to 200 MB. [e]

### What no port changes

- **Provider CLIs.** 1,016 MB across 10 Claude CLIs on forge, about 3.5 GB on the owner's laptop, 323 MB of Claude and 517 MB of Codex on disk. [m] #992 already stopped starting them for threads merely on screen. Sotto's reaper is a bigger memory lever than any port. [e]
- **The Parakeet model.** 0.73 GB loaded, near 1.1 GB at peak, kept on purpose while dictation is on. About 670 MB to download per model. [d]
- **The renderer.** 100k lines stay, at about the same cost per update on WebView2.

### Speed: the backend's share and the renderer's

| Stage | Cost | Tag |
| --- | --- | --- |
| Provider turn | Seconds | [i] |
| Renderer, per update | About 8 ms in #993; 3 to 23 ms in jsdom, up to 25 ms in the pane benchmark. At 15 a second, the 3 to 23 ms comes to 45 to 345 ms of renderer time a second. | [d] `2026-11-01-hidden-window-hold.md`, `2026-10-31-pane-memo-boundaries.md` |
| Main, per streamed chunk | 0.34 ms on a long thread, down from 2.49 ms; 0.15 ms on a short one | [d] `2026-10-29-long-thread-detail.md` |
| First chunk to the bridge | 1.7 to 2.3 ms | [d] `2026-10-06-first-words-to-bridge.md` |

The backend is 25 to 70 times cheaper per update than the renderer, across different benchmarks. [i] Main's worst stalls on record (96% busy, 105 stalls in a minute, Oct 20) were work that grew with history, and were fixed in TypeScript. [d] A port speeds up what is already under a millisecond and leaves the renderer alone. What it does remove is GC pauses and V8's start-up cost. [i] Whether users feel the 1.8 s to first window change depends on the webview, and only a build can say.

### CI

Probably no faster, and these are estimates, because compile times are unmeasured. [e]

- **During the port, slower.** Both backends are tested and a Rust job runs on three systems. Tests rebound across a boundary cost more: 1.73 s a test through a child and socket, against 0.35 s for coordinator tests and 0.10 s for single-module tests today. Rebinding the coordinator tests could add up to about 2,800 s, 47 runner-minutes, to a run of about 88. [m], [e]
- **After it, about the same.** In-process backend tests are about 1,255 s of 4,026 s recorded. At perhaps 5 to 10 times faster, that saves about 17 to 19 runner-minutes. Compiling and release builds on three systems take that back, at perhaps 5 to 15 minutes per system with no cache. Real child processes, the 696 s of renderer tests and the iPhone journeys do not change.
- **What sets the wait is untouched.** A passing run's wall time is a median of 36 minutes and a 90th percentile of 166. The iPhone journeys take 68 to 74 minutes each with a macOS queue on top. They would still run, now against a Rust host.

The test removal in section 2 does far more for CI than a port would, with no port.

### Rust itself

Not measurable, so stated plainly. [e]

- **For:** a compiled single binary, hosts with no Node, compile-time checks where TypeScript has `as unknown as` (26 lines in backend code [m]), no V8 tuning.
- **Against:** 107 shared modules exist twice unless generated; 607 translated strings in main move; V8's inspector goes (ADR-0098); agents' compile loop is likely slower than TypeScript 7's 44 s typecheck, though Rust's check time is unmeasured [e]; no Rust toolchain is installed on forge today [m].

---

## 6. The other clients

**On the wire, nothing changes**, if absent-versus-null, field shapes and push order match exactly. [i] Protocol 1 is frozen. No Swift or Kotlin needs editing.

**Today there is no wire drift check at all.** [m] No golden files, no shared fixtures, and no test reads `Wire.swift`. iOS's CI job triggers on `hostProtocol.ts` but not on `agents.ts`, which holds the shell phones decode (`ci.yml:60`). Android has no CI job (ADR-0059, still proposed). SottoCore is 6,867 lines and Android's core is 1,132, about a sixth, despite the ADR's "line for line".

**What does change:**

- `socketServer.ts` also runs inside desktop main for the phone listener (`phoneAccess.ts`), so a Rust host does not retire the TypeScript server until step 4.
- The iPhone journeys would have to run against a Rust host, which means building it on the macOS runner in that job. [i]
- Refusal sentences get duplicated. [i]

**Generating types from one source fits badly.** `z.toJSONSchema` throws on transforms by default [d], `src/shared` has 5 `.transform`, 1 `z.preprocess` on the shell and 3 `z.custom`, and 71 `.refine` and 46 `.catch` carry meaning JSON Schema will not [m]. Phones decode a tolerant subset by hand. [e]

**Golden frames are worth doing regardless.** Record frames from the socket tests and decode them in XCTest and JUnit. That closes today's gap and later becomes the Rust port's oracle. [e]

---

## 7. Risks and recommendation

### Risks

| Risk | Why it matters | Evidence |
| --- | --- | --- |
| **The freeze** | `src/main/agents` nets about 11k lines a week. A dedicated port covers about 35k a week [e], so a third of it is chasing. For 8 weeks, most work in that folder stops or doubles. This is the real price. | [m] |
| **Unwritten ordering** | In the top six files, 344 methods read and write state with no `await`, and that is atomic only because JavaScript runs to completion. Only 96 lines match my ordering phrases. | [m] rough scanner |
| **Eager start and cancel** | A JS `async` runs to its first await and a Rust future runs nothing until polled. 10 `Promise.race` and 195 `void this.` lines expect losers to keep running, and dropping a Rust future cancels it. 14 `queueMicrotask` lines have no tokio form. | [m], [i] |
| **Identity** | 67 `WeakMap`, 17 `WeakSet`, 31 `Object.freeze` lines rest on `===`. `Arc::ptr_eq` fits many; identity keys need explicit IDs. | [m], [e] |
| **A net that agrees with itself** | One translator writes code and test, so errors correlate. Both agent-written Rust projects in section 8 had a near-perfect oracle. Sotto has 179 tests across a real boundary today, and a TypeScript host that could serve as one once a recorder is built. | [m], [d], [i] |
| **Multi-threading** | Single-threaded async Rust avoids a redesign. Multi-threaded needs an owner per domain across 163 and 157 private fields in `control` and `workspace`. Then the performance case is mostly constant factors. | [m], [e] |
| **Three engines** | Every Playwright spec exercises one of three. Faults on WKWebView and WebKitGTK are caught by hand. Versions update outside Sotto's releases. | [d], [i] |
| **Tauri `unstable`** | Multi-webview has 23 open issues, some matching Sotto's window styles. CEF is alpha. | [d], [m] |
| **The crossing** | One release path per system, credentials to re-seal, sign-ins lost, an updater key that blocks all updates if lost. | [d], [i] |
| **Provider churn** | Claude transcripts, Codex rollouts and Muse methods are likeliest to break silently, during a port and in two implementations. | [i] |
| **Machines** | Forge has 16 logical cores and 16 GB, and ran out of memory with four Sotto threads sharing it on Oct 28. 30 worktrees of Rust `target/` could reach hundreds of GB. | [m], [e] |

### Recommendation

**Do not start the port now.** On today's measurements the goals do not pay for about 200M output tokens over 14 weeks and a hold on most work in the agents folder. That rests on Rust figures nobody has measured, which is why the spike comes before any commitment. Do step 0 now, because it pays anyway. If Zach wants Rust for its own sake, that is a good enough reason, and the host-first path lets him stop at any point.

**If the install is what matters most,** the October note's option B (Tauri shell, Node sidecar) reaches it without porting the backend, in about the shell half of this estimate, 4 to 12 weeks. It keeps a Node of about 127 MB installed. [e] It also keeps every blocker in section 3.

### The first step, if yes

1. **Heap and CPU profile of the Node host** on a copy of forge's data, half a day. Explain the 450 MB. Fix what it shows.
2. **Golden frames** from the socket tests, decoded in XCTest and JUnit, 1 to 2 days.
3. **A read-only Rust host, about 3 days, not shipped.** It opens a copy of forge's `threads.sqlite`, speaks hello, thread list and thread detail over protocol 1, and is opened by the unmodified desktop and iPhone.

**What it can and cannot show.** It measures what holding and serving the same threads costs. It does not run the coordinator, adapters, writes or Watcher, so passing earns the next gate and does not prove the savings of a full port.

**What earns the next gate: all three, against the Node host on the same data doing the same reads.**

| Test | Pass |
| --- | --- |
| **Memory** | Holding the same threads, PSS at most a third of the Node host's, after any fix from the heap profile |
| **Wire** | Unmodified desktop and iPhone open threads; golden frames decode the same |
| **CPU** | Replaying a recorded update stream costs at most half the CPU per update |

**Also record the cost.** Output tokens per kept Rust line. Above about 800, multiply my token estimate by the ratio, and if it is above 1,400, stop and re-estimate. [e]

If memory fails, the memory goal is gone. CPU is judged on its own number, and install on its own, since it comes from the shell and host memory does not touch it. **The next gate after that:** one Claude thread and one Codex thread end to end on forge in Rust within two weeks, passing `hostServiceContract` and `adapterContract` through a shim. If that takes longer than two weeks, the 8 weeks is wrong and so is everything after it.

---

## 8. The estimate

### Evidence from this repo

All [m], from `git` and `gh` at `894240ead`.

| Measure | Value |
| --- | --- |
| Repo age | 16.5 weeks, first commit July 11 |
| `src/main`, Sep 15 to Nov 4 | 19,685 to 136,040 lines: **+116,355 in 50 days** |
| Same, last 20 days | **3,216 lines a day** |
| Tests, same 50 days | 61,948 to 344,933: +282,985 |
| Same, last 20 days | 7,148 lines a day |
| Merged PRs | 1,160; 29.1 a day over the last 28 days; peak 57 on Oct 23 |
| Open to merge, since Oct 5 | Median 1.7 h, 90th percentile 12.7 h |
| Oct 28 to Nov 5 | 291 PRs: 32,089 backend, 24,148 renderer, 55,684 test, 48,964 phone lines added |
| On a `fix/` branch | 519 of 1,160, 45% |
| Named by a later `fix/` PR within 7 days | 19.9% of feature PRs, 22.9% of fix PRs. A lower bound: not every fix names its cause. |
| Reverts | 0 |
| Issues labelled `bug` | 362, about 1.5 per 1,000 lines of `src/main` and renderer |
| Titled PRs on a `fix/` branch, per surface | Devin 66%, DeepSeek 60%, Muse 58%, Grok 57%, OpenCode 43%, iPhone 42%, Linux 36%, Cursor 33% |
| iPhone client | 41,243 lines, 6 weeks, still being fixed at week 6 |
| Linux desktop | 33 titled PRs, Oct 6 to Nov 3. #931, the e2e suite on Linux, open since Oct 11, no comments, so weak evidence. |
| CI, 400 runs Nov 1 to 5 | PR runs: 158 passed, 63 failed, 43 cancelled. Passing wall time: median 36 min, 90th percentile 166. |
| `main`, same runs | 133 pushes: 22 passed, 34 failed, 76 cancelled, which is what the workflow does to a push waiting behind a newer one [i]. So most merges get no run of their own. Failures sampled are mostly iPhone journeys and Linux shards. |
| iPhone journeys, 7 runs each, from 40 sampled | 68 to 74 min each; macOS queue 90th percentile 24 to 46 min |

### Evidence from outside

[d] Two agent projects in Rust, both with an oracle Sotto has not built. The compiler was written from scratch; Ladybird was a translation.

- **Anthropic's C compiler** ([Feb 5, 2026](https://www.anthropic.com/engineering/building-c-compiler)): 16 agents, about 2,000 sessions, two weeks, 100,000 lines, 2B input and 140M output tokens, under $20,000. Oracle: the GCC torture suite, with GCC as a known-good compiler for the kernel. "It's important that the task verifier is nearly perfect, otherwise Claude will solve the wrong problem." Near the end new work frequently broke old, which led to a stricter CI. Not a drop-in for GCC.
- **Ladybird's LibJS front end** ([Feb 23, 2026](https://ladybird.org/posts/adopting-rust/)): about 25,000 lines in two weeks, with Claude Code and Codex, "hundreds of small prompts", "human-directed". Requirement: byte-for-byte identical output. 52,898 test262 tests and 12,461 regression tests with 0 regressions, plus lockstep browsing. C++ stays primary; the Rust is not yet idiomatic.
- **TypeScript's port to Go** ([March 2025](https://github.com/microsoft/typescript-go/discussions/411)): the team wanted a port "as compatible as possible, both in terms of semantics and in terms of code structure", and Go "strongly resembles the existing coding patterns". The post does not name Rust. It is relevant because Sotto's code is also shared objects compared by identity. [i]

Those rates are about 7,100 lines a day with 16 agents and a perfect oracle, and 1,800 under close direction. Sotto's own is 3,200 backend plus 7,100 test lines a day. **A week needs 22,500 backend lines a day**: 7 times Sotto's rate and 3 times the C compiler's, plus the tests, with no oracle built yet. The TypeScript host can be one through differential traces, as Ladybird's C++ was. That needs a recorder and a golden format, which do not exist. That work is in phase A.

### A plain check

`src/main` grew by 116k lines in the last 7 weeks, with 283k lines of tests. This is a rough anchor and not a measurement of a port. Translating known behaviour should be cheaper than discovering it: I assume phases C and D run two to three times faster than first writing did. Verification gives much of that back, because a host cannot switch to Rust until its whole runtime holds parity, even though the path ships step by step. So I do not expect it to be much shorter than the first time. That is about 8 weeks for the backend, and the phase table agrees.

### Phases

Wall-clock weeks, assuming most agent capacity is on it and `src/main/agents` is held. [e]

| Phase | Shape | Low | Likely | High |
| --- | --- | ---: | ---: | ---: |
| A. Baselines, golden frames, test driver, Rust in CI on three OSes, build machine, ADRs and Zach's prototypes | Mostly serial | 1 | 2 | 3 |
| B. Core: types, single-thread executor, wire, stores, one adapter end to end | Serial, all lanes build on it | 1 | 1 | 2 |
| C. Fan-out: other adapters, git, usage, side calls, tools, tests alongside | 10 to 20 lanes | 1 | 1.5 | 3 |
| D. Coordinator, workspace, Watcher, delegation, host seam: about 48k interlocked lines | Limited parallel | 1.5 | 2.5 | 5 |
| E. Converge: suites, live suites on 8 CLIs, three OSes | Parallel, queue-bound | 1 | 2 | 4 |
| F. Run for real: forge, then the laptop, then Owl | Calendar | 1 | 2 | 4 |
| **Backend, with overlap** | | **5** | **8** | **15** |
| G. Shell spike and decisions | Serial, Zach | 1 | 1 | 2 |
| H. Windows, tray, hotkeys, paste, notifications, bridge, updates | Per OS | 1.5 | 2.5 | 5 |
| I. Browser, test iPhone, sealed pages: prototypes first | Serial | 1 | 2 | 5 |
| J. E2E harness, gates, never-blink recorder, IME and accessibility passes | Mixed, by hand | 1 | 2 | 4 |
| K. Release paths and the crossing, then stable | Serial, by hand | 1 | 1.5 | 3 |
| **Shell, with overlap** | | **4** | **6** | **12** |
| **Total** | | **9** | **14** | **27** |

**How the subtotals overlap.** The backend phases sum to 6.5, 11 and 21 weeks, and the shell phases to 5.5, 9 and 19. B needs A's types and driver first, and D needs B. C runs beside D, and E and F run beside the later part of D. H, I and J run together, after G. I took off about a quarter to a third for that, by judgement rather than from a schedule. The shared macOS queue, one-at-a-time review and blocked merges are allowed for inside E, F and K, also by judgement.

### Tokens

| | Lines [e] |
| --- | ---: |
| Rust backend, from 157,500 lines of TypeScript (`src/main`, `src/host`, shared closure) | 150,000 to 200,000 |
| Rust tests | 110,000 to 140,000 |
| Driver, harness, shell, release | 25,000 to 50,000 |
| **Total** | **about 285,000 to 390,000** |

Output tokens per added line, all-in:

- **Sotto, about 380.** Claude on forge from Oct 28 to Nov 5 was 38.2M output, 10.59B cache read, 238M cache write and 38,368 requests. That is 209k output and 58M cache read per `gh pr create`. The 380 assumes those 183 PRs carry their share of the 160,885 added code lines in that window's 291 PRs. [m], [i]
- **The C compiler, 1,400.** [d]

That gives **110M to 550M output tokens, about 200M likely**, and at Sotto's ratio about 55B cache reads. [e] Against about 37M output and 10B cache reads in a full week on forge, that is **five or six such weeks**. Without the shell and release work, about 180M, or five such weeks. [e]

Against weekly limits I can only give consumption, not capacity. Over 14 weeks, 200M is about 40% of what Claude used on forge at last week's rate, every week. A one-week backend is about five times that rate. Whether the accounts can supply either is unknown: a weekly percentage cannot be converted, since Zach's accounts switch automatically and the reading is one account's. [d] Memory, Nov 4. Laptop threads, Codex, Sol and other threads' needs are not in these counts. So I would not call tokens the binding limit at 14 weeks, and I cannot rule them out for one week.

### What cannot be parallelised

- **Design before fan-out.** Every lane builds on one set of types, one executor and one rule for ordering. Fan out before that and 20 lanes each pick their own. Phases A and B. [e]
- **Dependency order.** `control` sits on `workspace` sits on the adapters and the store. Lanes run within a layer, and phase D barely splits. [i]
- **Hand tests.** No Mac journey runs in CI. [d] Hold-key, paste into other apps, tray owl, widget focus, notification clicks, the mic, a real IME, Narrator, VoiceOver and Orca, Watcher's scene, and the update crossing are all by hand. 34% of PR bodies since Oct 20 already leave something to a hand check (rough regex, 204 of 608). [m] About half a day per system per pass, at least three passes: **four to five days of Zach's own time**, spread across the weeks, waiting on a daily Owl. [e]
- **CI.** About 88 runner-minutes per PR, and the iPhone journeys alone are over an hour each with a macOS queue. A Rust matrix adds to this. A large port can land 150 to 300 PRs, which the train can carry at today's rate, so CI costs waiting rather than capacity. [e]
- **The merge train.** The rule is that a red `main` is fixed before anything else merges, and `main` passed 22 of 56 finished runs from Nov 1 to 5. [m] Worse with Rust added.
- **Review.** A reviewer has to compare two languages against behaviour that is not written down. Sol runs one at a time on forge. [d] Memory
- **The behaviour nobody wrote down.** Measured: 21,144 comment lines in the agents folder, and between 34 and about 1,500 of them record a past incident, depending on how strictly you count. 261 backend test titles name an issue. [m] Real use finds the rest. **As a scenario and not a rate:** bug issues over current source is a crude 1.5 per 1,000 lines, and it is not a defect rate for a port, which may have fewer logic bugs and more timing bugs. At a quarter of it to all of it, 157,500 lines is 60 to 240 bugs [e]. At today's roughly 13 fix PRs a day, that is 5 to 18 days with nothing else merging. It is phase F, and it cannot be done before the code exists.

### What would have to be true for a week to work

All of these.

1. **Every other agent stops** touching `src/main`, `src/shared` and `src/host` for the week and for the fixes after it. That is about 22,000 lines of TypeScript that do not land.
2. **An oracle exists on day one.** Today it is 179 tests across a real boundary, and a TypeScript host nothing yet records. The driver and recorder are themselves about a week.
3. **The design is right the first time**: types, single-threaded executor, ordering, identity. There is no time for a second attempt.
4. **About five times today's Claude burn** is available, about 180M output tokens in seven days, with a working account switch throughout.
5. **A build machine** that holds 20 to 50 Rust checkouts. Forge cannot, and it has no toolchain installed.
6. **All eight live suites pass** against real CLIs on three systems, inside the week.
7. **Zach hand-tests** three systems at least twice within the week.
8. **Electron stays.** That is a smaller job than the one asked, so the week delivers no install saving and about no memory saving. For backend and shell together, add the shell's serial work: Zach's prototypes for the browser tools and sealed pages, a spike on three systems, new release paths and the crossing. Even at my low figures that is about 4 more weeks.
9. **Real use finds almost nothing**, against a history where 45% of all PRs are fixes.

Even then, what you have at the end of the week is a backend nobody has used for real.

### How sure I am

- **High:** weeks, not days. The test net, the freeze and the bug tail each break a one-week plan on their own.
- **High:** the order of gains, because it rests on measured sizes. Install comes last, memory is small, and speed is the renderer's and the provider's.
- **Medium:** 8 weeks for the backend. It rests on one rough anchor (the last 7 weeks) and two public projects, neither of which had to match a running product's behaviour under real use.
- **Low:** the shell half. Nothing has been run on a webview. It has the widest range for that reason, and could be longer if Zach keeps the browser tools on Mac and Linux.
- **Low:** the Rust memory figures. Those are what the spike is for.

---

## Could not verify

- **Nothing was built.** No Rust binary, Tauri window, real renderer on WebKit, Playwright against WebView2, or capture diff across engines. Every Tauri capability is from docs or source.
- **Rust numbers.** Binary size, host memory, CPU per update, musl behaviour, `target/` size, `cargo check` memory, and Rust process start-up.
- **The owner's live tree** since #1795 and #992. The 4.8 GB is October's. The 4 to 8% is my arithmetic on it.
- **What the Node host's memory holds.** I did not attach to the live host, and no heap snapshot exists.
- **Renderer memory at the owner's scale**, on any engine.
- **Token figures** cover Claude on forge only, over about a week, and include work that made no PR. They do not include the laptop, Codex or Sol. The 380 tokens a line rests on a proportional assumption.
- **The regex classifiers.** Test classes, hand-check counts, ordering scanners and "only pinned by tests" are keyword or regex searches, not audited. Test counts are static `it(` and `test(` sites; CI runs 1.29 cases per site.
- **`rusqlite` opening the files**, and invalid UTF-8 in existing rows. Electron 43's `node:sqlite` compile options, measured on plain Node.
- **Tauri details:** updater delta downloads, NSIS custom pages, off-screen `get_snapshot`, `Input.dispatchTouchEvent` in WebView2, whether `wry` exposes SmartScreen and crash settings.
- **Squirrel.Mac** taking a non-Electron app; a Tauri installer run with `electron-updater`'s flags; macOS Keychain prompts for a new binary; the Linux key format.
- **WKWebView:** per-view memory, spellcheck, VoiceOver.
- **WebKitGTK:** behaviour on Wayland and with Fcitx on Hyprland. The probe ran under X11 and shows parsing, not painting.
- **Full Playwright duration.** Not found in `docs/ci.md`, `docs/verification` or `docs/perf`.
- **The TypeScript team's reasoning on Rust.** Its own post does not name Rust. Comments on that page do, and they are not the team's.
- **Effort and probabilities.** My judgement, from the evidence above.
- **The test removal in thread ababee31.** Not landed when this was written, so section 2's figures for it are scenarios from T3 Code's PR.
- **Review.** Sol ran both axes on this note at `gpt-6.1-sol` xhigh and its findings are applied. Sol did not see the sections on CI and the test removal.
