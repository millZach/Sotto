# Sotto's thread screen in Slint (bake-off prototype)

The Slint half of the native UI bake-off, issue #2689. Findings: [`docs/research/2026-11-19-native-ui-bake-off-slint.md`](../docs/research/2026-11-19-native-ui-bake-off-slint.md). A prototype on `prototype/native-ui-slint`; it never merges into main, and it makes no network call. All its text is invented.

## Build and run (Linux)

```sh
export CARGO_TARGET_DIR=$HOME/.cache/sotto-cargo-target   # one build folder for every Rust worktree
cd native-ui-slint
cargo build --release
SLINT_BACKEND=winit-skia-opengl $CARGO_TARGET_DIR/release/sotto-slint --stream
```

Options: `--stream` streams the reply 1.5 s after start; `--finished` opens with it whole; `--light`; `--variant a|b|c` (the composer); `--no-tools`; `--size WxH`; `--bench --exit --out file.json` measures one stream and quits; `--launch-only` quits after the first frame. `SLINT_BACKEND=winit-femtovg` picks the other renderer.

Keys: F6 and Shift+F6 move between the transcript, composer, browser and terminal. In the transcript, Up and Down move by row, Enter opens a folded row or copies a code block, End follows the stream again. In the terminal, Tab is the shell's, Ctrl+Shift+C copies, Shift+PageUp scrolls back.

Live preview: `SLINT_LIVE_PREVIEW=1 cargo build --features live-preview`, run the debug binary, then edit any file in `ui/`.

## Layout

- `build.rs`, `themegen/css.rs`: the theme, generated from `src/shared/themes/palettes.ts` and `src/renderer/src/styles/tokens.css` into `ui/generated/theme.slint` (both modes), with a contrast report in `ui/generated/contrast.md`.
- `ui/`: the window (`app.slint`), transcript, composer, terminal, web pane and shared controls.
- `src/`: Markdown into rows and syntax colour (`markdown.rs`, `highlight.rs`, `thread.rs`), pills (`composer.rs`), the terminal (`terminal.rs`), the stand-in page (`webpane.rs`), reduced motion (`motion.rs`), measurements (`metrics.rs`).
- `content/`: the invented reply and history (`assemble.py` rebuilds `reply.md` from `parts/`).
- `web/`: the composer alone, compiled to WebAssembly for the design review link.
- `tools/`: nested Hyprland (`nested-up.sh`, `nested-down.sh`), window sizing and captures (`win.sh`, `run-shot.sh`, `captures.sh`), measurements (`bench.sh`, `launch.sh`, `edit_poll.py`, `rebuild_time.sh`, `summarize.py`), and the private-bus checks (`private-session.sh` with `a11y-session.sh`, `ime-session.sh`, `motion-session.sh`). Run the checks only through `private-session.sh`: it gives the bus daemon a private home, so nothing reaches the user's real settings.
- `electron-baseline/`: how today's Electron Sotto was measured the same way, and its results.
- `composer-reference/`: today's composer as Electron draws it (every element's box and computed style, in both themes and with each menu open), which composer A is matched to; `tools/match.sh` captures the same states in Slint and compares them. Flags for that: `--composer-text "<text>"` and `--no-focus`.
- `CRATES.md`: every crate in the build with its licence.
