# Window Controls and Multi-Monitor Pill Drag Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove duplicate main-window controls and make the floating dictation pill reliably draggable, edge-centered, DPI-safe, and able to follow the cursor across monitors.

**Architecture:** The main renderer gets one root-level reusable title bar and the main Electron window becomes frameless. `WindowManager` becomes the sole native widget-bounds coordinator: it stores an edge-only placement, owns presentation sizing, polls the cursor display every 100 milliseconds, pauses following during a drag, and computes drag motion from Electron DIP cursor coordinates. The widget renderer only classifies gestures, reports presentation intent, coalesces move notifications, and guarantees terminal cleanup.

**Tech Stack:** Electron 43, React 19, TypeScript 6, Zod 4, Vitest 4, Testing Library, and Playwright Electron.

## Global Constraints

- The main `BrowserWindow` must use `frame: false`.
- Exactly one TalkType title bar must appear in loading, unavailable, onboarding, and normal application states.
- Minimize remains minimize-to-taskbar; close remains hide-to-tray unless the process is quitting.
- Persist only `edge: 'top' | 'bottom' | 'left' | 'right'`; do not persist a monitor or along-edge offset.
- Migrate version-two edge/offset records to version three by retaining only the edge.
- Center the widget along its chosen edge with a fixed 16 DIP inset from the target work area.
- Check the cursor monitor every 100 milliseconds while the widget is visible and move within 200 milliseconds of a display change.
- Pause monitor following only while a drag is active.
- Use Electron cursor coordinates for native movement; renderer coordinates may only classify click versus drag.
- Coalesce renderer move notifications to at most one per animation frame.
- Terminal cleanup must be idempotent for pointer-up, pointer-cancel, lost capture, blur, hidden document, unmount, widget hide/destruction, and renderer loss.
- Keep the visible widget native window interactive; remove asynchronous click-through hover arming.
- Stop and cancel buttons must never start a drag.
- Add no runtime dependency and no maximize/restore control.

## File and Responsibility Map

- `src/renderer/src/components/AppTitlebar.tsx`: reusable branded main-window title bar and controls.
- `src/renderer/src/components/AppShell.tsx`: management navigation/content only; no title bar.
- `src/renderer/src/App.tsx`: selects application content and wraps every state in the shared main-window frame.
- `src/renderer/src/styles/global.css`: root frame/titlebar/body layout and drag/no-drag regions.
- `src/main/windows/widgetPlacementMath.ts`: pure edge choice, presentation sizes, and centered work-area bounds.
- `src/main/storage/widgetPlacementRepository.ts`: version-three edge-only storage plus version-one/two migration.
- `src/main/windows/windowManager.ts`: sole native widget bounds, monitor-follow, presentation, and drag coordinator.
- `src/main/app/nativeDictationLifecycle.ts`: no longer locks a dictation session to one display.
- `src/shared/contracts.ts`: presentation values and phase-only drag payload.
- `src/shared/channels.ts`: widget presentation IPC channel replacing widget interactivity.
- `src/preload/index.ts`: fixed widget bridge for presentation and drag reports.
- `src/main/ipc/registerIpc.ts`: trusted-widget validation and forwarding.
- `src/renderer/src/widget/useWidgetDragGesture.ts`: isolated renderer gesture state machine.
- `src/renderer/src/widget/WidgetApp.tsx`: widget rendering, presentation reporting, and high-level actions.
- `src/renderer/src/widget/widget.css`: presentation-sized layout; no drag-time collapse.

---

### Task 1: Share One Frameless Main-Window Title Bar

**Files:**
- Create: `src/renderer/src/components/AppTitlebar.tsx`
- Create: `tests/unit/renderer/appTitlebar.test.tsx`
- Modify: `src/renderer/src/components/AppShell.tsx:1-77`
- Modify: `src/renderer/src/App.tsx:192-316`
- Modify: `src/renderer/src/styles/global.css:599-725`
- Modify: `src/main/windows/windowManager.ts:45-65,267-277`
- Modify: `tests/unit/renderer/app.test.tsx`
- Modify: `tests/unit/renderer/appShell.test.tsx`
- Modify: `tests/unit/main/windowManager.test.ts:144-169`

**Interfaces:**
- Produces:

```ts
export interface AppTitlebarProps {
  readonly onMinimize: () => Promise<void> | void
  readonly onClose: () => Promise<void> | void
}

export function AppTitlebar(props: AppTitlebarProps): ReactNode
```

- [ ] **Step 1: Write failing title-bar component tests**

Create `tests/unit/renderer/appTitlebar.test.tsx` with this test:

```tsx
it('renders TalkType branding and invokes tray-safe controls', async () => {
  const user = userEvent.setup()
  const onMinimize = vi.fn()
  const onClose = vi.fn()

  render(<AppTitlebar onMinimize={onMinimize} onClose={onClose} />)

  expect(screen.getByLabelText('TalkType application')).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Minimize TalkType' }))
  await user.click(screen.getByRole('button', { name: 'Close TalkType to tray' }))

  expect(onMinimize).toHaveBeenCalledOnce()
  expect(onClose).toHaveBeenCalledOnce()
})
```

Add an `App` state matrix test that renders loading, unavailable, onboarding, and ready states and asserts exactly one `.app-titlebar` plus both controls in every state.

- [ ] **Step 2: Make the main-window constructor test fail for missing frameless configuration**

Change the expected main-window options in `tests/unit/main/windowManager.test.ts` to include:

```ts
frame: false,
```

Run:

