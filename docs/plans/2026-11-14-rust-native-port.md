# Moving Sotto to Rust and a native window

This plan takes Sotto off Electron, Node and TypeScript on Windows, Apple silicon macOS and Linux, and keeps every feature it has today. The backend becomes one Rust core. The window becomes a native Rust UI. A Chromium component stays for the panes that show web pages, and for nothing else. The iPhone and Android clients do not change and keep speaking host protocol version 1.

Zach picked this direction on November 14, 2026, on three question cards, after asking for a fresh reading and saying that time is not a limit on the conversion. On November 17 he added three more picks: one repository, a stable frozen at today's Owl, and no feature work until the port is done. The freeze began on November 18: stable 0.1.43 carries every Owl feature, and Owl 0.1.44-owl.20261118.2 is the newest Owl it names. No Rust is written yet.

Two earlier notes studied the same question: [native app options](../research/2026-10-26-native-app-options.md) and [the Rust backend and leaving Electron](../research/2026-11-05-rust-backend-and-leaving-electron.md). Both advised against starting, on the measured gain. This plan does not reopen that; it is about how. It was read from the code first and compared with the notes afterwards. Figures marked *(November note)* are theirs and were not measured again.

## What Zach picked

| Question | Pick | What it rules out |
| --- | --- | --- |
| Front end | A native Rust UI, chosen by a bake-off of GPUI and Slint on one hard screen | The React renderer in a webview, bundled or the system's |
| Web panes | Chromium stays as a component for Sotto's browser, the test iPhone and sealed pages, loaded only while such a pane shows | Rebuilding the browser tools on WKWebView and WebKitGTK |
| Feature work | Paused. Once the newest Owl is released, the only work is the port, and fixes. This replaces the November 14 pick, which kept features landing in TypeScript. | A port that chases a moving target |
| Stable | All 47 Owl features held on November 17 are sent to stable, so stable is what Owl is today. After that it takes no new features. It still takes fixes, and each hidden stage (1 to 3) once Owl has proved it. | A stable with no releases, which breaks when a provider's CLI changes; and a stable that takes all five stages in one update |
| Repository | One: a Cargo workspace in this repository | A second repository pinned to this one |

## Why this shape

- **The feel lives in the window, not the backend.** Main spends about 0.3 ms on a streamed chunk and the renderer 8 to 25 ms *(November note)*. WebView2 is the engine Electron already uses, so a Rust backend under a webview would feel the same on Windows. Only a UI drawn natively changes it.
- **The browser decides whether Chromium ships.** `src/main/tools/pageAutomation.ts` drives pages with Chromium's DevTools protocol: the accessibility tree, hit testing, trusted input, touch emulation for the test iPhone. Only WebView2 offers that protocol among the system webviews. Keeping every feature on Mac and Linux means Chromium stays for those panes.
- **Electron is already at arm's length.** Nine source files import it. `src/host` runs the same agent code headless under plain Node.
- **Every provider speaks a neutral protocol.** All ten adapters drive a spawned CLI over stdio, except OpenCode, which is loopback HTTP and server-sent events. Sotto's own tool servers are hand-written JSON-RPC over loopback HTTP, and the host socket is a hand-written WebSocket. None of it needs JavaScript.
- **OS integration is mostly helper programs today.** Windows compiles C# through PowerShell for the key listener and the paste. macOS uses a Swift key listener and `osascript`. Linux uses `hyprctl`, `wtype` and `wl-copy`. Rust calls the Windows and macOS APIs directly.

## The shape at the end

Crate names are suggestions.

| Part | What it is |
| --- | --- |
| `sotto-core` | A library: the coordinator, the ten adapters, the stores, host protocol version 1, the tool servers, plugins, Watcher, Council, delegation, hosts and updates |
| `sotto-host` | The headless host: the core and the socket server in one static binary for each system. A remote machine needs no Node. |
| `sotto` | The desktop app: the core in process, the native UI, the tray, the hotkey, the widget and the popup |
| Speech helper | Parakeet through the `sherpa-onnx` crate on Windows and Linux. The Swift Core ML helper stays on macOS. |
| Web pane component | Chromium Embedded Framework, started when a web pane shows and stopped when the last one closes |

What stays as it is: the files on disk (`threads.sqlite`, `subagents.sqlite`, `usage.sqlite`, `memory.sqlite` and the JSON records), the provider CLIs, protocol version 1, and every rule in `AGENTS.md` under "What Sotto is".

## Rules for the whole port

