# Restart now on Sotto Owl for a Mac

An Owl on a Mac downloaded an update. Pressing **Restart now** raised Electron's "A JavaScript error occurred in the main process: TypeError: Object has been destroyed", from `removeRenderProcessGoneListener` during window clean-up. The window could be brought back, and pressing **Restart now** again only hid it. The update never installed.

## Cause

Two faults, found in Electron 43.8.3 with a scratch app that calls `autoUpdater.quitAndInstall()` with no feed, so nothing installs. Two more came out of review.

On a Mac, electron-updater's `quitAndInstall` is two steps. Sotto keeps `autoInstallOnAppQuit` off, so Squirrel.Mac has not fetched the update yet: the call starts the fetch and returns. Seconds later, with the update in hand, electron-updater calls Electron's own `autoUpdater.quitAndInstall()`. That does not quit. It emits `before-quit-for-update`, closes every window, and installs and quits only once they are all gone (`before-quit` comes after them, as Electron's `app` documentation says). On Windows electron-updater calls `app.quit()` instead, so Sotto's ordinary quit runs first and none of this happened.

- The main window hides to the tray when closed, unless a quit has begun, and no quit had begun. It hid, and the install waited for a window that would never close. The second press did the same.
- The widget window has no such handler and closed for real. Its clean-up then read `window.webContents` on the closed window, which throws "Object has been destroyed", out of the `closed` event. That is the dialog.
- The call returns at once, so **Restart now** can be pressed again while Squirrel is still fetching. electron-updater then starts a second fetch, which Squirrel refuses ("The command is disabled and cannot be executed"). The update service read that as the installer refusing and called the restart off just before the windows closed, so the main window hid again and the update stayed stuck. A first version of this fix began the quit when **Restart now** was pressed and had exactly this hole.
- Electron keeps watching for the last window to close after its own `quitAndInstall` refuses. Whenever that happens later, it announces the restart again and retries. A quit begun on every announcement would then leave Sotto, after a refusal and a later loss of its last window, unable to show one.

Without the fix, with the main window hiding on close as Sotto does:

```
[repro] before-quit-for-update, windows = 2
[repro] widget close event
[repro] main close event, quitting = false
[repro] main close prevented, window hidden
[repro] removeListener via window.webContents THREW: Object has been destroyed
[repro] removeListener via cached webContents: ok
[repro] after 1.5s: windows = 1 | main destroyed = false | widget destroyed = true
```

With the close allowed once `before-quit-for-update` arrives:

```
[repro] before-quit-for-update, windows = 2
[repro] widget close event
[repro] main close event, quitting = true
[repro] removeListener via window.webContents THREW: Object has been destroyed
[repro] removeListener via cached webContents: ok
[repro] before-quit-for-update, windows = 0
[repro] autoUpdater error (after all windows closed): No update available, can't quit and install
[repro] after 1.5s: windows = 0 | main destroyed = true | widget destroyed = true
```

Both windows close and the install goes ahead; here it ends in Electron's refusal, because the scratch app staged nothing. Electron announces the restart a second time once the last window has closed, and a refusal arrives after that. A refusal can also come before any window closes, when Squirrel's fetch fails.

## What changed

- `ElectronBrowserWindowAdapter` keeps the web contents it was given and takes its listeners off that, not off `window.webContents`.
- The window manager runs each clean-up step on its own. One that throws is logged as `renderer-cleanup-failed` and the rest still run, so a closed window can no longer raise an uncaught exception from `closed`.
- Main begins the quit when Electron announces `before-quit-for-update` and the update service has a restart under way: a Mac says it just before closing the windows, and electron-updater says it on Windows just before `app.quit()`. Nothing changes while Squirrel is still fetching, and an announcement with no restart under way changes nothing.
- The update service calls `restartRefused` when the installer refuses, however late. Main calls the quit off and shows the main window, so a refused restart puts the window back with the reason on its update card. A press of **Restart now** while a restart is under way starts nothing again.
- The development end-to-end updater can now do what a Mac's installer does: its restart announces itself, closes every window, announces again, and only then refuses.

## Evidence

- Twelve new unit tests, in `updateService`, `windowRecovery` and `mainWindowLifecycle`.
- `tests/e2e/window-closed-by-electron.spec.ts` destroys the main window in the built app and reads main's uncaught exceptions and its log. `tests/e2e/restart-to-update.spec.ts` presses **Restart now** with that updater: both windows close for real, nothing throws, the refusal brings a main window back with the reason on the update status, and closing that window hides it again even after a further announcement.
- Each fix, taken out alone, fails a test:

  | Taken out | Fails |
  | --- | --- |
  | The adapter reading `window.webContents` again | both end-to-end specs (the clean-up is logged as failed) |
  | The `try` around each clean-up step | the `windowRecovery` test |
  | The `before-quit-for-update` listener | `restart-to-update` (the main window hides, nothing comes back) |
  | `cancelQuit` after a refusal | `restart-to-update` (no window is made again) |
  | The check that a press during a restart starts nothing | the `updateService` test |
  | The listener's check that a restart is under way | `restart-to-update` (the window is destroyed, not hidden, after a further announcement) |

- The built app on a Mac, with a temporary stand-in whose `quitAndInstall` calls Electron's own, so the real close-every-window path runs and nothing installs. Windows before: widget and main. Events seen in main:

  | | Original sources | Fixed |
  | --- | --- | --- |
  | Widget | close, then its clean-up threw | close, closed |
  | Main window | close, hide | close, closed |
  | Uncaught exception | `Object has been destroyed` | none |
  | After | main window hidden, nothing else said | both windows back and visible, update phase `downloaded` with the problem "No update available, can't quit and install" |

  With the same stand-in, every window was then destroyed outside a quit and the Dock was clicked. Fixed: both windows came back. With the listener beginning a quit on every announcement: none did.

## Not verified

An install by Squirrel.Mac itself. It needs a build signed by Sotto's Developer ID and a newer one to move to (ADR-0093); the scratch runs stop at Electron's refusal. How long Squirrel's fetch takes on a real Owl, and the second press's refusal from Squirrel, were taken from electron-updater's code and the review, not seen. A fetch that neither finishes nor fails would leave **Restart now** doing nothing until Sotto restarts; Squirrel's own network timeout should end it with an error, which is a refusal. Windows and Linux were not run; Windows goes through `app.quit()`, and Linux has no in-app updater. The two end-to-end specs run locally: CI's desktop check runs a selected few, and these are not among them.
