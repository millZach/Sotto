# Window Controls and Multi-Monitor Pill Drag Design

**Date:** 2026-07-21

## Summary

TalkType will use one custom title bar on every main-window screen and remove the redundant native Windows frame. The floating dictation pill will remember only a screen edge, center itself on that edge with a fixed 16 DIP inset, follow the monitor containing the cursor in every widget state, and use a recoverable, DPI-safe drag lifecycle.

## Problems

### Duplicate window controls

The main `BrowserWindow` currently uses Electron's default native frame while `AppShell` renders a second custom title bar. Both sets contain minimize and close controls. Loading, unavailable, and onboarding screens return before `AppShell`, so they currently depend on the native frame.

### Unreliable and stuck pill dragging

The current pill can remain in a drag session when pointer capture or a terminal pointer event is lost. While that state is active, normal widget publication and native moved-event snapping refuse to reposition the window. The idle pill also begins as a click-through native window and becomes interactive only after an asynchronous renderer-to-main hover request, so a quick press can pass through to the application underneath.

The current display-session lock conflicts with the desired behavior. It keeps the widget on the monitor where dictation started, even after the cursor moves elsewhere. Dragging also combines renderer `screenX`/`screenY` deltas with Electron window coordinates without establishing that the coordinate spaces remain compatible across per-monitor DPI boundaries.

## Goals

1. Show exactly one custom TalkType title bar on loading, unavailable, onboarding, and normal application screens.
2. Preserve minimize-to-taskbar and close-to-tray behavior.
3. Let a drag select only the nearest edge: top, bottom, left, or right.
4. Center the pill along the selected edge and keep it 16 DIPs inside the monitor work area.
5. Move the pill to the monitor containing the cursor while idle, listening, processing, or displaying a result.
6. Pause automatic monitor following only while the user is actively dragging the pill.
7. Make drag initiation and completion reliable when pointer capture is lost or the renderer lifecycle changes.
8. Keep movement correct across differently scaled monitors by using Electron DIP coordinates.
9. Avoid native-window move backlogs from high-rate pointer devices.

## Non-goals

- Remembering a separate edge or position for each monitor.
- Preserving arbitrary offsets along an edge.
- Adding maximize or restore controls.
- Replacing the existing click-to-start, click-to-stop, stop, or cancel interactions.
- Moving the entire drag implementation to an OS-specific global mouse hook.

## Main-window design

### Shared title bar

Extract the existing title-bar markup and behavior from `AppShell` into a reusable `AppTitlebar` component. A root main-window frame will render `AppTitlebar` around every application branch:

- loading;
- unavailable/startup failure;
- onboarding; and
- the normal management shell.

`AppShell` will retain navigation, status, and page-content responsibilities but will no longer own the title bar. This prevents nested or duplicate custom chrome.

The title bar remains a `-webkit-app-region: drag` region. Minimize and close controls remain `-webkit-app-region: no-drag` and invoke the existing trusted renderer actions. Close continues to hide the app unless the main process is already quitting.

### Frameless Electron window

The main `BrowserWindow` constructor will set `frame: false`. The custom title bar therefore becomes the only visible window chrome. Existing dimensions, minimum dimensions, background color, menu behavior, and secure web preferences remain unchanged.

## Pill placement model

### Edge-only persistence

The semantic placement model becomes:

```ts
type WidgetPlacement = {
  edge: 'top' | 'bottom' | 'left' | 'right'
}
```

A drag ending anywhere on a monitor chooses the nearest edge. Ties keep the existing deterministic priority unless tests establish a more intuitive ordering. Placement resolution always centers the widget along that edge:

- top/bottom: centered horizontally;
- left/right: centered vertically; and
- all edges: 16 DIPs inside the target work area.

The fixed inset is measured from Electron's work area, so taskbars and reserved desktop areas remain respected.

### Storage migration

The placement repository will write a new edge-only record version. Existing version-two `{ edge, offset }` records retain `edge` and discard `offset`. Legacy raw coordinate records resolve to their nearest edge on the referenced display and then center on that edge. Invalid records fall back to the default bottom edge.

No display identifier is persisted because the pill follows the cursor's current monitor rather than a preferred monitor.

### Cursor-monitor following

The main process will periodically compare the display containing `screen.getCursorScreenPoint()` with the display used for the pill's last resolved bounds. Electron does not expose a global cursor-monitor-change event, so a lightweight check is required while the widget is visible.

The check will:

1. read the Electron cursor point;
2. resolve the nearest display work area;
3. do nothing if the work area is unchanged;
4. otherwise resolve the remembered edge against the new work area and reposition the widget; and
5. avoid `setPosition` and `setSize` calls when the desired bounds are already applied.

The monitor check runs in every widget state and pauses while drag ownership is active. It stops when the widget is hidden, destroyed, or the window manager is disposed. A drag end snaps on the display containing the actual native window, then monitor following resumes.

The existing dictation-session display lock is removed because it contradicts continuous cursor following.

## Native widget bounds and hit testing

The idle widget will no longer rely on this sequence:

1. keep a large transparent native canvas click-through;
2. receive a forwarded renderer hover event; and
3. asynchronously ask the main process to make the window interactive.

Instead, the native widget bounds will follow the actual interactive presentation, with only the minimum transparent clearance required for the intended shadow. Presentation modes are:

- resting idle sliver;
- hovered idle pill;
- active horizontal or vertical capsule; and
- dragging.

The native window remains interactive for its visible footprint, eliminating the first-press passthrough race without leaving the existing large transparent rectangle over another application. Hover and state transitions resize and re-anchor the native bounds through the main-process placement coordinator.