- **The TypeScript host is the referee.** It stays the authority until the Rust host matches it frame for frame at the socket. One translator writing both code and tests agrees with itself, so the proof has to come from the old implementation, not from new tests.
- **Every stage ships, and any stage can be the last.**
- **One repository.** The Rust lives in this repository, in a Cargo workspace under `crates/`, outside npm the way `apps/ios` and `apps/android` are. The referee, the fake providers and the socket contract are here, and they only prove anything when both implementations are checked at the same commit. A feature that changes the protocol or a store changes both sides in one pull request, and each Owl is built from one commit. A second repository would need a version pin between the two, and the pin is where they would drift. Build output goes to one shared folder outside the worktrees (`CARGO_TARGET_DIR`), because a `target/` folder in every worktree would repeat ADR-0041's disk problem at several times the size.
- **Port whole owners, not requests.** The coordinator's state has one owner and its order rests on JavaScript running each step to completion *(November note: 344 such methods in the top six files)*. In Rust one task owns that state; adapters, stores and I/O are separate tasks that send it messages. Threads are for I/O and parsing, not for sharing the workspace.
- **A fix lands with a test at the boundary.** Features are paused, but providers keep changing and fixes keep landing. While both implementations live, a fix in `src/main/agents` comes with a socket contract case, a fake-provider case or recorded frames, and is made on both sides once the Rust side exists. A fix proved only by in-process unit tests is one the port has to rediscover.
- **Same files, both ways.** Rust reads and writes the stores in place, so a user can go back to the previous build. A schema change during the port is made in both implementations in one release.
- **Privacy is proved again.** No prompt text, transcript, protocol body or key in a log; no new host. The Chromium component's own network calls (component updates, safe browsing, variations, crash upload) are turned off and that is tested, or they become an ADR and a README change first.
- **Each crate is a decision.** ADR-0018's rule becomes an allow-list that the release checks (`cargo deny` or the like), with licences on it. GPUI is Apache-licensed. Zed's own application crates are GPL and are never copied.
- **Windows first, then Apple silicon macOS, then Omarchy.** Linux work never changes Windows or macOS behaviour.
- **All port work is behind Owl.** Each Rust part is an Owl feature with its own entry in `src/shared/owlFeatures.ts`, and nobody needs to ask. Stages 1 to 3 are sent to stable one at a time, when Zach says Owl has proved each. The native window stays on Owl until the crossing.

## Stage 0: prove and prepare

Nothing here ships to users, except the freeze. All of it is needed before the first port.

