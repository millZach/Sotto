# Linux desktop startup — issue 835

This checks the unpackaged desktop on forge: Omarchy, Arch Linux, Hyprland 0.56 on Wayland, Electron 43.1.0 and Node 24.21.0. The work starts from `c53d2908c28f82c3f3afc3048ef3d43bb153dcb3` on `feat/linux-platform-profile`.

## Scope and decisions

Linux now has its own platform ID, PNG tray, no frost, no in-app updater and clipboard-only output. It keeps Windows' window controls and Ctrl shortcut labels. Chromium uses `gnome-libsecret` on Linux unless the caller passed a password-store switch. An unavailable store still refuses to save a key.

The tray reuses `resources/tray/sottoTemplate.png`. The main build's public directory is limited to `resources/runtime`, so electron-vite emits the tray's asset import under `out/main`, which the existing app packaging includes. With the default public directory of `resources`, electron-vite leaves that import pointing at the source tree. macOS keeps its existing template and @2x resource lookup.

[ADR-0025](../adr/0025-headless-host-and-client-identity.md) still describes Linux as host-only. The owner's [map #833](https://github.com/millZach/Sotto/issues/833) and [ticket #835](https://github.com/millZach/Sotto/issues/835) authorize this unpackaged bring-up; [#834](https://github.com/millZach/Sotto/issues/834) owns the desktop-platform ADR and release decision. This branch changes no installer targets, packaging commands or release scripts.

Linux system speech reports that it is unavailable rather than invoking macOS' `say`. Onboarding, Help and Settings explain clipboard-only output and the missing Wayland shortcut. The window controls and styles are unchanged.

## Checks

All commands used `mise exec node@24.21.0 --`. The final gates pass:

| Command | Passed | Failed | Skipped |
| --- | --- | --- | --- |
| `npm run typecheck` | 3 TypeScript projects | 0 | 0 |
| `npm run lint` | 1 lint run, no errors | 0 | 0 |
| `npm test -- --maxWorkers=2` | 8,940 tests in 609 files | 0 | 182 tests in 50 files |
| `npm run notices:verify` | 174 components | 0 | 0 |

The full test run took 482.88 seconds. jsdom reported its missing canvas implementation, and libvips reported the unavailable optional OpenSlide library; neither caused a failure. The build and Linux Playwright journey also pass.

The diff was reviewed against AGENTS.md and issue #835 separately. Every exhaustive platform table has a Linux row; Windows and macOS retain their existing values and commands. The renderer still uses preload IPC, no host or runtime dependency was added, and no permission is answered on the user's behalf. The build configuration change emits the PNG without changing installer targets or release scripts.

`npm run build` emitted `out/main/chunks/sottoTemplate-BL3AAFy-.png`. The emitted PNG and its source both have SHA-256 `1da69e751674bb06abbe5210d7f88762b8a3322675b48d7b07e9ec786d924a9f`. The built main entry has SHA-256 `88ec5de7539f7f07bd2379ca588195be15471d71853e5f57a3f8c58037361d73`.

The required probe ran directly from this checkout, without a caller-supplied password-store switch:

```sh
mise exec node@24.21.0 -- node /home/zach/Projects/Sotto/.zstack/probe-storage.mjs /tmp/sotto-835-probe
```

```json
{"ready":true,"passwordStore":"gnome-libsecret","available":true,"backend":"gnome_libsecret"}
```

The separate real onboarding and key-save check returned:

```json
{"pid":2389953,"ready":true,"passwordStore":"gnome-libsecret","available":true,"backend":"gnome_libsecret","keySaved":true,"keyRoundTrip":true,"keyAbsentFromSettings":true,"onboarding":true,"trayOwnedByProcess":true}
```

While that process ran, `busctl --user get-property org.kde.StatusNotifierWatcher /StatusNotifierWatcher org.kde.StatusNotifierWatcher RegisteredStatusNotifierItems` returned:

```text
as 1 ":1.5924/org/chromium/StatusNotifierItem/1"
```

`GetConnectionUnixProcessID` attributed that item's bus name to PID 2389953. The harness stopped that PID and its earlier attempts (2385982 and 2387100) after each check. The required probe stops its own child by PID. Both inspector ports were closed after the checks.

`tests/e2e/linux-platform-profile.spec.ts` passed (one passed, zero failed, one worker). It drives first-run setup and key saving, keeps the Windows-style controls, checks the disabled updater through a manual check, then finishes a scripted dictation and verifies the exact copied transcript with zero paste attempts. Dictate shows **Copied.** with Linux's manual-paste hint; the widget keeps **Copied — paste manually**.

The first full Linux run had 607 passing files, two failed files and 50 skipped files; 8,927 passing tests, one failed test and 182 skipped tests. Both failures also reproduce on an archive of unmodified `c53d290` inside this worktree:

- `providerClientUpdates.test.ts` → `which channel owns an install` → `leaves a client whose own installer owns its binary to update itself`: expected `self-update`, received `mise`. The fixture fell through to forge's actual mise data. It now names its own absent mise folder.
- `packagedMemoryProbe.test.mjs` failed to collect: `Sotto release verification supports win32 and darwin only, not linux`. Its Electron launch is scripted, but its release profile was still selected from the test machine. On Linux, the fixture now selects the existing Windows release profile; Windows and macOS keep their previous selection. The actual release verifier still rejects Linux.

The baseline reproduction ran these two files with two workers: two failed files, 31 passing tests, one failed test and two skipped tests. After fixture isolation, the same two files pass: 44 passing tests and two skipped tests. No assertion was removed or relaxed, and no production installer or provider detection changed.

The desktop screen was locked. Startup, onboarding, key storage and tray ownership are checked through the real main process and renderer DOM, without screen captures. The synthetic key used for storage never goes to OpenRouter. `tools/verify-linux-platform.mjs` repeats the direct Electron launch with the Hyprland session environment, clicks through onboarding, saves the key through the actual field's blur handler, checks encrypted disk storage and attributes the tray item through D-Bus. It stops its Electron process by PID.

Linux packaging, Windows and macOS desktop execution, visual appearance on the locked screen, microphone capture, global shortcuts, Hyprland paste and system speech are not established by this check. The follow-up map owns the Linux shortcut (#837), paste (#838), chrome and widget prototype (#839), themes (#840) and packaging (#841).
