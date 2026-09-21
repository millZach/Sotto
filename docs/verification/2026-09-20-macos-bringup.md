# Apple silicon macOS bring-up

September 20, 2026, on `feat/macos-bringup` at `ffced2ca` plus the README minimum-version line. Host: Apple silicon Mac, macOS 26.5.2, Node 24.2.0 (same as CI). Tracking: #169.

This is the first live Mac pass. Windows evidence is not repeated here.

## What ran

- `npm ci`, `runtime:prepare`, `runtime:verify`, `lint`, `typecheck`
- `npm test -- --maxWorkers=2`: **3968 passed, 36 skipped**
- `npm run package:dir:mac` packaged `release/mac-arm64/Sotto.app`
- Signature: `codesign -dv` reports `Signature=adhoc`; `codesign --verify --deep --strict` passed; `spctl -a` **rejected** as expected for an unsigned build
- Bundle id `com.sotto.desktop`; `LSMinimumSystemVersion` **12.0** (README had 11)
- Packaged `node:sqlite` probe (ADR-0003, previously deferred):

```text
ELECTRON_RUN_AS_NODE=1 release/mac-arm64/Sotto.app/Contents/MacOS/Sotto scripts/probe-memory-store.mjs
{"sqliteVersion":"3.53.1","migrationVersion":4,"matchedId":"memory-probe","fts5":true}
```

`node-pty` rebuilt during `package:dir:mac` (`--config.npmRebuild=true`). The in-app Playwright packaged PTY/memory probe started Sotto and then hung waiting for `firstWindow` (see below), so the PTY ABI check inside that verifier did not finish. The Electron-as-Node sqlite probe above did.

## Suite fixes that had to land first

Node 22 on this Mac failed 65 tests. Three host mismatches, not product regressions:

1. `os.tmpdir()` is `/var/folders`, a symlink to `/private/var/folders`. Git and `fs.realpath` return the physical path. Test setup now points `TMPDIR` at the real path, the same idea as CI's long Windows TEMP.
2. CI is Node 24. Node 22 can `require('node:sqlite')` but does not list it in `builtinModules`, so the release inventory check failed.
3. Terminal fixtures inject `platform: 'win32'` while `path.join` on darwin is POSIX. Shell discovery and names now use `path.win32` when the logical platform is Windows.
4. E2E admission and Grok `GROK_HOME` tests used `C:\…` paths, which `path.isAbsolute` rejects here.

## Still open on this machine

- **Packaged Playwright smoke** (`verify-packaged-resources.mjs` → `verifyNormalPackagedLaunch`) launched Sotto, wrote `workspace.json` / `threads.sqlite`, then never returned from `application.firstWindow({ timeout: 45_000 })`. The 45s timeout did not fire. Killed after several minutes. This blocks `package:dir:mac` from completing its last step and therefore blocks `package:mac` until it is fixed or the wait is made to fail.
- **Functional pass** of dictation, Accessibility paste, menu bar, Dock, hotkey, widget, traffic lights, and login item: not yet signed off. Needs the GUI session and TCC prompts.
- **Hardened runtime** experiment (bring-up §5): not run.
- **Quarantined DMG** rehearsal: not run; packaging did not finish.
- **Devin live** and **#74** macOS journeys: not this note.

## Do not

Do not run `npm run design:capture` on this Mac. Do not add a Mac updater, Intel target, or hosted macOS CI without superseding ADR-0001.
