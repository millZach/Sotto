import { describe, expect, it, vi } from 'vitest'

import { NativeDictationLifecycle } from '../../src/main/app/nativeDictationLifecycle'
import { NativeMessageDelivery } from '../../src/main/app/nativeMessageDelivery'
import {
  HotkeyManager,
  syncEscapeForWidgetSnapshot,
} from '../../src/main/hotkeys/hotkeyManager'
import {
  WindowManager,
  type BrowserWindowLike,
  type NavigationEventName,
} from '../../src/main/windows/windowManager'
import { WIDGET_STATE } from '../../src/shared/channels'
import type { WidgetSnapshot } from '../../src/shared/dictation'

type WindowEvent = 'close' | 'closed'

class LifecycleWindow implements BrowserWindowLike {
  readonly webContents = {
    mainFrame: { parent: null, url: 'file:///TalkType/index.html' },
    send: vi.fn(),
    getURL: vi.fn(() => 'file:///TalkType/index.html'),
    isDestroyed: vi.fn(() => false),
    setWindowOpenHandler: vi.fn(),
  }
  readonly hide = vi.fn()
  readonly show = vi.fn()
  readonly focus = vi.fn()
  readonly minimize = vi.fn()
  readonly isMinimized = vi.fn(() => false)
  readonly restore = vi.fn()
  readonly showInactive = vi.fn()
  readonly setPosition = vi.fn()
  readonly getPosition = vi.fn(() => [0, 0] as const)
  readonly setIgnoreMouseEvents = vi.fn()
  readonly destroy = vi.fn()
  readonly isDestroyed = vi.fn(() => false)
  readonly loadURL = vi.fn(async () => undefined)
  readonly loadFile = vi.fn(async () => undefined)
  private readonly rendererGoneListeners = new Set<() => void>()

  on(event: WindowEvent, listener: (event: { preventDefault(): void }) => void): void {
    void event
    void listener
  }
  removeListener(event: WindowEvent, listener: (event: { preventDefault(): void }) => void): void {
    void event
    void listener
  }
  onNavigation(
    event: NavigationEventName,
    listener: (event: { preventDefault(): void }, details: { readonly url: string }) => void,
  ): void {
    void event
    void listener
  }
  removeNavigationListener(
    event: NavigationEventName,
    listener: (event: { preventDefault(): void }, details: { readonly url: string }) => void,
  ): void {
    void event
    void listener
  }
  onRenderProcessGone(listener: () => void): void {
    this.rendererGoneListeners.add(listener)
  }
  removeRenderProcessGoneListener(listener: () => void): void {
    this.rendererGoneListeners.delete(listener)
  }
  emitRendererGone(): void {
    for (const listener of [...this.rendererGoneListeners]) listener()
  }
}

function activeSnapshot(
  status: 'requesting-permission' | 'listening' | 'processing',
): WidgetSnapshot {
  const metadata = {
    theme: 'dark' as const,
    reducedMotion: 'on' as const,
    shortcut: 'Control+Shift+Space',
    cancellable: true,
  }
  if (status === 'requesting-permission') {
    return { status, sessionId: 'lost-session', ...metadata }
  }
  if (status === 'listening') {
    return { status, sessionId: 'lost-session', startedAt: 100, level: 0.4, ...metadata }
  }
  return {
    status,
    sessionId: 'lost-session',
    startedAt: 100,
    stage: 'transcribing',
    progress: 0.6,
    ...metadata,
  }
}

describe('native recovery after the main renderer is lost', () => {
  it.each(['requesting-permission', 'listening', 'processing'] as const)(
    'resets an active %s session and permits the next dictation',
    async (status) => {
      const nativeWindows: LifecycleWindow[] = []
      let rendererLoss: (kind: 'main' | 'widget') => void = () => undefined
      const windows = new WindowManager({
        createWindow: () => {
          const window = new LifecycleWindow()
          nativeWindows.push(window)
          return window
        },
        getWidgetPlacement: () => null,
        onWidgetMoved: () => undefined,
        display: {
          getCursorScreenPoint: () => ({ x: 0, y: 0 }),
          getDisplayNearestPoint: () => ({
            workArea: { x: 0, y: 0, width: 1_920, height: 1_080 },
          }),
        },
        preloadPath: 'preload.js',
        mainHtmlPath: 'index.html',
        widgetHtmlPath: 'widget.html',
        developmentSources: undefined,
        isPackaged: true,
        log: vi.fn(),
        onRendererProcessGone: (kind) => rendererLoss(kind),
      })
      await windows.createWindows()

      const callbacks = new Map<string, () => void>()
      const shortcuts = {
        register: vi.fn((accelerator: string, callback: () => void) => {
          callbacks.set(accelerator, callback)
          return true
        }),
        unregister: vi.fn((accelerator: string) => callbacks.delete(accelerator)),
        isRegistered: vi.fn((accelerator: string) => callbacks.has(accelerator)),
      }
      const toggleDictation = vi.fn()
      const hotkeys = new HotkeyManager(shortcuts, toggleDictation, vi.fn())
      expect(hotkeys.replace('Control+Shift+Space')).toEqual({ ok: true })

      let trayState = { dictating: false, autoPaste: false }
      const trayUpdate = vi.fn((next: typeof trayState) => {
        trayState = next
      })
      const delivery = new NativeMessageDelivery(windows)
      const lifecycle = new NativeDictationLifecycle({
        delivery,
        getTrayState: () => trayState,
        updateTray: trayUpdate,
        syncEscape: (state) => syncEscapeForWidgetSnapshot(hotkeys, state),
        log: vi.fn(),
      })
      rendererLoss = (kind) => lifecycle.rendererProcessGone(kind)

      await lifecycle.publish(activeSnapshot(status))
      expect(callbacks.has('Escape')).toBe(true)
      expect(trayState).toEqual({ dictating: status === 'listening', autoPaste: false })
      expect(nativeWindows[1]!.showInactive).toHaveBeenCalled()

      nativeWindows[0]!.emitRendererGone()

      await vi.waitFor(() =>
        expect(nativeWindows[1]!.webContents.send).toHaveBeenLastCalledWith(
          WIDGET_STATE,
          {
            status: 'idle',
            theme: 'dark',
            reducedMotion: 'on',
            shortcut: 'Control+Shift+Space',
            cancellable: false,
          },
        ),
      )
      // The idle sliver stays visible after recovery instead of hiding.
      expect(nativeWindows[1]!.hide).not.toHaveBeenCalled()
      expect(trayState).toEqual({ dictating: false, autoPaste: false })
      expect(callbacks.has('Escape')).toBe(false)
      expect(callbacks.has('Control+Shift+Space')).toBe(true)

      await windows.showMain()
      expect(nativeWindows).toHaveLength(3)
      callbacks.get('Control+Shift+Space')?.()
      expect(toggleDictation).toHaveBeenCalledOnce()
      await lifecycle.publish({
        status: 'listening',
        sessionId: 'next-session',
        startedAt: 200,
        level: 0.2,
        theme: 'dark',
        reducedMotion: 'on',
        shortcut: 'Control+Shift+Space',
        cancellable: true,
      })
      expect(trayState).toEqual({ dictating: true, autoPaste: false })
      expect(callbacks.has('Escape')).toBe(true)
    },
  )
})
