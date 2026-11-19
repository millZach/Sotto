# Web pane spike (issue #2690)

Throwaway code for stage 0, item 2 of the Rust port plan. It lives on `prototype/web-pane-chromium` and never merges. The findings are in `docs/research/2026-11-19-web-pane-chromium-component.md`; the evidence is in `artifacts/web-pane-chromium/`.

One binary, `webpane`, built on CEF 156.0.31 (Chromium 156.0.8078.100) through the `cef` crate 156.7.0 (tauri-apps/cef-rs). CEF starts the same binary for its own child processes. `WP_MODE` picks the run:

| Mode | What it does | Question |
| --- | --- | --- |
| `cdp` | Every DevTools command `src/main/tools/pageAutomation.ts` sends, through CEF's in-process DevTools channel, against `server/pages/cdp.html` | 1 |
| `iphone` | ADR-0045's test iPhone: user agent, touch emulation, 393x852, page-zoom fit, taps and swipes | 3 |
| `seal` | `server/hostile.html` on `sotto-visual://page/<token>` with ADR-0060's layers, each switchable with `WP_SEAL` | 2 |
| `net` | CEF with no page, then one local page, for packet and NetLog captures | 5 |
| `pane` | One page; prints `FIRST_PAINT`, closes on a line on stdin, quits on the next | 6 |
| `embed` | A winit + wgpu window with the page drawn at a rectangle with rounded corners; `WP_PATH=accelerated` (shared texture) or `software`; `WP_REMOTE=1` puts CEF in a helper process | 4, 6 |
| `child` | CEF's own native child window parented to the winit window | 4 |
| `helper` | The helper process `embed` starts with `WP_REMOTE=1` (Linux only) | 4, 6 |

Settings come from the environment: `WP_RUN_DIR` (where records go), `WP_CACHE` (CEF's root cache), `WP_SWITCHES` (Chromium switches, `;`-separated), `WP_PREFS` (a `Preferences` file seeded into the profile), `WP_URL`, `WP_BASE` (the test server), `WP_VIEW=WxH` (fixed page size in `embed`), `WP_NO_SANDBOX`.

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

## Run on Windows (for the next thread)

Not compiled on Windows yet. What should carry over and what will not:

- The `cef` crate supports `x86_64-pc-windows-msvc`. Install the MSVC build tools, CMake and Ninja, set `CEF_PATH` to a folder outside the worktree, and `cargo build --release`. Drop `.cargo/config.toml`'s Linux rpath; on Windows `libcef.dll` must sit beside `webpane.exe` (`scripts/dist.sh` is a bash script: copy the same files from `%CEF_PATH%\156.0.31\cef_windows_x86_64` by hand).
- Run `cdp`, `iphone`, `seal`, `net` and `pane` without `ozone-platform=…` in `WP_SWITCHES`. Set `WP_NO_SANDBOX=1` until the CEF sandbox is wired (the crate's `sandbox` feature needs the bootstrap executables on Windows).
- `embed` picks the DX12 backend on Windows and uses cef-rs's D3D11 shared-handle importer. Untested there.
- `WP_REMOTE` and `helper` are Linux only (a Unix socket with `SCM_RIGHTS`). Windows needs the shared texture's NT handle duplicated into the window process (`DuplicateHandle`) over a named pipe.
- The capture scripts are Linux only. On Windows, NetLog (`log-net-log=…` in `WP_SWITCHES`) works as is; for packets, `pktmon` or Wireshark on a machine with nothing else talking, or a firewall rule that blocks `webpane.exe` and logs drops.

macOS also needs cef-rs's `library_loader` call at the top of `main` and an app bundle with the helper apps (`bundle-cef-app`); neither is in this code.