```text
npm test -- tests/unit/renderer/appTitlebar.test.tsx tests/unit/renderer/app.test.tsx tests/unit/renderer/appShell.test.tsx tests/unit/main/windowManager.test.ts
```

Expected: FAIL because `AppTitlebar` does not exist, early branches lack custom controls, and `frame` is omitted.

- [ ] **Step 3: Extract the component and root frame**

Create `AppTitlebar.tsx` from the current titlebar markup:

```tsx
import React, { type ReactNode } from 'react'
import { Minus, X } from 'lucide-react'

import { Button } from './Button'

export interface AppTitlebarProps {
  readonly onMinimize: () => Promise<void> | void
  readonly onClose: () => Promise<void> | void
}

export function AppTitlebar({ onMinimize, onClose }: AppTitlebarProps): ReactNode {
  return (
    <header className="app-titlebar">
      <div className="app-titlebar__brand" aria-label="TalkType application">
        <span className="app-titlebar__mark" aria-hidden="true">T</span>
        <span>TalkType</span>
      </div>
      <div className="app-titlebar__controls">
        <Button iconOnly variant="ghost" aria-label="Minimize TalkType" onClick={() => void onMinimize()}>
          <Minus size={18} />
        </Button>
        <Button iconOnly variant="ghost" aria-label="Close TalkType to tray" onClick={() => void onClose()}>
          <X size={18} />
        </Button>
      </div>
    </header>
  )
}
```

Remove title-bar markup and `onMinimize`/`onClose` props from `AppShell`. In `App`, calculate branch content first, then return one frame:

```tsx
return (
  <div className="app-frame">
    <AppTitlebar
      onMinimize={app.actions.minimizeApp}
      onClose={app.actions.hideApp}
    />
    <div className="app-frame__body">{content}</div>
  </div>
)
```

Use the same wrapper for loading, unavailable, onboarding, and normal views. Keep `ToastRegion` inside the relevant branch content.

- [ ] **Step 4: Adjust layout and Electron options**

Make `.app-frame` a two-row full-window grid, keep `.app-titlebar` as the first row, and make `.app-frame__body` the overflow-safe second row:

```css
.app-frame {
  display: grid;
  width: 100%;
  min-width: 0;
  height: 100vh;
  min-height: 0;
  grid-template-rows: 52px minmax(0, 1fr);
  overflow: hidden;
}

.app-frame__body {
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}
```

Make `.app-shell` fill the body without defining a title-bar row. Preserve `-webkit-app-region: drag` on `.app-titlebar` and `no-drag` on controls. Replace `100vh` in loading/unavailable/onboarding roots with `height: 100%` so the title bar does not cause overflow.

Add this constructor option in `createMainWindow()`:

```ts
frame: false,
```

- [ ] **Step 5: Verify and commit**

Run:

```text
npm test -- tests/unit/renderer/appTitlebar.test.tsx tests/unit/renderer/app.test.tsx tests/unit/renderer/appShell.test.tsx tests/unit/main/windowManager.test.ts
npm run typecheck
npm run lint
```

Expected: all pass.

Commit:

```text
git add src/renderer/src/components/AppTitlebar.tsx src/renderer/src/components/AppShell.tsx src/renderer/src/App.tsx src/renderer/src/styles/global.css src/main/windows/windowManager.ts tests/unit/renderer/appTitlebar.test.tsx tests/unit/renderer/app.test.tsx tests/unit/renderer/appShell.test.tsx tests/unit/main/windowManager.test.ts
git commit -m "feat: share frameless main-window titlebar"
```

---

### Task 2: Introduce Edge-Only Presentation Geometry

**Files:**
- Modify: `src/shared/contracts.ts:134-153`
- Modify: `src/main/windows/widgetPlacementMath.ts:1-150`
- Modify: `tests/unit/main/widgetPlacementMath.test.ts:1-167`

**Interfaces:**
- Produces:

```ts
export const widgetPresentationSchema = z.enum([
  'idle-resting',
  'idle-hovered',
  'active',
])
export type WidgetPresentation = z.infer<typeof widgetPresentationSchema>

export interface WidgetPlacement {
  readonly edge: WidgetEdge
}

export interface WidgetBounds extends WidgetPoint, WidgetSize {}

export function widgetSizeForPresentation(
  edge: WidgetEdge,
  presentation: WidgetPresentation,
): WidgetSize

export function placementToBounds(
  placement: WidgetPlacement,
  workArea: WorkAreaRect,
  presentation: WidgetPresentation,
  inset: number,
): WidgetBounds
```

- [ ] **Step 1: Replace offset tests with failing centered-geometry tests**

Cover this exact native footprint matrix:

```ts
const EXPECTED_SIZES = {
  'idle-resting': {
    horizontal: { width: 124, height: 54 },
    vertical: { width: 54, height: 124 },
  },
  'idle-hovered': {
    horizontal: { width: 248, height: 76 },
    vertical: { width: 88, height: 124 },
  },
  active: {
    horizontal: { width: 248, height: 88 },
    vertical: { width: 88, height: 248 },
  },
} as const
```

Add tests named:

```text
returns the approved native footprint for every edge and presentation
centers every presentation 16 DIPs inside all four work-area edges
centers correctly in negative-coordinate work areas
clamps when the work area is smaller than the presentation
chooses the nearest edge with bottom top left right tie priority
returns only an edge and never an offset
```

Run:

```text
npm test -- tests/unit/main/widgetPlacementMath.test.ts
```

Expected: FAIL for missing presentation and edge-only APIs.

- [ ] **Step 2: Implement presentation sizes and centered bounds**

