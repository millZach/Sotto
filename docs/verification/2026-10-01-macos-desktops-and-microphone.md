# macOS desktops and the microphone test

October 1, 2026, on `feat/macos-bringup` rebased onto `main`. Host: Apple silicon Mac, macOS 26, Node 24.2.0, Electron 43.1.0, two displays (built-in 1512×982 points and a 3840×1600 external). Unpackaged app (`npx electron .`) with the real profile. Tracking: #169, #670.

## Why the main window sat on other apps' full-screen desktops

Sotto hid its Dock icon at startup and whenever the main window closed, and showed it again with the window. A throwaway Electron 43 app measured what that does. A second Electron process held a native full-screen window, and the probe app then showed a window. The on-screen window list (`CGWindowListCopyWindowInfo` with `optionOnScreenOnly`) says whether the full-screen app was still showing:

| Probe app | Full-screen app still on screen |
|-----------|---------------------------------|
| Ordinary window, Dock never hidden | no: macOS moved to the window's own desktop |
| `app.dock.hide()`, then `app.dock.show()`, then the window | **yes**: the window sat on the full-screen desktop |
| The same, waiting 3 s after `dock.show()` | **yes** |
| `setActivationPolicy('accessory')`, then `'regular'` | **yes** |
| Pill with `setVisibleOnAllWorkspaces(…, skipTransformProcessType)` and no Dock change | no |

Once the process has been an accessory app, its windows keep that ability for the rest of the run. That is why every Sotto window behaved like the pill, whatever the main window's own flags said.

In an app that never hid its Dock, an ordinary pill window does not show over another app's full-screen desktop, and a `type: 'panel'` pill does. With a panel pill and an ordinary main window in the same app, the pill stayed over the full-screen app and the main window still went to its own desktop.

So macOS keeps its Dock icon for the whole run (`dockPresence: 'regular'`), and the pill is a panel (`widgetIsPanel`).

## In the running app

With a native full-screen window on the external display and Sotto running from this branch:

- Sotto is a foreground application (`lsappinfo`: `ApplicationType = Foreground`), with its Dock icon.
- The pill, at the external display's left edge, shows over the full-screen app: `artifacts/macos-bringup/pill-over-full-screen.png`.
- A drag of the main window by its title strip from the built-in display towards the external one (synthesized mouse events) leaves the window straddling the display edge. The part over the full-screen display is not drawn: `artifacts/macos-bringup/main-window-stays-off-full-screen.png` shows only the full-screen app and the pill.

The packaged checklist lines in `docs/release/macos-bringup.md` stay unticked until the packaged app is checked the same way.

## Microphone test

Driven over the remote debugging port with Playwright against the live app:

- Right after launch, the page lists four inputs with labels: the default, the MacBook Pro microphone, an HD Pro Webcam C920, and a virtual Teams device.
- The saved microphone was a C922 that is no longer connected. Test reported "The chosen microphone is not connected. Plug it in or choose another."
- After choosing the C920, Test reached `ready` within 0.4 s, and the level meter showed room noise around 0.001 to 0.003. With nobody speaking, Stop reported "Sotto did not hear anything."

## What ran

- `npm run typecheck`, `npx eslint .`, `npm run notices:verify` (174 components)
- `npm test -- --maxWorkers=2` on this Mac: 7077 passed, 151 skipped, 3 failed in the new terminal key test, whose fake terminal lacked the selection API `main` started using; after that fix the file passes (3 of 3)
