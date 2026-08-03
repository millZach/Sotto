# macOS bring-up checklist (Apple Silicon)

First-time validation of the macOS build, run on an Apple Silicon Mac. Background and rationale: `docs/adr/0001-macos-unsigned-arm64-distribution.md`. User-facing install steps: README "Install and first run" → macOS.

## 0. Prerequisites

- Apple Silicon Mac (arm64). Intel is not supported.
- Xcode command-line tools: `xcode-select --install`
- Node 22+, `gh` authenticated (for the release upload at the end).
- Network on first build (~400 MB: Electron darwin-arm64, electron-builder icns/dmg toolsets, the bundled model) and ~5 GB free disk.
- A real `git clone` (not a source zip) — build provenance runs `git rev-parse HEAD`.

## 1. Build and unit-verify

```bash
git clone https://github.com/millZach/Sotto.git && cd Sotto
git checkout <branch-or-tag>
npm ci
npm run model:prepare && npm run model:verify
npm run lint && npm run typecheck && npm test
npm run package:dir:mac
```

Notes: the widget-topmost e2e spec self-skips off Windows; do **not** run `npm run design:capture` on the Mac (golden images are Windows-DPI-specific).

## 2. Signature checks (before anything else)

```bash
codesign -dv --verbose=4 release/mac-arm64/Sotto.app    # MUST show: Signature=adhoc
codesign --verify --deep --strict release/mac-arm64/Sotto.app
spctl -a -vvv release/mac-arm64/Sotto.app               # REJECTED is expected (unsigned build)
```

If `codesign -dv` does not show an adhoc signature, stop — the app will not launch for anyone. `identity: '-'` in `electron-builder.yml` was not applied.

## 3. Functional pass

Launch `release/mac-arm64/Sotto.app` and work through:

- [ ] Onboarding completes; microphone prompt appears on first dictation; dictation transcribes.
- [ ] Auto-paste into TextEdit and Chrome: the "Sotto wants to control System Events" (Automation) prompt fires; grant Accessibility in System Settings when prompted. Note end-to-end paste latency — if it feels > ~250 ms, file an issue (a warm osascript helper is the planned follow-up).
- [ ] Deny-path check: with Accessibility or Automation denied, dictation still lands on the clipboard and the explanatory toast appears.
- [ ] Menu-bar icon renders correctly in light AND dark menu bar (template image, not a color blob).
- [ ] Dynamic Dock: Dock icon appears when the main window opens, disappears when it closes; reopen works from the menu-bar icon; Dock click while visible re-shows the window.
- [ ] App menu: ⌘C/⌘V in Sotto's own text fields, ⌘M minimize, ⌘Q quits cleanly, Settings… (⌘,) opens the window.
- [ ] Hotkey: Control+Shift+Space (literal Control) toggles dictation; rebinding in Settings works and labels render as mac glyphs.
- [ ] Widget: floats above normal windows, follows across Spaces, visible over a full-screen app; drag gesture works. Known escape hatches if not: `widgetFocusable` and `widgetAlwaysOnTopLevel: 'screen-saver'` in `src/main/platformProfile.ts`.
- [ ] Red traffic-light close hides to menu bar (app keeps running); traffic lights sit correctly in the title bar.
- [ ] "Launch when your Mac starts" toggle registers a login item (System Settings → General → Login Items) and survives relaunch.

Permission grants are keyed to the code signature: **every rebuild re-prompts**. Clean slate between builds:

```bash
tccutil reset Microphone com.sotto.desktop
tccutil reset AppleEvents com.sotto.desktop
tccutil reset Accessibility com.sotto.desktop
```

## 4. Read real values back into the docs

```bash
/usr/libexec/PlistBuddy -c 'Print :LSMinimumSystemVersion' release/mac-arm64/Sotto.app/Contents/Info.plist
/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier'      release/mac-arm64/Sotto.app/Contents/Info.plist  # expect com.sotto.desktop
```

Replace the `TODO(mac-bringup)` macOS version in README Requirements with the real `LSMinimumSystemVersion` value and commit.

## 5. Hardened-runtime measurement (one-time decision)

Flip `hardenedRuntime: true` in `electron-builder.yml`, rebuild `package:dir:mac`, repeat steps 2–3 (launch + mic prompt are the two things that can break). Keep whichever setting launches AND prompts for the microphone; record the outcome in the ADR. `true` shrinks the future notarization diff to nothing.

## 6. DMG + quarantine rehearsal

```bash
npm run package:mac        # produces release/Sotto-<version>-arm64.dmg, verifier mounts and byte-checks it
```

A locally built DMG carries no quarantine flag, so fake what users see — do not skip:

```bash
xattr -w com.apple.quarantine "0081;00000000;Safari;" release/Sotto-*.dmg
```

Open the DMG, drag to /Applications, and follow the README's macOS install steps **verbatim as a naive user** (ideally in a fresh macOS user account). Correct the README if any dialog wording differs on the current macOS version.

## 7. Release upload

```bash
cd release
shasum -a 256 Sotto-<version>-arm64.dmg >> SHA256SUMS.txt      # two-space format
gh release upload v<version> Sotto-<version>-arm64.dmg Sotto-<version>-arm64.dmg.blockmap --clobber
# SHA256SUMS.txt is uploaded LAST, after BOTH machines (Windows + Mac) have appended their lines.
```

Release notes must carry: "Apple silicon (arm64) only", "not signed or notarized", the Gatekeeper instructions from the README, and the DMG's SHA-256. See CLAUDE.md "Release artifacts" for the two-machine ritual.