Replace `EdgePlacement` with:

```ts
export interface WidgetPlacement {
  readonly edge: WidgetEdge
}

export const DEFAULT_WIDGET_PLACEMENT: WidgetPlacement = Object.freeze({
  edge: 'bottom',
})
```

Implement orientation and sizing:

```ts
function isVerticalEdge(edge: WidgetEdge): boolean {
  return edge === 'left' || edge === 'right'
}

export function widgetSizeForPresentation(
  edge: WidgetEdge,
  presentation: WidgetPresentation,
): WidgetSize {
  const orientation = isVerticalEdge(edge) ? 'vertical' : 'horizontal'
  return EXPECTED_WIDGET_SIZES[presentation][orientation]
}
```

Implement centered bounds with clamping:

```ts
export function placementToBounds(
  placement: WidgetPlacement,
  workArea: WorkAreaRect,
  presentation: WidgetPresentation,
  inset: number,
): WidgetBounds {
  const size = widgetSizeForPresentation(placement.edge, presentation)
  const centeredX = workArea.x + Math.round((workArea.width - size.width) / 2)
  const centeredY = workArea.y + Math.round((workArea.height - size.height) / 2)

  const point = (() => {
    switch (placement.edge) {
      case 'top': return { x: centeredX, y: workArea.y + inset }
      case 'bottom': return {
        x: centeredX,
        y: workArea.y + workArea.height - size.height - inset,
      }
      case 'left': return { x: workArea.x + inset, y: centeredY }
      case 'right': return {
        x: workArea.x + workArea.width - size.width - inset,
        y: centeredY,
      }
    }
  })()

  return {
    x: Math.round(clamp(point.x, workArea.x, workArea.x + workArea.width - size.width)),
    y: Math.round(clamp(point.y, workArea.y, workArea.y + workArea.height - size.height)),
    ...size,
  }
}
```

Make `snapToEdge()` return `{ edge }` only and retain tie priority `bottom`, `top`, `left`, `right`.

- [ ] **Step 3: Verify and commit**

Run:

```text
npm test -- tests/unit/main/widgetPlacementMath.test.ts
npm run typecheck
```

Expected: all pass.

Commit:

```text
git add src/shared/contracts.ts src/main/windows/widgetPlacementMath.ts tests/unit/main/widgetPlacementMath.test.ts
git commit -m "refactor: center widget placement by edge"
```

---

### Task 3: Migrate Placement Storage and Consumers to Version Three

**Files:**
- Modify: `src/main/storage/widgetPlacementRepository.ts:1-108`
- Modify: `src/main/windows/windowManager.ts:1-87,207-211,494-526,675-750`
- Modify: `tests/unit/main/widgetPlacementRepository.test.ts`
- Modify: `tests/unit/main/windowManager.test.ts:330-550`

**Interfaces:**
- Consumes: `WidgetPlacement`, `placementToBounds()`, and `snapToEdge()` from Task 2.
- Produces:

```ts
export type StoredWidgetPlacement =
  | { readonly kind: 'edge'; readonly edge: WidgetEdge }
  | { readonly kind: 'point'; readonly x: number; readonly y: number }
```

`WindowManagerDependencies.onWidgetMoved` becomes:

```ts
readonly onWidgetMoved: (placement: WidgetPlacement) => void
```

- [ ] **Step 1: Write failing repository and consumer migration tests**

Add repository tests named:

```text
writes a version 3 edge-only record
migrates a valid version 2 edge and discards its offset
rewrites a version 2 record as version 3 during get
returns a version 1 point for display-aware migration
returns no placement for malformed or unknown records
```

Assert the saved JSON is exactly:

```json
{
  "version": 3,
  "placement": { "edge": "right" }
}
```

Update `WindowManager` tests so current edge records contain no offset, version-two reads are already normalized by the repository boundary, legacy points choose their nearest edge and then center, and snap callbacks receive only `{ edge }`. Add a test named `centers an edge-only stored placement instead of restoring a legacy offset`.

Run:

```text
npm test -- tests/unit/main/widgetPlacementRepository.test.ts tests/unit/main/windowManager.test.ts
```

Expected: FAIL because repository and `WindowManager` consumers still require offsets.

- [ ] **Step 2: Implement record parsing and rewrite**

Use these exact record variants:

```ts
type WidgetPlacementRecord =
  | { readonly version: 3; readonly placement: WidgetPlacement | null }
  | {
      readonly version: 2
      readonly placement: { readonly edge: WidgetEdge; readonly offset: number } | null
    }
  | {
      readonly version: 1
      readonly placement: { readonly x: number; readonly y: number } | null
    }
```

In `get()`, return version three directly, convert version two to `{ kind: 'edge', edge }`, and perform a contained best-effort rewrite:

```ts
if (record.version === 2) {
  const migrated = { edge: record.placement.edge }
  try {
    await this.store.write({ version: 3, placement: migrated })
  } catch {
    // Migration persistence is best effort; the valid edge remains usable.
  }
  return { kind: 'edge', ...migrated }
}
```

Keep version-one points for display-aware conversion by `WindowManager`. Make `save()` write only version three `{ edge }`.

- [ ] **Step 3: Remove the transitional offset adapter from WindowManager**

Delete `VersionTwoWidgetPlacement`, `DEFAULT_VERSION_TWO_WIDGET_PLACEMENT`, `clampVersionTwoOffset`, `toVersionTwoPlacement`, and `versionTwoPlacementToPosition` usage. Import `placementToBounds` and make remembered placement edge-only:

