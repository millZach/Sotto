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

## Onboarding microphone picker

The first live onboarding test on this Mac used the system default input, the built-in MacBook Pro microphone, with the lid shut. The meter stayed at 0. Settings already stored `microphoneId`; onboarding did not offer a choice, and the worklet test ignored the stored id.

Onboarding now lists detected inputs after the first capture (Chromium withholds labels until then). Choosing **C922 Pro Stream Webcam** and retesting produced a live meter (`aria-valuenow` non-zero, `data-speaking=true`). The same picker remains in Settings. Dictation already honored `microphoneId`; the onboarding and Settings tests now do too.

The capture itself stayed open after Test (state `ready`, **Retest microphone**). The wave still dropped after ~300 ms of quiet because the dictation voice gate treats low RMS as silence. The onboarding and Settings tests now hold the wave on for the whole open stream; the widget and Dictate room still gate on voice.

## Connect providers, 28 September 2026

The packaged app Tomas had been running was launched from the Dock. Its PATH was `/usr/bin:/bin:/usr/sbin:/sbin`. Claude Code 2.1.281 is at `~/.local/bin/claude` and signed in (`claude.ai`, subscription `max`). Grok 1.0.41 is at `~/.grok/bin/grok`. Codex is not installed. **Connect providers** on an install whose enabled set is only the default provider tries Codex.

A failed connect left the coordinator on `connecting`. With more than one native host, the failure did not clear that flag, so the Threads button stayed **Connecting...** after Codex had already exited. It now returns to **Connect providers**, and the empty workspace shows the error.

A Dock launch now keeps the system PATH and adds the login shell's directories that exist (`~/.local/bin`, `~/.grok/bin`, `/opt/homebrew/bin`, and the rest of that PATH). It does not copy the rest of the login environment. Claude's child also needs `USER` / `LOGNAME`; without them `claude auth status` reports logged out and the connection check failed closed.

Unpackaged Electron, isolated profile, PATH forced to the Dock default:

- Threads: alert "Install Codex and sign in before connecting this provider." Button **Connect providers** enabled. `artifacts/macos-bringup/connect-providers-failed.png`
- Settings → Providers: Claude Code **Connected** (`artifacts/macos-bringup/provider-claude.png`). Grok Build **Needs attention** (`provider-grok.png`). That capture's error, "Sotto requires Grok CLI 1.0.5, ACP 1 … Grok sent an invalid response", is the exact pin from before ADR-0042, when the handshake schema accepted only agent version 1.0.5, so 1.0.41 failed to parse. The build captured predates the floor; current code treats 1.0.5 as the oldest accepted client, and the installed Grok (1.0.46 on 1 October) answers `initialize` with ACP 1, `loadSession`, and a `cached_token` sign-in, which it accepts. Codex **Needs attention**, not installed (`provider-codex.png`). None of the three stayed on Connecting.

**Connect providers** was still aimed at the saved default, Codex. A bulk connect now checks which of Codex, Claude Code and Grok Build are installed when that selection is missing, and uses Claude Code when Codex is not. On this profile that saved `provider: 'claude'` and `enabledProviders: ['claude', 'grok']`.

## Still open on this machine

- **Packaged Playwright smoke** (`verify-packaged-resources.mjs` → `verifyNormalPackagedLaunch`) launched Sotto, wrote `workspace.json` / `threads.sqlite`, then never returned from `application.firstWindow({ timeout: 45_000 })`. The 45s timeout did not fire. Killed after several minutes. This blocks `package:dir:mac` from completing its last step and therefore blocks `package:mac` until it is fixed or the wait is made to fail.
- **Functional pass** of dictation, Accessibility paste, menu bar, Dock, hotkey, widget, traffic lights, and login item: not yet signed off. Needs the GUI session and TCC prompts.
- **Hardened runtime** experiment (bring-up §5): not run.
- **Quarantined DMG** rehearsal: not run; packaging did not finish.
- **Devin live** and **#74** macOS journeys: not this note.

## Do not

Do not run `npm run design:capture` on this Mac. Do not add a Mac updater, Intel target, or hosted macOS CI without superseding ADR-0001.