The idle pill remains expanded for the duration of a drag. It does not collapse to the thin sliver under the captured pointer. After drag completion and snapping, it may return to its resting presentation.

## Placement coordinator

`WindowManager` will be the only component that applies native widget size and position. Widget publication, cursor-monitor following, presentation changes, dragging, and snapping all resolve through a single coordinator.

The coordinator tracks:

- remembered edge;
- current display work area;
- current presentation footprint;
- last successfully applied bounds;
- whether a programmatic move is being applied; and
- active drag ownership.

This replaces the current competing behavior among `showWidget`, the session display lock, drag movement, cached reveal coordinates, and the native `moved` fallback. Native moved events must not recursively snap moves initiated by the coordinator.

## Drag lifecycle

### Renderer responsibility

The renderer owns gesture classification only:

1. accept the primary-button pointer down on the sliver or capsule;
2. attempt pointer capture;
3. classify movement beyond the existing threshold as a drag;
4. emit one drag start;
5. coalesce move notifications to at most one per animation frame; and
6. emit one terminal drag notification.

Buttons within the capsule continue stopping pointer propagation so stop and cancel actions cannot begin a drag.

A single idempotent finish path handles:

- `pointerup`;
- `pointercancel`;
- `lostpointercapture`;
- window blur;
- document visibility loss; and
- component unmount.

If a movement is queued, the renderer flushes that notification before ending the drag. A completed drag suppresses the synthetic click that follows pointer-up. Cancellation and lifecycle cleanup still release main-process drag ownership and snap the last valid native position.

### Main-process responsibility

At drag start, the main process records:

- the native widget origin; and
- Electron's current cursor point.

On each coalesced move notification, the main process reads the current Electron cursor point and applies the cumulative DIP delta from the recorded cursor origin to the native window origin. Renderer `screenX` and `screenY` deltas are not mixed with Electron window coordinates.

At drag end, the main process clears drag ownership, determines the display containing the native window center, selects the nearest edge, resizes for that edge's orientation, centers the pill with the fixed inset, persists the edge, updates its last applied bounds, and resumes monitor following.

A new drag start replaces stale drag state. Hiding, destroying, or losing the widget renderer clears drag ownership and stops or resumes the appropriate placement lifecycle.

## Error handling

- If cursor or display lookup fails, retain the last valid visible bounds and retry during the next monitor check.
- If a native resize or move fails, retain the last successful bounds and clear terminal drag state rather than leaving the widget permanently owned by a failed gesture.
- Invalid or unreadable placement data falls back to the centered bottom edge.
- Repeated terminal drag events are harmless no-ops.
- Repeated monitor checks on the same display are no-ops.
- Programmatic resize and move operations are guarded against recursive native moved events.

## Testing strategy

### Main-window tests

- Assert that the main `BrowserWindow` uses `frame: false`.
- Render loading, unavailable, onboarding, and normal states and assert exactly one title bar with minimize and close-to-tray controls.
- Preserve draggable-region and no-drag control assertions.
- Add an Electron-level launch assertion that the real main window is frameless.

### Placement geometry and migration tests

- Resolve every edge to the center of the corresponding work-area side with a 16 DIP inset.
- Cover negative desktop coordinates, differently sized work areas, and work areas smaller than the normal widget footprint.
- Verify version-two edge/offset records retain only the edge.
- Verify legacy points select their nearest edge and then center.
- Verify invalid records use the centered bottom default.

### Monitor-follow tests

Using fake displays and controlled timers:

- move the cursor from monitor A to monitor B while idle, listening, processing, and displaying results;
- assert that the pill preserves its edge and centers on B;
- assert that automatic following pauses during a drag;
- assert that it resumes after snapping;
- assert that same-display checks do not repeat native operations; and
- assert that hiding and disposal stop monitor checks.

### Drag tests

- Normal pointer-up ends and snaps a drag.
- Pointer cancellation, lost pointer capture, blur, visibility loss, and unmount each end active drag ownership exactly once.
- A final queued movement is processed before snapping.
- High-frequency pointer moves are coalesced to one native move per animation frame.
- Native movement uses Electron cursor coordinates rather than renderer pixel deltas.
- Capsule buttons never begin a drag.
- The idle pill stays expanded while dragging.
- Hiding or destroying the widget cannot leave drag ownership or monitor following stuck.
- Presentation resizing preserves the selected edge and center anchor.

### Integration and manual verification

IPC tests will retain trusted-renderer and payload validation coverage for any revised drag or presentation contracts.

Manual Windows verification will cover:

1. dragging to all four edges;
2. repeated cursor movement among physical monitors;
3. idle, listening, processing, and result states;
4. monitors with different Windows scaling settings;
5. quick, slow, and cross-monitor drags;
6. recovery after leaving the pill/window during a drag; and
7. exactly one set of main-window controls on every app screen.

## Acceptance criteria

- The main application never shows both native and custom window controls.
- Loading, unavailable, onboarding, and normal screens remain movable, minimizable, and close-to-tray capable.
- A drag always resolves to the centered top, bottom, left, or right edge with a 16 DIP inset.
- Moving the cursor to another monitor moves the visible pill to the same edge on that monitor without requiring a new dictation session.
- The pill follows the cursor's monitor in every widget state except during an active drag.
- Lost pointer capture or renderer lifecycle changes cannot leave the pill stuck in drag mode.
- The first press on the visible idle pill does not pass through because of asynchronous interactivity arming.
- Cross-DPI dragging uses one Electron DIP coordinate space.
- High-rate pointer movement does not create an unbounded native-window operation stream.
- Existing dictation controls and close-to-tray behavior continue to work.