```ts
private rememberedWidgetPlacement(): WidgetPlacement {
  let stored: StoredWidgetPlacement | null
  try {
    stored = this.dependencies.getWidgetPlacement()
  } catch {
    return DEFAULT_WIDGET_PLACEMENT
  }
  if (stored === null) return DEFAULT_WIDGET_PLACEMENT
  if (stored.kind === 'edge') return { edge: stored.edge }
  if (!Number.isFinite(stored.x) || !Number.isFinite(stored.y)) {
    return DEFAULT_WIDGET_PLACEMENT
  }

  const workArea = this.dependencies.display.getDisplayNearestPoint(stored).workArea
  const placement = snapToEdge(stored, workArea)
  this.dependencies.onWidgetMoved(placement)
  return placement
}
```

In `showWidget()` and `snapWidgetToEdge()`, resolve active centered bounds with:

```ts
const bounds = placementToBounds(
  placement,
  workArea,
  'active',
  WIDGET_BOTTOM_GAP,
)
```

Use `bounds.width`/`bounds.height` for size, `bounds.x`/`bounds.y` for position, and persist/callback only `{ edge }`.

- [ ] **Step 4: Verify and commit**

Run:

```text
npm test -- tests/unit/main/widgetPlacementRepository.test.ts tests/unit/main/windowManager.test.ts
npm run typecheck
npm run lint
```

Expected: all pass.

Commit:

```text
git add src/main/storage/widgetPlacementRepository.ts src/main/windows/windowManager.ts tests/unit/main/widgetPlacementRepository.test.ts tests/unit/main/windowManager.test.ts
git commit -m "feat: migrate widget placement to version 3"
```

---

### Task 4: Centralize Native Widget Bounds in WindowManager

**Files:**
- Modify: `src/main/windows/windowManager.ts`
- Modify: the production Electron window adapter in `src/main/index.ts`
- Modify: `tests/unit/main/windowManager.test.ts`
- Modify: fake window interfaces in `tests/integration/nativeRendererRecovery.test.ts`

**Interfaces:**
- Consumes: `WidgetPlacement`, `WidgetPresentation`, `placementToBounds()`.
- Produces:

```ts
setWidgetPresentation(presentation: WidgetPresentation): void

private applyWidgetBounds(
  widget: BrowserWindowLike,
  desired: Rectangle,
): boolean
```

Add to `BrowserWindowLike`:

```ts
getBounds(): Rectangle
setBounds(bounds: Rectangle, animate?: boolean): void
```

- [ ] **Step 1: Upgrade the fake window and write failing coordinator tests**

Make `FakeWindow` hold mutable bounds:

```ts
bounds = { x: 0, y: 0, width: 124, height: 54 }

getBounds(): Rectangle {
  return { ...this.bounds }
}

setBounds(bounds: Rectangle): void {
  this.bounds = { ...bounds }
  this.setBoundsCalls.push({ ...bounds })
}

setPosition(x: number, y: number): void {
  this.bounds = { ...this.bounds, x, y }
  this.setPositionCalls.push([x, y])
}
```

Add tests named:

```text
constructs the widget at the bottom idle-resting footprint
applies presentation changes through one bounds path
preserves the selected edge and center while presentation changes
skips native work when desired bounds already match
loads remembered placement once
migrates a legacy point to a centered edge
falls back to centered bottom after storage or display failure
suppresses moved events caused by coordinator bounds
snaps a genuinely external move without recursion
```

Run:

```text
npm test -- tests/unit/main/windowManager.test.ts
```

Expected: FAIL because bounds and coordinator state do not exist.

- [ ] **Step 2: Replace competing state with coordinator state**

Replace `widgetLastReveal`, `widgetSessionAnchor`, `widgetDragOrigin`, and `widgetSize` with:

```ts
private widgetPlacement: WidgetPlacement = DEFAULT_WIDGET_PLACEMENT
private widgetPlacementLoaded = false
private widgetWorkArea: Rectangle | null = null
private widgetPresentation: WidgetPresentation = 'idle-resting'
private widgetLastAppliedBounds: Rectangle | null = null
private widgetProgrammaticTarget: Rectangle | null = null
private widgetVisible = false
private widgetDrag: {
  readonly windowOrigin: Point
  readonly cursorOrigin: Point
} | null = null
```

Load placement once. Convert legacy points using the referenced display, retain only the nearest edge, and persist the migrated edge.

- [ ] **Step 3: Implement one bounds application path**

Implement:

```ts
private applyWidgetBounds(widget: BrowserWindowLike, desired: Rectangle): boolean {
  if (sameRectangle(this.widgetLastAppliedBounds, desired)) return false

  this.widgetProgrammaticTarget = desired
  try {
    widget.setBounds(desired, false)
    this.widgetLastAppliedBounds = desired
    return true
  } catch {
    return false
  } finally {
    this.widgetProgrammaticTarget = null
  }
}
```

`showWidget()` must resolve the current placement/work area/presentation, call `applyWidgetBounds()`, set `widgetVisible = true`, and call `showInactive()` only when transitioning from hidden to visible.

Remove initial `setIgnoreMouseEvents(true, { forward: true })`. Construct the widget using the bottom-edge `idle-resting` size from Task 2.

Guard `moved` so programmatic target/last-applied bounds do not recursively snap. Treat only a truly external move as a snap candidate.

- [ ] **Step 4: Verify and commit**

Run:

```text
npm test -- tests/unit/main/windowManager.test.ts tests/integration/nativeRendererRecovery.test.ts
npm run typecheck
```

Expected: all pass.

Commit:

```text
git add src/main/windows/windowManager.ts src/main/index.ts tests/unit/main/windowManager.test.ts tests/integration/nativeRendererRecovery.test.ts
git commit -m "refactor: centralize native widget placement"
```

---

### Task 5: Follow the Cursor Monitor Every 100 Milliseconds

**Files:**
- Modify: `src/main/windows/windowManager.ts`
- Modify: `tests/unit/main/windowManager.test.ts`

**Interfaces:**
- Produces monitor timer lifecycle contained within `WindowManager`.

- [ ] **Step 1: Write failing fake-timer monitor tests**

Use `vi.useFakeTimers()` and a mutable two-display adapter. Add tests named:

```text
follows the cursor monitor in every widget presentation
preserves the edge and centers on the target monitor
does no native work while the cursor remains on one monitor
pauses monitor following while drag ownership is active
resumes following after drag end
retries after cursor or display lookup failure
stops checks when hidden
stops checks when widget closes or renderer is lost
stops checks when WindowManager is disposed
```

Advance time by 100 milliseconds for one check and by 200 milliseconds for the acceptance bound.

Run:

```text
npm test -- tests/unit/main/windowManager.test.ts
```

Expected: FAIL because cursor changes after reveal do not move the widget.

- [ ] **Step 2: Implement timer lifecycle**

Add:

```ts
const WIDGET_MONITOR_INTERVAL_MS = 100

private widgetMonitorTimer: ReturnType<typeof setInterval> | null = null
```

Start one timer after a hidden-to-visible transition. Its callback must:

```ts
private followCursorMonitor(): void {
  const widget = this.widgetWindow
  if (
    !this.widgetVisible ||
    this.widgetDrag !== null ||
    widget === null ||
    widget.isDestroyed()
  ) return

  try {
    const cursor = this.dependencies.display.getCursorScreenPoint()
    const workArea = this.dependencies.display.getDisplayNearestPoint(cursor).workArea
    if (sameRectangle(this.widgetWorkArea, workArea)) return

    this.widgetWorkArea = workArea
    const desired = placementToBounds(
      this.widgetPlacement,
      workArea,
      this.widgetPresentation,
      WIDGET_EDGE_INSET,
    )
    this.applyWidgetBounds(widget, desired)
  } catch {
    // Retain last valid bounds and retry on the next tick.
  }
}
```

Stop and clear the timer in `hideWidget`, widget close, widget renderer loss, and `dispose`. Do not stop it during a drag; the callback becomes a cheap no-op and resumes automatically after terminal cleanup.

- [ ] **Step 3: Verify and commit**

Run:

```text
npm test -- tests/unit/main/windowManager.test.ts
npm run typecheck
```

Expected: all pass.

Commit:

```text
git add src/main/windows/windowManager.ts tests/unit/main/windowManager.test.ts
git commit -m "feat: follow cursor monitor for widget placement"
```

---

### Task 6: Make Main-Process Dragging DIP-Safe and Recoverable

**Files:**
- Modify: `src/main/windows/windowManager.ts`
- Modify: `tests/unit/main/windowManager.test.ts`

**Interfaces:**
- Consumes phase-based drag reports. During this task, existing delta fields may remain accepted but must be ignored.

- [ ] **Step 1: Rewrite drag tests around Electron cursor coordinates**

Use independently mutable native bounds and cursor points. Add tests named:

```text
records native window and Electron cursor origins on start
moves from Electron cursor deltas and ignores renderer deltas
replaces stale ownership on repeated start
ignores move and end without ownership
snaps on the display containing the native window center
persists only the selected edge
centers the current presentation after orientation changes
clears ownership after cursor or native movement failure
clears ownership when hidden closed or renderer is lost
resumes monitor following after every terminal path
```

Run:

```text
npm test -- tests/unit/main/windowManager.test.ts
```

Expected: FAIL because native movement still uses renderer deltas.

- [ ] **Step 2: Implement cursor-origin dragging**

At start:

```ts
const bounds = widget.getBounds()
const cursor = this.dependencies.display.getCursorScreenPoint()
this.widgetDrag = {
  windowOrigin: { x: bounds.x, y: bounds.y },
  cursorOrigin: cursor,
}
```

At move:

```ts
const drag = this.widgetDrag
if (drag === null) return

try {
  const cursor = this.dependencies.display.getCursorScreenPoint()
  widget.setPosition(
    drag.windowOrigin.x + cursor.x - drag.cursorOrigin.x,
    drag.windowOrigin.y + cursor.y - drag.cursorOrigin.y,
    false,
  )
  const current = widget.getBounds()
  this.widgetLastAppliedBounds = current
} catch {
  this.widgetDrag = null
}
```

At end, read actual bounds, clear ownership before any operation that can throw, resolve the display from the native center, choose nearest edge, recenter the current presentation, persist `{ edge }`, and leave the last successful bounds intact on failure.

Clear drag ownership in `hideWidget`, closed lifecycle, renderer-loss lifecycle, and `dispose`.

- [ ] **Step 3: Verify and commit**

Run:

```text
npm test -- tests/unit/main/windowManager.test.ts
npm run typecheck
```

Expected: all pass.

Commit:

```text
git add src/main/windows/windowManager.ts tests/unit/main/windowManager.test.ts
git commit -m "fix: make widget dragging DPI-safe and recoverable"
```

---

### Task 7: Remove Dictation-Session Display Locking

**Files:**
- Modify: `src/main/app/nativeDictationLifecycle.ts`
- Modify: `src/main/index.ts`
- Modify: `tests/unit/main/nativeDictationLifecycle.test.ts`
- Modify: `tests/integration/nativeRendererRecovery.test.ts`

