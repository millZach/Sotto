# The web pane as an Electron helper, on forge

Run on November 19, 2026, on forge (Omarchy, Hyprland 0.56.2 on Wayland, RTX 4060 with NVIDIA 610.57.04), as a follow-up to issue #2690 and [the CEF spike's note](2026-11-19-web-pane-chromium-component.md). Stock Electron 43.8.3 (what Sotto ships) and 45.4.1 (the newest stable release), from the release zips, checked against their `SHASUMS256.txt`. Nothing patched or built. Every run was in my own nested Hyprland. The code is throwaway, in `web-pane-electron-spike/` on `prototype/web-pane-electron-helper`. The evidence is in `artifacts/web-pane-electron-helper/`.

Tags: **[m]** measured here, **[r]** read (an issue or a primary page), **[i]** inferred.

## The answer

**No.** On forge, neither Electron version delivers a single real pixel through `useSharedTexture`, in any of the 21 configurations I tried. Either `paint` never fires, or it fires with a valid dmabuf whose bytes are all zero [m]. The other half of the idea does work: H.264 and AAC play [m].

- **The page renders.** Electron's own `capturePage()` of the same page, in the same run, is 97% non-black and shows the H.264 test pattern (`electron-43.8.3-capture-page.png`) [m].
- **The buffer is empty.** Two readers agree, and neither shares the other's assumptions:
  - The Rust window imports each dmabuf into Vulkan with an explicit modifier and reads back a 32x20 pixel grid every 30th frame. Every sample was zero, alpha included, and all samples hashed the same (`receiver-matrix.jsonl`) [m].
  - The probe maps each linear dmabuf on the CPU between `DMA_BUF_IOCTL_SYNC` calls. All zero (`probe-matrix.jsonl`) [m].
- **The receiver is not the fault.** The CEF spike's helper, fed through the same Rust window, the same importer and the same readback, gave 12 of 12 non-black samples, all 12 different (`cef-control-window.png`). In that capture CEF's own video area is black because CEF cannot play H.264 [m]. Each runtime fails on the half the other gets right.
- **The transport works.** Descriptors cross the socket at 60 frames a second. The window acks each frame and the helper calls `texture.release()`, and the pool never ran dry [m]. Only the contents are missing.

`electron-43.8.3-window.png` and `electron-45.4.1-window.png` are the Rust window: the rounded rectangle is drawn, and it is black.

### Every configuration

43.8.3 and 45.4.1 gave the same results in every row [m]. "Zero" means the handle arrived and every sampled pixel was 0.

| Switches | Format | `paint` | Handle | Pixels | What the GPU process said |
| --- | --- | --- | --- | --- | --- |
| `--ozone-platform=wayland`, or no ozone switch | `argb` | Never fires | None | None | `Unable to initialize SkSurface` |
| Wayland, `--use-angle=gl-egl` | `argb` | Never fires | None | None | The same |
| Wayland | `rgbaf16` | Never fires | None | None | |
| Wayland | `nv12` | Never fires | None | None | `eglCreateImage failed` |
| Wayland, `--enable-features=Vulkan` (also with no ozone switch) | `argb` | 60/s | BGRA, 1280x800, modifier 0 (linear), stride 5120 | Zero | "`--ozone-platform=wayland` is not compatible with Vulkan" |
| Wayland, `--use-angle=vulkan --enable-features=Vulkan` (also with no ozone switch) | `argb` | 60/s | The same | Zero | The same |
| The same, plus `--enable-native-gpu-memory-buffers --enable-zero-copy` | `argb` | 60/s | The same | Zero | |
| The same, plus `SkiaGraphite` | `argb` | 60/s | The same | Zero | |
| The same, plus `--ignore-gpu-blocklist` | `argb` | 60/s | The same | Zero | |
| Wayland, ANGLE on Vulkan | `rgbaf16` | 60/s | `rgbaf16`, modifier 0 | Zero | |
| Wayland, ANGLE on Vulkan | `nv12` | Fires, then stops | Two planes, modifier 0 | Zero (CPU map of the Y plane) | The GPU process exited (code 133) |
| XWayland (`--ozone-platform=x11`), with or without `--enable-features=Vulkan`, any format | | Never fires | None | None | `gbm device is missing`, `Unable to allocate frame for first frame capture: OOM?` |
| XWayland, `--use-angle=gl-egl` | `argb` | Fires, `texture` null | None | None | `No suitable EGL configs found` |
| XWayland, ANGLE on Vulkan | `argb` | 38 to 48/s | BGRA, modifier 0, `supportsZeroCopyWebGpuImport: true` | Zero | The GPU process crashes and restarts |
| `--ozone-platform=headless` | `argb` | Never fires | None | None | `Unable to allocate frame for first frame capture: OOM?` |
| Headless, `--enable-features=Vulkan` | `argb` | Never fires | None | None | `vkCreateInstance() failed: -7` |
| `useSharedTexture: false` (control) | | 55/s | Bitmap | Not sampled | Chromium paints |

