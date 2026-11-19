# Web pane spike (issue #2690)

Throwaway code for stage 0, item 2 of the Rust port plan. It lives on `prototype/web-pane-chromium` and never merges. The findings are in `docs/research/2026-11-19-web-pane-chromium-component.md` (Linux), `docs/research/2026-11-19-web-pane-chromium-component-windows.md` (Windows) and `docs/research/2026-11-19-web-pane-chromium-component-macos.md` (macOS, on a GitHub runner); the evidence is in `artifacts/web-pane-chromium/` and its `windows/` and `macos/` folders.

One binary, `webpane`, built on CEF 156.0.31 (Chromium 156.0.8078.100) through the `cef` crate 156.7.0 (tauri-apps/cef-rs). CEF starts the same binary for its own child processes. `WP_MODE` picks the run:

| Mode | What it does | Question |
| --- | --- | --- |
| `cdp` | Every DevTools command `src/main/tools/pageAutomation.ts` sends, through CEF's in-process DevTools channel, against `server/pages/cdp.html` | 1 |
| `iphone` | ADR-0045's test iPhone: user agent, touch emulation, 393x852, page-zoom fit, taps and swipes | 3 |
| `seal` | `server/hostile.html` on `sotto-visual://page/<token>` with ADR-0060's layers, each switchable with `WP_SEAL` | 2 |
| `net` | CEF with no page, then one local page, for packet and NetLog captures | 5 |
| `pane` | One page; prints `FIRST_PAINT`, closes on a line on stdin, quits on the next | 6 |
| `embed` | A winit + wgpu window with the page drawn at a rectangle with rounded corners; `WP_PATH=accelerated` (shared texture) or `software`; `WP_REMOTE=1` puts CEF in a helper process; on Windows `WP_REMOTE=child` makes the helper put CEF's own child window into this window's HWND | 4, 6 |
| `child` | CEF's own native child window parented to the winit window | 4 |
| `helper` | The helper process `embed` starts with `WP_REMOTE` (Linux: a socket pair; Windows: two named pipes; macOS: Mach messages carrying each IOSurface, and a socket pair for input) | 4, 6 |
| `osr` | Windows and macOS: `server/pages/osr.html` off screen at scale `WP_SCALE` (1.5), checking `<select>`, cursors, drag and drop, the file picker, IME, the context menu and the accessibility feed | 4 |
| `eval` | One page (`WP_URL`), one expression (`WP_EVAL`) after `WP_WAIT_MS`; used for `server/pages/media.html` with the clips in `server/media/` | 8 |
| `windowed` | CEF's own native window with `server/pages/cdp.html`, held `WP_HOLD_S`, as the accessibility control for an outside walk | 4 |