0. **The freeze.** Every held Owl feature is sent to stable in one pull request, as the nineteen were on October 23 (#1384), and a stable is cut from it. Feature work stops once the newest Owl is released, and `AGENTS.md` says so from that day. The switches of sent features are then deleted, so the Rust side never carries them. Done on November 18, 2026, but for the switches: #2675 sent the 47, stable 0.1.43 was cut from it, Owl 0.1.44-owl.20261118.2 followed, and `AGENTS.md` carries the freeze.

1. **The bake-off.** Build one hard screen twice, in GPUI and in Slint: a thread pane streaming a long turn with Markdown, code blocks, a diff and folded activity; the composer with an inline pill; a terminal pane; one dark and one light theme from the `--tt-*` tokens; a web pane inside the window with rounded corners. Check it at 1600x1000, 1280x800 and 820x560 on all three systems.
   - Measured against today's Electron window, the same way: frame time while streaming, typing latency, memory, launch time, binary size, and how long an edit takes to show.
   - Must pass: Narrator, VoiceOver and Orca read it; the keyboard path works; Arabic and Urdu lay out right to left; Japanese and Chinese input compose in the composer; it runs under Hyprland on Wayland; reduced motion holds.
   - Must pass, for design review: three variants of one component reach Zach through a link that opens on his laptop and his phone, as the real toolkit running in a page or as captures of it, and the time from an edit to the screen is recorded. An HTML draft still settles a direction; this settles the look that ships.
   - The feel is Zach's to judge. If neither toolkit passes, the question goes back to him before anything else is built.
2. **The web pane spike.** Run `pageAutomation.ts`'s fixed command list through the Chromium component on all three systems. Rebuild ADR-0060's seal (no network, no permissions, no downloads, its own scheme) and try to break it. Check the test iPhone's emulation, and the shared-texture path under Wayland on forge.
3. **The referee harness.** Record the TypeScript host's wire frames across the 23 fake provider programs. Build a runner that starts either host binary, replays the same script and compares frames, with IDs and times normalised. Move `adapterContract.ts` to run across the socket: today it imports TypeScript, so it cannot be pointed at a Rust binary.
4. **Baselines at the owner's scale** for what the port claims to change, so every stage reports against the same figures.
5. **The ADR** recording the direction and the toolkit the bake-off chose, the workspace layout, a Rust job in CI on three systems, and the dependency rule.

## Stage 1: dictation's helpers

Ships inside today's Electron app. These parts already sit behind process boundaries, so nothing else moves.

- One Rust helper replaces the Windows key listener and paste (PowerShell compiling `native/key-listener/win32.cs` and the inline `SendInput` C#) and the macOS Swift key listener and `osascript` paste. Linux keeps `hyprctl`, `wtype`, `wl-copy` and the dictation socket.
- Microphone capture moves from the renderer's `getUserMedia` and audio worklet into the helper, so dictation stops depending on a hidden window. Audio still never touches disk.
- The Parakeet helper moves from `sherpa-onnx-node` in a utility process to the `sherpa-onnx` crate *(November note: version 2.0.1 exists with a Parakeet example)*.
- What it proves: Rust in the release on three systems, signing and notarising a second binary, and an Owl gate around it.
- ADRs it changes: 0018, 0071 and the dependency rule in `AGENTS.md`.

## Stage 2: a Rust host for remote machines

- `sotto-host` passes the socket host contract and the referee harness for all ten adapters. Claude and Codex come first.
- Opt-in for each host on Owl. The Node host stays as the fallback and the referee.
- The launch script uploads one binary; the remote machine no longer needs Node 24.
- The stores open the same SQLite files through `rusqlite`.
- Claude history is the one JavaScript-only piece: `claudeHistory.ts` calls the Claude SDK's `getSessionMessages` and `forkSession` in a child process. Rust has to read and fork those sessions itself, and that is where a provider update is likeliest to break things silently.
- A read-only Rust host runs beside the Node host on a copy of forge's data until their frames agree.
- The iPhone and Android clients must not be able to tell which host they reached.
- ADRs it changes: 0003, 0016, 0025, 0040, 0042, 0054, 0077 and 0190.

## Stage 3: local threads on the Rust core

- The desktop's own threads run on the core. Electron keeps only the windows, the preload bridge and the web panes.
- The rest of main moves: settings, credentials, plugins, Watcher, Council, delegation, teams, the host router and SSH launcher, usage, product events, updates and memory.
- Terminals move from `node-pty` to `portable-pty`.
- Credentials are sealed again while Electron is still there to unseal them. `credentials.json` holds Electron `safeStorage` values, and reading those from outside Electron differs on every system.
- Playwright still drives the window, so the 290 specs remain the net for this stage.
- The TypeScript coordinator is deleted at the end, and `src/host` with it, since the Node host runs the coordinator's code. From then the referee is the recorded frames, and backend features are written in Rust. Its budgets (`copySites`, `zodSchemaSites`, `codeSizeBudget`) retire with it, and the owner-scale work budget is rebuilt for Rust.
- ADRs it changes: 0018 and 0098.

## Stage 4: the native client, beside Electron

A second desktop client on Owl, the way the iPhone app is already a second client. The Electron client stays the default until the native one reaches parity. Only one of them owns the workspace at a time.

Order:

1. Tray, hotkey, widget, popup, notifications and launch at login. From here an idle Sotto holds no web engine.
2. The Threads page: sidebar, panes, transcript, composer, question and permission cards, pickers.
3. Tools: the terminal, Git changes and review, file pages, media, and the web panes for the browser, the test iPhone, the cloud iPhone and sealed pages.
4. Watcher's room and its night scene.
5. Settings, setup, usage, Council, help, updates, performance, Omarchy, and memory behind its gate.

What each web library becomes:

| Today | In the native client |
| --- | --- |
| TipTap composer | The toolkit's text editing, with inline pills |
| `react-markdown` and `remark` | A Rust Markdown parser, drawn natively |
| `lowlight` | `tree-sitter` or `syntect` |
| `xterm` | `alacritty_terminal` with a native renderer |
| Mermaid | Unsettled: a web pane, or a Rust renderer if one draws them faithfully |
| Lingui catalogues, 32 locales in 7 areas | The same `.po` files read from Rust, so translations carry over. Needs an ICU message formatter. |
| `--tt-*` tokens in CSS | A theme table generated from `tokens.css`, so every theme, the Omarchy ones included, carries over |

What holds: ADR-0011 and ADR-0169 (colour from theme roles, sizes and corners from the scale), the three window sizes, light, dark and reduced motion, 4.5:1 contrast, and the keyboard rules in `AGENTS.md`. Their tests are rebuilt for Rust.

How a room is proved: its Playwright journeys are re-made against the platform's accessibility tree, by role and name as `getByRole` does today, so the accessibility tree becomes something the tests depend on. The design gate gets new baselines for each room as it lands and retires the old ones. A room is done when its journeys pass on three systems and Zach has used it.

`AGENTS.md` changes when this stage starts: an HTML draft stays a way to explore a look, but it is no longer the medium that ships.

ADRs it changes: 0020, 0029 (the grant stays, its means change), 0045, 0047, 0052, 0060, 0084, 0123, 0126, 0149, 0150 and 0154.

## Stage 5: the crossing

- A bridge release: the last Electron build installs the native one. Windows has an updater on stable and Owl, macOS on Owl only, Linux none, so each system crosses its own way.
- The update feed moves from `latest.yml` and `owl.yml` to the new updater. Its signing key is guarded: losing it blocks every update.
- Browser sign-ins move from Electron's partition to the component's profile, or the release notes say they are lost.
- Then what is left of `src/main`, and all of `src/renderer` and `src/preload`, are deleted, CI moves from Node to Cargo, and `README.md`, `docs/guide.md`, `docs/ci.md`, `docs/release/releasing.md` and `AGENTS.md` are rewritten.
- ADRs it changes: 0062, 0072's mechanics, 0093, 0096 and 0099.

## How each stage cuts over

Every stage follows one pattern. The new part ships beside the old one, on Owl first, behind a switch read at start. Both read the same files, so the way back is the switch and a restart. The old part is deleted only after stable has run on the new one for a release.

| Stage | What switches | Turned on by | Way back | Old part deleted |
| --- | --- | --- | --- | --- |
| 0 | Nothing | | | |
| 1 | What listens for the key, pastes, captures the microphone and runs Parakeet | An Owl switch, then stable | The switch. The old helpers stay in the build. | One stable release after the Rust helper reaches stable |
| 2 | Which host a remote machine runs | A choice on each saved host on Owl, then the default for new hosts, then for all | The same choice. The Node host reads the same files. | The Node host archive stops being published once every stable host runs Rust. `src/host` stays as the referee until stage 3 ends. |
| 3 | What runs this computer's threads | An Owl switch. Electron's main starts the Rust core as a process of its own and talks to it over a local socket, as it already talks to a remote host. | The switch and a restart. The old `credentials.json` is kept until the stage ends. | The TypeScript coordinator and `src/host`, at the end of the stage |
| 4 | Which window the user works in | An Owl choice. First the native app takes the tray, hotkey, widget and popup, and starts the Electron window only when the main window is opened. Then rooms land in order, and a room the native window lacks opens in the Electron one. | The choice and a restart | Nothing. Electron stays the default, and stays installed, until every room has passed. |
| 5 | Which app is installed | The bridge release, Owl first, then stable | Installing the last Electron release, which still reads the same files | Electron, the renderer, the preload and what is left of main |

Two points have no switch behind them: the end of stage 3 and the bridge release. After either, going back means installing an older release.

While a room exists in both windows, a change to it is made twice. With features paused, the Electron copy of a room takes fixes only.

## What gets harder

| Risk | What answers it |
| --- | --- |
| Ordering that nobody wrote down | One task owns the coordinator's state; the referee harness |
| A dropped Rust future is cancelled, where a JavaScript promise that loses a race keeps running | A porting rule for each `Promise.race` and each `void this.` call, checked in review |
| Two implementations while providers keep changing | Fake providers updated once, run against both |
| A feature slipping in during the freeze | Each one is work the port does twice. `AGENTS.md` carries the freeze, and lifting it is Zach's call. |
| Screen readers, right-to-left and input methods in the toolkit | Must-pass rows in the bake-off, before any room is built |
| The Chromium component: size, Wayland, its own network calls | The web pane spike, before stage 4 depends on it |
| Three systems' worth of UI tests rebuilt | Room by room, each with its journeys |
| Rust build folders in many worktrees | One shared build cache for each machine; forge has 16 GB |
| UI work in Rust is slower to iterate than React and CSS | Measured in the bake-off as time from edit to screen |

## Not verified

- Screen reader support, right-to-left layout and input methods in upstream GPUI. Searches on November 14 found AccessKit work in forks and on a `gpui-component` branch, and nothing from Zed itself.
- Whether Slint can draw a long, selectable, streaming transcript and a terminal fast enough.
- Chromium's shared-texture path under Wayland, and which of its network calls can be turned off.
- A Rust Mermaid renderer, and an ICU message formatter that reads Lingui's catalogues.
- `alacritty_terminal`'s and the Chromium binding's licences against Sotto's terms.
- Every figure marked *(November note)*.

## First steps

1. This plan. Done.
2. The freeze: send the 47 held Owl features to stable, cut a stable, and stop feature work once the newest Owl is out. Done on November 18, 2026.
3. The referee harness, which makes the boundary tests stronger even if the port stops there.
4. The bake-off, on `prototype/native-ui-gpui` and `prototype/native-ui-slint`, kept as tags when finished.
5. The web pane spike.