### Why, as far as the reports go

My results match electron/electron#53271 row for row: on an RTX 4090, on KDE Wayland and on a bare Xorg session, Electron 42.3.3 and 44.0.0, `--use-angle=vulkan` gets a handle and the buffer is zero [r]. That issue's author got real pixels only from a patched Electron 44.5.1. Their patch made Electron's off-screen capture ask for a native-handle shared image (`kPreferSharedImageWithNativeHandle`) instead of a mappable one (`kPreferMappableSharedImage`). It sat on top of Chromium's capture fix `9522ea8ad0be`, which they say is in Chromium 156 and so in Electron 45 [r]. Stock 45.4.1 is still zero here [m]. So the Chromium fix alone is not enough, and what remains is in Electron's own off-screen code [i]. I did not read Electron's source to confirm the request is unchanged in 45.4.1. Every buffer I received was linear, which fits a mappable allocation [i]. #49247, the no-`paint` half, is closed; my Wayland rows reproduce it on both versions [m][r].

## Figures beside CEF's

The brief's measurements were for a working pipeline, so I did not run them. The figures below are byproducts of the runs above, one run each, from a pipeline that delivered empty frames. They describe the transport and the helper's cost, not a usable pane.

| | Electron helper (43.8.3; 45.4.1 the same within noise) | CEF helper (the CEF note) |
| --- | --- | --- |
| Pixels in the window | **None** | Real |
| H.264 and AAC | Play [m] | Do not play [m] |
| Frame cost in the window at 1280x800 (import, copy, wait), p50 / p95 | 0.58 to 0.89 ms / 0.9 to 2.1 ms [m] | 0.9 ms; the same receiver gave 0.72 / 1.42 ms as the control [m] |
| Frame cost at 2560x1600 | Not measured | 2.9 ms |
| First frame in the window | 0.38 to 0.62 s with a new profile and the files already cached; 0.90 s in the first run [m]. No cold series. | 0.3 s warm, 1.8 s cold |
| Helper memory with one page | 338 to 371 MB PSS in 9 processes [m] | 250 to 376 MB |
| Stop | 66 ms; no Electron process left 2 s later [m] | 97 to 218 ms; nothing left |
| Installed | 43.8.3: 316 MB, 270 MB with one locale, 121 MB zip. 45.4.1: 273 MB, 266 MB with one locale, 118 MB zip [m] | 333 MB with one locale |

Codecs, measured from the page in both versions (`page-state-*.json`): `canPlayType` "probably" for H.264 (`avc1.4D401E`), AAC (`mp4a.40.2`) and both together; "no" for HEVC. `currentTime` advanced at real time, with 172 to 177 frames decoded in about 6 s. For sound, the page says it is playing: the AAC track's decoded samples reached a Web Audio analyser at RMS 0.018, which is the clip's sine (amplitude 0.025), with the helper's output muted. I did not show samples leaving the machine.

## What was not checked

The brief said to stop if step 1 failed everywhere, so none of these were run:

- frame cost at 2560x1600, cold and warm first-frame series, memory after stop
- typing and clicks from the Rust window into the page (the paths are built: the receiver forwards them and the helper calls `sendInputEvent`)
- whether the hidden helper shows up under Hyprland: no window, layer or tray entry checked
- the ten-minute idle network capture
- `nv12` through Vulkan (the receiver imports single-plane formats only; the CPU map read zero)
- Electron's own `sharedTexture.importSharedTexture` path, which #53271 reports as zero too [r]
- AMD or Intel graphics, a bare Xorg session, other compositors, Windows and macOS (where `useSharedTexture` reportedly works [r])

## What this leaves

These are inferences, not measurements:

- On NVIDIA under Linux, an Electron helper can only do this with a patched Electron, or by sending each frame as a bitmap through shared memory. Electron's bitmap `paint` does fire here (the control row). A patch is the per-release maintenance burden that ruled out building CEF, though only on Linux.
- The bitmap route costs CPU per frame. The CEF note measured 1.46 ms at 1280x800 and 2.09 ms at 2560x1600 for CEF's own software path. Electron's would need its own measurement, plus a shared-memory transport that is not built.
- Windows and macOS are where Electron's shared texture is reported to work. If the bitmap route is good enough on Linux, the Electron helper is not ruled out as a whole; it is ruled out as a zero-copy pane on forge.