Settings come from the environment: `WP_RUN_DIR` (where records go), `WP_CACHE` (CEF's root cache), `WP_SWITCHES` (Chromium switches, `;`-separated), `WP_PREFS` (a `Preferences` file seeded into the profile), `WP_URL`, `WP_BASE` (the test server), `WP_VIEW=WxH` (fixed page size in `embed`), `WP_SCALE` (the page's device scale factor), `WP_POWER=high|low` (which GPU wgpu asks for), `WP_MENU=1` (a stand-in native menu over the page's corner), `WP_NO_SANDBOX`.

## Build on Linux (forge)

```sh
export CARGO_TARGET_DIR=$HOME/.cache/sotto-cargo-target TMPDIR=$HOME/.cache/sotto-tmp CEF_PATH=$HOME/.cache/sotto-cef
cargo build --release            # the first build downloads the CEF minimal distribution into CEF_PATH
./scripts/dist.sh                # binary beside libcef.so and its resources, as an install has them
python -I server/testserver.py --pages server/pages &   # 127.0.0.1:8765, canaries on 8766 (TCP) and 8767 (UDP)
./scripts/run.sh cdp cdp WP_SWITCHES="ozone-platform=headless"
python3 -I scripts/summarize.py ~/.cache/sotto-tmp/runs/cdp/cdp.json
```

`scripts/seal.sh`, `scripts/seal_variants.sh` (network namespace, tcpdump, sudo), `scripts/net.sh` and `scripts/ablate.py` (pasta), `scripts/lifecycle.py`, and the `*-inside.sh` scripts run under `node scripts/with-nested-hyprland.mjs <dir> web-pane-spike/scripts/<script> …` from the repository root. `tools/vpointer.c` is a virtual pointer that refuses the live display.

## Build and run on Windows

Built and run on the Windows 11 laptop on November 19, 2026. Rust (MSVC) and the Visual Studio Build Tools are enough: CMake and Ninja ship inside the Build Tools, and `D:\sotto-webpane-work\build.cmd` (not in the repository) is `vcvars64.bat`, those two on `PATH`, `CARGO_TARGET_DIR=D:\sotto-cargo-target-webpane`, `CEF_PATH=D:\sotto-cef`, then `cargo build --release`. `.cargo/config.toml`'s rpath applies to Linux only.

```powershell
powershell -File scripts\dist.ps1                      # webpane.exe beside libcef.dll and its resources, in D:\sotto-webpane-work\dist
python -I server\testserver.py --pages server\pages > D:\sotto-webpane-work\server.log   # 127.0.0.1:8765, canaries on 8766 and 8767
powershell -File scripts\run.ps1 cdp cdp WP_NO_SANDBOX=1   # also iphone, osr, pane, eval; records in D:\sotto-webpane-work\runs\<name>
python -I -X utf8 scripts\summarize.py D:\sotto-webpane-work\runs\cdp\cdp.json
```

Every run sets `WP_NO_SANDBOX=1`: the CEF sandbox on Windows needs the `bootstrap.exe` model, not wired here. The Windows drivers, all from an ordinary shell:

| Script | What it runs |
| --- | --- |
| `scripts/embed.ps1 <name> [-NoInput] VAR=value ...` | The `embed` window for a fixed time: a capture, posted clicks and typing, and the process tree's memory, CPU and GPU driver over 10 s |
| `scripts/childx.ps1 <name> [-Hang]` | CEF's child window created by the helper inside this window's HWND, typing posted into it, and with `-Hang` the helper's UI thread blocked for 6 s while the window is polled |
| `scripts/uia.ps1 <name> [VAR=value ...]` | The command test page in a window, then the window's UI Automation tree as Narrator walks it |
| `scripts/lifecycle.ps1 <name> [-Runs 4]` | `pane` started from a fresh copy of the install, first paint, memory showing and with no browser, stop, leftovers |
| `scripts/net.ps1 <name> [-Hardened] [-IdleSeconds 600] [-Extra "..."]` | `net` with a NetLog and a 2 s poll of the tree's sockets; `scripts/net_summary_win.py` summarizes |
| `scripts/seal.ps1 <name> <layers> <hostile.html> [-Hardened]` | `seal` with a NetLog and the canaries' hits; the hostile page's second address points at a canary on forge |
| `scripts/win-probe.ps1 shot|tree|post|respond|uia|left ...` | The Windows measurements the others share |

The spike's input on Windows is posted window messages, not the real keyboard: a posted key and its character both arrive in a CEF child window, so each letter shows twice there. Coordinates are logical pixels because PowerShell is not DPI-aware and Windows scales posted mouse messages for it.

## Build and run on macOS

Run on GitHub's hosted `macos-26` runner on November 19, 2026, through `.github/workflows/web-pane-spike-mac.yml`, which the branch's last commit removed again (the macOS note says how to put it back). On an Apple silicon Mac with Rust and Xcode's command line tools it runs the same way:

```sh
export CEF_PATH=$HOME/.cache/sotto-cef CARGO_TARGET_DIR=$HOME/.cache/sotto-cargo-target
cargo build --release
bash scripts/mac/bundle.sh "$CARGO_TARGET_DIR/release/webpane" "$CEF_PATH"/156.0.31/cef_macos_aarch64 /tmp/wp   # webpane.app with the framework and five helper apps
bash scripts/mac/ci.sh /tmp/wp/webpane.app "$CEF_PATH"/156.0.31/cef_macos_aarch64 /tmp/wp/out cdp iphone embed   # or no phases for all of them
```

The binary loads the framework through cef-rs's library loader and makes an NSApplication that speaks `CefAppProtocol` (`src/mac.rs`); the helper link is `src/remote_mac.rs`. `scripts/mac/ci.sh` needs passwordless `sudo` for `pf`, `tcpdump` and `purge`, which runners have; on a Mac at a desk, run the phases that need none (`cdp iphone sandbox osr media embed remote ax lifecycle static`). `tools/macprobe.swift` walks a process's accessibility tree and posts real clicks and keys; it needs the Accessibility permission. `WP_SHOT=<file.bmp>` makes the `embed` window save its own frame; `WP_SELF_INPUT=1` makes it click and type into the page through its own input path.
