# Phase 3 Windows package verification

The final local Windows application directory is [Sotto.exe](../../release/phase-three-final-707b253/win-unpacked/Sotto.exe), packaged from source `707b2535f6325c083ee85fc2230a8c58cb92ed21`. The complete strict verifier passed on the isolated checkout's package. All 259 files in the delivery copy match that verified directory byte for byte. [Verifier result](phase-3-packaged-windows.json), [copy hashes](phase-3-package-copy.json).

The verified build contains 84 application artifacts with build SHA256 `e058ba958c12fef34c5da65c24af66ffd24917a9bc047298daa4f35345191545`. These are identical to the artifacts tested by the final six Electron theme/editor journeys and four explicit keyboard-close reproductions at `e5d0a53`. The subsequent commit adds the already-used Node compression builtin to the release verifier's explicit inventory; it does not change application output. [Application output equality](../../artifacts/phase-three-focus-review/verification.json). The earlier 29 integrated Electron journeys at `387cbb8` are a separate checkpoint covering the wider feature matrix.

The verifier checked:

- Matching current source/build/ASAR provenance and exact production module roots: node-addon-api, node-pty and zod.
- Exact static/dynamic external dependency metadata, every required builtin, runtime files and notices (four runtime files and 172 notice components separately verified).
- Actual packaged SQLite 3.53.1, migration 3 and FTS5 lookup.
- Actual packaged native PTY output `SOTTO_PTY_PACKAGE_OK`, exit 0, Electron modules ABI 148 and NAPI 10.
- Normal packaged startup rejects development E2E flags and resolves the audio worklet from its installed ASAR location.

## Packaging corrections and isolation

The final build uses `.worktrees/phase3-final` so the user's existing main-checkout dev watcher cannot replace verified output. Dependencies there are a physical copy of the same installed dependency tree; no versions were installed or changed. A shared node_modules junction caused npm/electron-builder to classify node-addon-api as extraneous and omit it. The strict package inventory caught this, and rebuilding with the physical tree included all three required module roots. The verifier was not weakened.

The first complete current package also exposed a missing explicit inventory entry for `node:zlib`, imported by `src/main/themes/openVsx.ts` to inflate bounded VSIX entries. Commit `707b253` adds that exact builtin, preserving exact-list enforcement and availability checks. The regression failed before the correction; all five dependency-metadata tests pass afterward, including rejection of an unavailable compression builtin.

`node-pty` 1.1.0's Windows source rebuild fails in this checkout's spaced path when gyp cannot run `GetCommitHash.bat`. Its pinned Windows Node-API prebuild passed the actual packaged terminal probe. Windows therefore retains `npmRebuild: false`; both supported macOS package scripts explicitly enable native rebuilds. A previously tested beforeBuild hook returning false was removed because electron-builder 26.15.3 treats modules as externally handled and skips normal dependency collection. The chosen setting skips rebuilding while preserving collection.

The PTY probe resolves node-pty from the installed ASAR application with createRequire through process.getBuiltinModule; it cannot accidentally load the checkout's native module. The verifier's target must stay under its own checkout's release directory. The delivery-copy proof makes the verified isolated package usable from the main workspace without weakening that boundary.

No installer, remote release or publication was produced. Earlier verification directories are historical/failed checkpoints, not the delivery artifact. Existing release artifacts were preserved. macOS packaging and native behavior remain unverified here, and #24 is a separate release gate.
