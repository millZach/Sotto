# Electron helper spike (issue #2690 follow-up)

Throwaway code on `prototype/web-pane-electron-helper`, branched from `prototype/web-pane-chromium`. It never merges. The finding is in `docs/research/2026-11-19-web-pane-electron-helper.md`; the evidence is in `artifacts/web-pane-electron-helper/`.

The question: can a hidden Electron program draw a page off screen with `webPreferences.offscreen.useSharedTexture` and hand each frame to a Rust window as a dmabuf, on forge's NVIDIA GPU under Hyprland?

| Part | What it is |
| --- | --- |
| `helper/main.js` | The Electron program: no visible window, `page.html` off screen, each `paint` texture's plane 0 sent over the socket at `WPE_SOCK_FD` with `SCM_RIGHTS`, released when the window acks it on stdin (or after 1 s). Acks, clicks (`C x y`) and typing (`T text`) come down stdin; state lines (codecs, video time, decoded audio, paint counts) go up stdout. `capturePage()` once, as a control. |
| `helper/fdpass.c` | A one-call N-API addon: `send(socket, record, fd)`. N-API is ABI-stable, so a build against Node's headers loads in Electron. |
| `helper/page.html` | A moving, colour-changing box, a frame counter, a text field and a looping H.264/AAC clip whose sound feeds an analyser before the (muted) output. |
| `receiver/` | The Rust window (winit 0.30, wgpu 30 on Vulkan): starts the helper, imports each dmabuf (`src/import.rs`, adapted from cef-rs's importer without CEF), acks it, reads back a 32x20 pixel grid every 30th frame, draws the page with rounded corners, and measures the helper's start, memory and stop. `WPE_PRODUCER=cef` runs the CEF spike's helper on the same wire, as a control. |
| `scripts/probe.py` | The same without the window: receives descriptors, maps linear ones on the CPU (`DMA_BUF_IOCTL_SYNC`) and samples them. |
| `scripts/*-inside.sh` | Run inside `node scripts/with-nested-hyprland.mjs <dir> web-pane-electron-spike/scripts/<script> …` from the repository root; they refuse the live display. `probe-inside.sh` walks `configs.txt`, `rx-matrix-inside.sh` walks `rx-configs.txt`. |

Electron comes from the release zips, checked against each release's `SHASUMS256.txt`, unpacked in `~/.cache/sotto-electron/v<version>/dist`.

```sh
web-pane-electron-spike/scripts/build.sh
mise exec node@24.22.1 -- node scripts/with-nested-hyprland.mjs ~/.cache/sotto-tmp/wpe/probe/nested \
  web-pane-electron-spike/scripts/probe-inside.sh ~/.cache/sotto-electron/v43.8.3/dist/electron ~/.cache/sotto-tmp/wpe/probe 7
mise exec node@24.22.1 -- node scripts/with-nested-hyprland.mjs ~/.cache/sotto-tmp/wpe/rxm/nested \
  web-pane-electron-spike/scripts/rx-matrix-inside.sh ~/.cache/sotto-tmp/wpe/rxm
```