**Interfaces:**
- Removes `widgetDisplay.lock()` and `widgetDisplay.unlock()`.

- [ ] **Step 1: Replace lock expectations with cursor-follow compatibility tests**

Delete the existing session-lock test block. Add tests named:

```text
does not lock a display when dictation becomes active
does not unlock a display when dictation returns to idle
preserves widget publication and visibility behavior without display locking
renderer recovery leaves WindowManager free to follow the cursor
```

Run:

```text
npm test -- tests/unit/main/nativeDictationLifecycle.test.ts tests/integration/nativeRendererRecovery.test.ts
```

Expected: FAIL until the lock dependency and wiring are removed.

- [ ] **Step 2: Remove dependency and wiring**

Remove this dependency shape:

```ts
readonly widgetDisplay: {
  lock(): void
  unlock(): void
}
```

Delete calls that lock on non-idle publication and unlock on idle. Remove this wiring from `src/main/index.ts`:

```ts
widgetDisplay: {
  lock: () => windows.lockWidgetDisplay(),
  unlock: () => windows.unlockWidgetDisplay(),
},
```

Delete obsolete `WindowManager.lockWidgetDisplay()` and `unlockWidgetDisplay()` methods if any transitional implementation remains.

- [ ] **Step 3: Verify and commit**

Run:

```text
npm test -- tests/unit/main/nativeDictationLifecycle.test.ts tests/integration/nativeRendererRecovery.test.ts
npm run typecheck
```

Expected: all pass.

Commit:

```text
git add src/main/app/nativeDictationLifecycle.ts src/main/index.ts tests/unit/main/nativeDictationLifecycle.test.ts tests/integration/nativeRendererRecovery.test.ts
git commit -m "refactor: remove widget session display locking"
```

---

### Task 8: Replace Click-Through IPC with Presentation IPC

**Files:**
- Modify: `src/shared/channels.ts`
- Modify: `src/shared/contracts.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/main/ipc/registerIpc.ts`
- Modify: `src/main/index.ts`
- Modify: `src/renderer/src/widget/WidgetApp.tsx`
- Modify: `src/renderer/src/widget/widget.css`
- Modify: `tests/integration/ipc.test.ts`
- Modify: `tests/unit/renderer/widgetApp.test.tsx`

**Interfaces:**
- Produces:

```ts
setPresentation(presentation: WidgetPresentation): Promise<CommandResult>
```

- Removes `setMouseInteractive` and `WIDGET_INTERACTIVITY`.

- [ ] **Step 1: Write failing bridge and IPC tests**

Change the preload surface expectation to:

```ts
[
  'onWidgetState',
  'reportDrag',
  'requestCancel',
  'requestStop',
  'requestToggle',
  'setPresentation',
]
```

Replace widget interactivity tests with:

```text
lets only the trusted widget renderer set presentation
accepts idle-resting idle-hovered and active
rejects unknown non-string and object presentation payloads
reports unavailable when no widget coordinator is registered
```

Add renderer tests that idle rest reports `idle-resting`, hover reports `idle-hovered`, active snapshots report `active`, and ending idle drag returns to `idle-resting`.

Run:

```text
npm test -- tests/integration/ipc.test.ts tests/unit/renderer/widgetApp.test.tsx
```

Expected: FAIL because the bridge still exposes `setMouseInteractive`.

- [ ] **Step 2: Replace channel, contract, preload, and IPC service**

Define the fixed channel in `channels.ts` and use the Task 2 schema:

```ts
WIDGET_PRESENTATION: 'talktype:widget:presentation',
```

Change the bridge method to:

```ts
setPresentation: async (presentation: WidgetPresentation) =>
  ipcRenderer.invoke(IPC_CHANNELS.WIDGET_PRESENTATION, presentation),
```

Change the main service to:

```ts
export interface WidgetIpcService {
  setPresentation(presentation: WidgetPresentation): void
  reportDrag(payload: WidgetDragPayload): void
}
```

Register strict schema validation and trusted widget-renderer authorization, then wire `setPresentation` to `windows.setWidgetPresentation()`.

- [ ] **Step 3: Report renderer presentation and remove click-through behavior**

Add `onPresentationChange` to `WidgetAppProps`. Derive presentation in `WidgetApp`:

```ts
const presentation: WidgetPresentation = !isIdle
  ? 'active'
  : expanded || surface.dragging
    ? 'idle-hovered'
    : 'idle-resting'

useEffect(() => {
  onPresentationChange?.(presentation)
}, [onPresentationChange, presentation])
```

In `WidgetEntry`, forward the value using `bridge.setPresentation()`. Delete `interactive`, the `setMouseInteractive` effect, and `onSliverHover` IPC toggling.

Update CSS so each visible surface is centered in its presentation-sized root. Remove the old assumption that every state has a 248×88 or 88×248 canvas. Keep visual surface dimensions unchanged and ensure the root has no pointer-blocking area beyond the presentation-specific native shadow envelope.

- [ ] **Step 4: Verify and commit**

Run:

```text
npm test -- tests/integration/ipc.test.ts tests/unit/renderer/widgetApp.test.tsx
npm run typecheck
npm run lint
```

Expected: all pass.

Commit:

```text
git add src/shared/channels.ts src/shared/contracts.ts src/preload/index.ts src/main/ipc/registerIpc.ts src/main/index.ts src/renderer/src/widget/WidgetApp.tsx src/renderer/src/widget/widget.css tests/integration/ipc.test.ts tests/unit/renderer/widgetApp.test.tsx
git commit -m "feat: coordinate native widget presentation bounds"
```

