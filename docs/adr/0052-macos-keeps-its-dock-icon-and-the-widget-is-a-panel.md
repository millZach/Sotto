# macOS keeps its Dock icon and the widget is a panel

October 9, 2026 amendment: [ADR-0065](0065-remove-voice-control-and-thread-management.md) records the removal. The widget no longer expands to show threads, so the thread-button focus consequence below is historical. The dictation widget remains a macOS panel and Sotto keeps its Dock icon.

Accepted October 1, 2026 (#670).

## Context

On macOS, Sotto hid its Dock icon at startup and whenever the main window closed, and showed it again with the window. The widget had to float over other apps' full-screen desktops, and Electron's `visibleOnFullScreen` gets that by turning the whole process into an accessory app, which hides the Dock anyway.

Tomas found that the main window could sit on other apps' full-screen desktops, which no ordinary Mac app allows. A throwaway Electron 43 app measured the cause (`docs/verification/2026-10-01-macos-desktops-and-microphone.md`). Once a process has been an accessory, through `app.dock.hide()` or `setActivationPolicy('accessory')`, every window it shows can join another app's full-screen desktop for the rest of the run. That holds even after it turns regular again. An app that never hid its Dock moves to the window's own desktop instead. Each hide of the dynamic Dock left all of Sotto's windows behaving like the widget.

In an app that never becomes an accessory, an ordinary widget window does not show over another app's full-screen desktop. A window of Electron's `panel` type, a nonactivating `NSPanel`, does.

## Decision

- On macOS, Sotto never hides its Dock icon. It is there for the whole run, and the red close button hides the window to the menu bar while the icon stays. A Dock click opens the window again.
- The widget is a panel on macOS (`widgetIsPanel`). It keeps `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })`. `skipTransformProcessType` stops Electron from hiding the Dock for the whole process.
- Windows is unchanged: its widget is an ordinary window.

## Consequences

- The Dock icon is visible while Sotto runs, as for most Mac apps. The guide and the bring-up checklist say so.
- A full-screen Sotto keeps its own desktop until the user goes there (#670's activation guard), and the main window stays off other apps' full-screen desktops.
- The widget becomes key without activating Sotto when it expands to show threads. That presentation holds only buttons today; a text field there needs a check that typing reaches it.
- Reintroducing `app.dock.hide()`, `setActivationPolicy('accessory')`, or `setVisibleOnAllWorkspaces` without `skipTransformProcessType` brings the bug back for every window. A Dock that comes and goes would need another way to keep the main window off full-screen desktops.

## Considered

- **Keep the dynamic Dock and change only the main window's flags.** The main window already reported one desktop, level 0 and no sticky bit while it sat on a full-screen desktop. Its flags are not what grants that, so no flag on it can take it away.
- **Raise the widget to the `screen-saver` level.** The widget was never what failed, and the level does not change which desktops a window may join.
- **Hide the Dock only while the main window is closed.** Every hide leaves the process accessory-marked, so the next time the window opens it can sit on a full-screen desktop again.