---

### Task 9: Extract a Recoverable, Coalesced Renderer Drag Hook

**Files:**
- Create: `src/renderer/src/widget/useWidgetDragGesture.ts`
- Create: `tests/unit/renderer/widgetDragGesture.test.tsx`
- Modify: `src/renderer/src/widget/WidgetApp.tsx`
- Modify: `src/renderer/src/widget/widget.css`
- Modify: `src/shared/contracts.ts`
- Modify: `tests/unit/renderer/widgetApp.test.tsx`
- Modify: `tests/integration/ipc.test.ts`

**Interfaces:**
- Produces:

```ts
export interface WidgetDragGesture {
  readonly dragging: boolean
  readonly isDragActive: () => boolean
  readonly surfaceProps: {
    readonly onPointerDown: PointerEventHandler<HTMLElement>
    readonly onPointerMove: PointerEventHandler<HTMLElement>
    readonly onPointerUp: PointerEventHandler<HTMLElement>
    readonly onPointerCancel: PointerEventHandler<HTMLElement>
    readonly onLostPointerCapture: PointerEventHandler<HTMLElement>
    readonly onClick: MouseEventHandler<HTMLElement>
  }
}
```

- Final drag payload:

```ts
{ phase: 'start' } | { phase: 'move' } | { phase: 'end' }
```

- [ ] **Step 1: Build a hook harness and failing lifecycle tests**

Add tests named:

```text
keeps movement at or below four pixels as a click
emits one start after crossing the threshold
coalesces high-frequency moves into one move per animation frame
flushes a queued move before end
continues through window move and pointer-up when capture throws
ends exactly once on pointercancel
ends exactly once on lostpointercapture
ends exactly once on blur
ends exactly once when document becomes hidden
ends exactly once on unmount
removes temporary listeners through common cleanup
suppresses only the click following a completed drag
ignores secondary and non-primary pointers
```

Run:

```text
npm test -- tests/unit/renderer/widgetDragGesture.test.tsx tests/unit/renderer/widgetApp.test.tsx tests/integration/ipc.test.ts
```

Expected: FAIL because the current hook lacks fallback listeners, cleanup paths, and coalescing.

- [ ] **Step 2: Implement one gesture state machine**

Track:

```ts
interface ActiveGesture {
  readonly pointerId: number
  readonly startX: number
  readonly startY: number
  readonly captureTarget: HTMLElement
  dragging: boolean
  movePending: boolean
  frameId: number | null
}
```

Install temporary window `pointermove`, `pointerup`, and `pointercancel` listeners immediately after an accepted pointer down. Attempt capture but continue if it throws. Use `screenX`/`screenY` only to measure the four-pixel threshold.

After crossing the threshold, emit start once and schedule at most one RAF move:

```ts
const queueMove = (): void => {
  const active = activeRef.current
  if (active === null || active.movePending) return
  active.movePending = true
  active.frameId = window.requestAnimationFrame(() => {
    const current = activeRef.current
    if (current === null || !current.movePending) return
    current.movePending = false
    current.frameId = null
    onDrag?.({ phase: 'move' })
  })
}
```

Implement one idempotent `finish(pointerId?: number)` that clears tracking before releasing capture, cancels RAF, synchronously flushes a queued move, emits end exactly once when dragging began, removes all listeners, releases capture best-effort, and updates React state.

Call it from pointer-up, pointer-cancel, lost capture, window blur, hidden visibility state, and effect cleanup.

- [ ] **Step 3: Tighten the contract and preserve the idle drag footprint**

Replace the drag schema with:

```ts
export const widgetDragSchema = z.discriminatedUnion('phase', [
  z.object({ phase: z.literal('start') }).strict(),
  z.object({ phase: z.literal('move') }).strict(),
  z.object({ phase: z.literal('end') }).strict(),
])
```

Remove `deltaX`/`deltaY` from renderer, preload, IPC, main, and tests. Ensure the idle surface remains expanded while `dragging === true`; remove CSS that collapses it to 88×6 or 6×88 during drag. The prompt may hide while dragging, but the interactive size remains `idle-hovered` until terminal cleanup.

Keep button `onPointerDown` propagation guards.

- [ ] **Step 4: Verify and commit**

Run:

```text
npm test -- tests/unit/renderer/widgetDragGesture.test.tsx tests/unit/renderer/widgetApp.test.tsx tests/integration/ipc.test.ts
npm run typecheck
npm run lint
```

Expected: all pass.

Commit:

```text
git add src/renderer/src/widget/useWidgetDragGesture.ts src/renderer/src/widget/WidgetApp.tsx src/renderer/src/widget/widget.css src/shared/contracts.ts tests/unit/renderer/widgetDragGesture.test.tsx tests/unit/renderer/widgetApp.test.tsx tests/integration/ipc.test.ts
git commit -m "fix: harden and coalesce widget drag gestures"
```

---

### Task 10: Add Electron Regression Coverage and Run Full Verification

**Files:**
- Modify: `tests/unit/main/windowManager.test.ts`
- Modify: `tests/integration/nativeRendererRecovery.test.ts`
- Modify: `tests/integration/ipc.test.ts`
- Modify: `tests/e2e/app.spec.ts`
- Refresh: `artifacts/design/baseline/idle-light.png` only if the focused visual-preview test proves the approved idle presentation moved while remaining deterministic, bounded, and transparent.
- Modify fake window support only where required by those tests.

**Interfaces:**
- No new production interface; this task verifies Tasks 1-9 together.

- [ ] **Step 1: Add integration recovery tests**

Add:

```text
widget renderer loss releases drag ownership and replacement follows cursor
hiding during drag releases ownership and stops monitor checks
active presentation resizes without recreating the widget
native drag-end snap failure clears ownership and the next monitor tick recovers
```

For the last test, move the fake widget to unsnapped bounds before `reportWidgetDrag({ phase: 'end' })`, make that snap's `setBounds` call throw, assert ownership is cleared, then advance the monitor timer and assert centered bounds are applied successfully.

Run:

```text
npm test -- tests/unit/main/windowManager.test.ts tests/integration/nativeRendererRecovery.test.ts tests/integration/ipc.test.ts
```

Expected before final fixture updates: FAIL on missing combined lifecycle assertions.

- [ ] **Step 2: Add real Electron frameless and native-bounds tests**

Add an E2E test that inspects the real main `BrowserWindow`:

```ts
const geometry = await launched.app.evaluate(({ BrowserWindow }) => {
  const main = BrowserWindow.getAllWindows().find((candidate) =>
    candidate.webContents.getURL().endsWith('/index.html'),
  )
  if (main === undefined) return null
  return {
    bounds: main.getBounds(),
    contentBounds: main.getContentBounds(),
  }
})

expect(geometry).not.toBeNull()
expect(geometry?.contentBounds).toEqual(geometry?.bounds)
expect(await launched.page.locator('.app-titlebar').count()).toBe(1)
```

Verify exactly one title bar before and after onboarding. Preserve the existing close-to-tray E2E test.

Add a widget-bounds E2E test for the default bottom edge:

```text
idle-resting: 124 x 54
idle-hovered: 248 x 76
active: 248 x 88
```

Read bounds through `ElectronApplication.evaluate` and identify the widget by its widget renderer URL.

- [ ] **Step 3: Run focused integration and Electron tests**

Run:

```text
npm test -- tests/integration/nativeRendererRecovery.test.ts tests/integration/ipc.test.ts
npm run test:e2e -- tests/e2e/app.spec.ts -g "frameless|native widget"
```

Expected: all pass.

- [ ] **Step 4: Run complete automated verification**

Run in this order:

```text
npm run typecheck
npm run lint
npm test
npm run test:coverage
npm run test:e2e
```

Expected: every command exits successfully with no existing unit, integration, release, design-capture, or Electron regression.

If the full Electron suite fails only because `idle-light.png` still records the old idle canvas position, first reproduce that exact test without update mode. Then refresh only the approved idle-light baseline:

```powershell
$env:TALKTYPE_UPDATE_WIDGET_BASELINES = '1'; npx playwright test --workers=1 tests/e2e/visual-previews.spec.ts -g "idle light preview"; Remove-Item Env:TALKTYPE_UPDATE_WIDGET_BASELINES
npx playwright test --workers=1 tests/e2e/visual-previews.spec.ts -g "idle light preview"
npm run test:e2e
```

Inspect `git status --short` and confirm that no other design baseline changed. The refreshed image must still pass the test's deterministic, bounded, alpha-edge, and visible-pixel assertions.

- [ ] **Step 5: Commit verification coverage**

```text
git add tests/unit/main/windowManager.test.ts tests/integration/nativeRendererRecovery.test.ts tests/integration/ipc.test.ts tests/e2e/app.spec.ts artifacts/design/baseline/idle-light.png
git commit -m "test: cover frameless chrome and widget placement lifecycle"
```

---

## Workflow Execution Order

The user requested multi-agent Workflow execution. Run tasks in dependency order and prevent concurrent mutation of shared files.

1. Task 1 and Task 2 are logically independent, but execute them sequentially in the shared working tree to avoid concurrent Git index/commit operations.
2. Task 3 depends on Task 2.
3. Tasks 4, 5, and 6 must be sequential because all substantially modify `WindowManager` and its fake.
4. Task 7 follows the coordinator changes.
5. Task 8 freezes the presentation bridge before Task 9 extracts the renderer gesture hook.
6. Task 10 runs only after Tasks 1-9 pass their targeted checks.
7. After implementation, run an independent code-review agent focused on correctness, lifecycle cleanup, timer leaks, IPC authorization, coordinate-space consistency, and test gaps.
8. If review finds verified issues, dispatch one fix agent, rerun targeted checks, then repeat the independent review once.

## Manual Windows Acceptance Checklist

After automated verification, use two physical monitors when available, preferably with different Windows scaling values.

- [ ] Loading, startup failure, onboarding, Home, History, Settings, and Help show one TalkType title bar and no native caption controls.
- [ ] The title bar drags the main window; minimize uses the taskbar; close hides to tray; tray restore works.
- [ ] Dragging the pill to each edge centers it and keeps a 16 DIP inset from the usable work area.
- [ ] Restarting remembers only the edge, not a monitor or along-edge offset.
- [ ] Moving the cursor between monitors moves the pill within 200 milliseconds while idle, listening, processing, success, cancelled, and error states are visible.
- [ ] Automatic following pauses during drag and resumes after terminal cleanup.
- [ ] Quick, slow, cross-monitor, and mixed-DPI drags remain responsive.
- [ ] Leaving the widget, losing capture, Alt-Tabbing, hiding, or renderer recovery cannot leave drag ownership stuck.
- [ ] A quick first press on the idle pill never reaches the application underneath.
- [ ] The idle pill stays expanded during drag.
- [ ] Click-to-start, click-to-stop, stop, and cancel behavior remains correct; buttons never initiate dragging.
