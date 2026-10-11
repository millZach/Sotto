// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import {
  registerIpc
} from '../../src/main/ipc/registerIpc'
import { platformProfile } from '../../src/main/platformProfile'
import {
  WindowManager,
  type WindowConstructorOptions
} from '../../src/main/windows/windowManager'
import {
  WIDGET_DRAG,
  WIDGET_PRESENTATION,
  WIDGET_PUBLISH
} from '../../src/shared/channels'
import { DEFAULT_WIDGET_PALETTE } from '../../src/shared/themeBranding'
import { createIpcHarness, idleWidgetSnapshot, IpcLifecycleWindow } from '../fixtures/ipcHarness'

describe('IPC validation and lifecycle', () => {
  it('accepts only strict transcript-free widget snapshots', async () => {
      const harness = createIpcHarness()
      const publishWidgetState = vi.fn()
      harness.cleanup()
      registerIpc(harness.ipc, {
        settings: harness.settings,
        history: harness.history,
        startup: harness.startup,
        hotkeys: harness.hotkeys,
        app: harness.app,
        trustedSenders: () => [{
          role: 'main',
          webContents: harness.trustedContents,
          url: harness.trustedUrl,
        }],
        dictation: { request: vi.fn(), publishWidgetState },
      })

      await expect(harness.ipc.invoke(WIDGET_PUBLISH, idleWidgetSnapshot)).resolves.toEqual({ ok: true })
      expect(publishWidgetState).toHaveBeenCalledWith(idleWidgetSnapshot)
      await expect(harness.ipc.invoke(WIDGET_PUBLISH, { status: 'idle' })).rejects.toMatchObject({
        code: 'INVALID_IPC_PAYLOAD',
      })
      await expect(harness.ipc.invoke(WIDGET_PUBLISH, {
        status: 'success',
        sessionId: 'session',
        text: 'private transcript',
        output: 'copied',
      })).rejects.toMatchObject({ code: 'INVALID_IPC_PAYLOAD' })
      await expect(harness.ipc.invoke(WIDGET_PUBLISH, {
        status: 'error', sessionId: 'session', code: 'NO_SPEECH',
        message: 'arbitrary transcript-like detail',
        theme: 'system', palette: DEFAULT_WIDGET_PALETTE, reducedMotion: 'system', shortcut: 'Primary', cancellable: false,
      })).rejects.toMatchObject({ code: 'INVALID_IPC_PAYLOAD' })
      await expect(harness.ipc.invoke(WIDGET_PUBLISH, {
        status: 'error', sessionId: 'session', code: 'ARBITRARY_DETAIL',
        theme: 'system', palette: DEFAULT_WIDGET_PALETTE, reducedMotion: 'system', shortcut: 'Primary', cancellable: false,
      })).rejects.toMatchObject({ code: 'INVALID_IPC_PAYLOAD' })
      expect(publishWidgetState).toHaveBeenCalledTimes(1)
    })
})

describe('widget presentation and drag channels', () => {
  function widgetSender() {
    const widgetUrl = 'file:///C:/Sotto/out/renderer/widget.html'
    const widgetFrame = { parent: null, url: widgetUrl }
    const widgetContents = {
      getURL: (): string => widgetUrl,
      isDestroyed: (): boolean => false,
      mainFrame: widgetFrame,
    }
    return { widgetContents, widgetFrame, widgetUrl }
  }

  it('forwards only strict generation-bound presentation and drag reports', async () => {
    const harness = createIpcHarness()
    harness.cleanup()
    const { widgetContents, widgetFrame, widgetUrl } = widgetSender()
    const setPresentation = vi.fn()
    const reportDrag = vi.fn()
    registerIpc(harness.ipc, {
      settings: harness.settings,
      history: harness.history,
      startup: harness.startup,
      hotkeys: harness.hotkeys,
      app: harness.app,
      trustedSenders: () => [
        { role: 'widget' as const, webContents: widgetContents, url: widgetUrl },
      ],
      widget: { setPresentation, reportDrag },
    })
    const widgetEvent = { sender: widgetContents, senderFrame: widgetFrame }
    const presentation = { presentation: 'active', generation: 9 } as const
    const drag = { phase: 'move', generation: 9, gestureId: 4 } as const

    await expect(
      harness.ipc.invoke(WIDGET_PRESENTATION, presentation, widgetEvent),
    ).resolves.toEqual({ ok: true })
    await expect(
      harness.ipc.invoke(WIDGET_DRAG, drag, widgetEvent),
    ).resolves.toEqual({ ok: true })
    expect(setPresentation).toHaveBeenCalledWith(presentation)
    expect(reportDrag).toHaveBeenCalledWith(drag)

    for (const payload of [
      { presentation: 'active' },
      { presentation: 'active', generation: -1 },
      { presentation: 'active', generation: 1.5 },
      { presentation: 'active', generation: 9, extra: true },
    ]) {
      await expect(
        harness.ipc.invoke(WIDGET_PRESENTATION, payload, widgetEvent),
      ).rejects.toMatchObject({ code: 'INVALID_IPC_PAYLOAD' })
    }
    for (const payload of [
      { phase: 'move' },
      { phase: 'move', generation: 9 },
      { phase: 'move', generation: -1, gestureId: 4 },
      { phase: 'move', generation: 1.5, gestureId: 4 },
      { phase: 'move', generation: 9, gestureId: -1 },
      { phase: 'move', generation: 9, gestureId: 1.5 },
      { phase: 'move', generation: 9, gestureId: 4, extra: true },
    ]) {
      await expect(
        harness.ipc.invoke(WIDGET_DRAG, payload, widgetEvent),
      ).rejects.toMatchObject({ code: 'INVALID_IPC_PAYLOAD' })
    }
    expect(setPresentation).toHaveBeenCalledOnce()
    expect(reportDrag).toHaveBeenCalledOnce()
  })

  it('lets only the trusted widget renderer set presentation', async () => {
    const harness = createIpcHarness()
    harness.cleanup()
    const { widgetContents, widgetFrame, widgetUrl } = widgetSender()
    const setPresentation = vi.fn()
    registerIpc(harness.ipc, {
      settings: harness.settings,
      history: harness.history,
      startup: harness.startup,
      hotkeys: harness.hotkeys,
      app: harness.app,
      trustedSenders: () => [
        { role: 'main' as const, webContents: harness.trustedContents, url: harness.trustedUrl },
        { role: 'widget' as const, webContents: widgetContents, url: widgetUrl },
      ],
      widget: { setPresentation, reportDrag: vi.fn() },
    })

    const report = { presentation: 'idle-resting', generation: 3 } as const
    await expect(
      harness.ipc.invoke(WIDGET_PRESENTATION, report, {
        sender: widgetContents,
        senderFrame: widgetFrame,
      }),
    ).resolves.toEqual({ ok: true })
    expect(setPresentation).toHaveBeenCalledWith(report)

    await expect(
      harness.ipc.invoke(WIDGET_PRESENTATION, { presentation: 'active', generation: 3 }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED_IPC_SENDER' })
    expect(setPresentation).toHaveBeenCalledOnce()
  })

  it('accepts idle-resting idle-hovered and active', async () => {
    const harness = createIpcHarness()
    harness.cleanup()
    const { widgetContents, widgetFrame, widgetUrl } = widgetSender()
    const setPresentation = vi.fn()
    registerIpc(harness.ipc, {
      settings: harness.settings,
      history: harness.history,
      startup: harness.startup,
      hotkeys: harness.hotkeys,
      app: harness.app,
      trustedSenders: () => [
        { role: 'widget' as const, webContents: widgetContents, url: widgetUrl },
      ],
      widget: { setPresentation, reportDrag: vi.fn() },
    })
    const widgetEvent = { sender: widgetContents, senderFrame: widgetFrame }

    for (const presentation of ['idle-resting', 'idle-hovered', 'active'] as const) {
      const report = { presentation, generation: 5 } as const
      await expect(
        harness.ipc.invoke(WIDGET_PRESENTATION, report, widgetEvent),
      ).resolves.toEqual({ ok: true })
      expect(setPresentation).toHaveBeenLastCalledWith(report)
    }
    expect(setPresentation).toHaveBeenCalledTimes(3)
  })

  it('active presentation resizes without recreating the widget', async () => {
    const nativeWindows: IpcLifecycleWindow[] = []
    const createWindow = vi.fn((options: WindowConstructorOptions) => {
      const role = options.webPreferences.additionalArguments[0].endsWith('widget')
        ? 'widget'
        : 'main'
      const window = new IpcLifecycleWindow(role, options)
      nativeWindows.push(window)
      return window
    })
    const windows = new WindowManager({
      createWindow,
      display: {
        getCursorScreenPoint: () => ({ x: 1_700, y: 970 }),
        getDisplayNearestPoint: () => ({
          workArea: { x: 1_000, y: 100, width: 1_200, height: 900 },
        }),
      },
      platform: 'win32',
      chrome: platformProfile('win32'),
      preloadPath: 'C:/Sotto/out/preload/index.js',
      mainHtmlPath: 'C:/Sotto/out/renderer/index.html',
      widgetHtmlPath: 'C:/Sotto/out/renderer/widget.html',
      developmentSources: undefined,
      brandIconPath: null,
      isPackaged: true,
      log: vi.fn(),
      getWidgetPlacement: () => null,
      onWidgetMoved: vi.fn(),
    })
    const harness = createIpcHarness()
    harness.cleanup()
    let cleanup = (): void => undefined

    try {
      await windows.createWindows()
      await windows.showWidget()
      const widget = nativeWindows[1]!
      cleanup = registerIpc(harness.ipc, {
        settings: harness.settings,
        history: harness.history,
        startup: harness.startup,
        hotkeys: harness.hotkeys,
        app: harness.app,
        trustedSenders: () => windows.getTrustedRenderers(),
        widget: {
          setPresentation: (presentation) => windows.setWidgetPresentation(presentation),
          reportDrag: (payload) => windows.reportWidgetDrag(payload),
        },
      })
      const widgetEvent = {
        sender: widget.webContents,
        senderFrame: widget.webContents.mainFrame,
      }

      await expect(
        harness.ipc.invoke(
          WIDGET_PRESENTATION,
          { presentation: 'active', generation: 1 },
          widgetEvent,
        ),
      ).resolves.toEqual({ ok: true })

      expect(widget.getBounds()).toMatchObject({ width: 248, height: 88 })
      expect(widget.setBounds).toHaveBeenLastCalledWith(
        { x: 1_476, y: 896, width: 248, height: 88 },
        false,
      )
      expect(createWindow).toHaveBeenCalledTimes(2)
      expect(nativeWindows[1]).toBe(widget)
    } finally {
      cleanup()
      windows.dispose()
    }
  })

  it('rejects unknown non-string and object presentation payloads', async () => {
    const harness = createIpcHarness()
    harness.cleanup()
    const { widgetContents, widgetFrame, widgetUrl } = widgetSender()
    const setPresentation = vi.fn()
    registerIpc(harness.ipc, {
      settings: harness.settings,
      history: harness.history,
      startup: harness.startup,
      hotkeys: harness.hotkeys,
      app: harness.app,
      trustedSenders: () => [
        { role: 'widget' as const, webContents: widgetContents, url: widgetUrl },
      ],
      widget: { setPresentation, reportDrag: vi.fn() },
    })
    const widgetEvent = { sender: widgetContents, senderFrame: widgetFrame }

    for (const payload of ['idle-expanded', 42, { presentation: 'active' }]) {
      await expect(
        harness.ipc.invoke(WIDGET_PRESENTATION, payload, widgetEvent),
      ).rejects.toMatchObject({ code: 'INVALID_IPC_PAYLOAD' })
    }
    expect(setPresentation).not.toHaveBeenCalled()
  })

  it('reports unavailable when no widget coordinator is registered', async () => {
    const harness = createIpcHarness()
    harness.cleanup()
    const { widgetContents, widgetFrame, widgetUrl } = widgetSender()
    registerIpc(harness.ipc, {
      settings: harness.settings,
      history: harness.history,
      startup: harness.startup,
      hotkeys: harness.hotkeys,
      app: harness.app,
      trustedSenders: () => [
        { role: 'widget' as const, webContents: widgetContents, url: widgetUrl },
      ],
    })

    await expect(
      harness.ipc.invoke(WIDGET_PRESENTATION, {
        presentation: 'idle-resting',
        generation: 0,
      }, {
        sender: widgetContents,
        senderFrame: widgetFrame,
      }),
    ).resolves.toEqual({ ok: false, reason: 'unavailable' })
  })

  it('lets only the widget renderer report drag phases and forwards each payload', async () => {
    const harness = createIpcHarness()
    harness.cleanup()
    const { widgetContents, widgetFrame, widgetUrl } = widgetSender()
    const reportDrag = vi.fn()
    registerIpc(harness.ipc, {
      settings: harness.settings,
      history: harness.history,
      startup: harness.startup,
      hotkeys: harness.hotkeys,
      app: harness.app,
      trustedSenders: () => [
        { role: 'main' as const, webContents: harness.trustedContents, url: harness.trustedUrl },
        { role: 'widget' as const, webContents: widgetContents, url: widgetUrl },
      ],
      widget: { setPresentation: vi.fn(), reportDrag },
    })
    const widgetEvent = { sender: widgetContents, senderFrame: widgetFrame }

    for (const payload of [
      { phase: 'start', generation: 5, gestureId: 8 },
      { phase: 'move', generation: 5, gestureId: 8 },
      { phase: 'end', generation: 5, gestureId: 8 },
    ] as const) {
      await expect(
        harness.ipc.invoke(WIDGET_DRAG, payload, widgetEvent),
      ).resolves.toEqual({ ok: true })
      expect(reportDrag).toHaveBeenLastCalledWith(payload)
    }
    expect(reportDrag).toHaveBeenCalledTimes(3)

    // The main renderer and unknown senders may not drive the widget window.
    await expect(
      harness.ipc.invoke(WIDGET_DRAG, { phase: 'start', generation: 5 }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED_IPC_SENDER' })
    expect(reportDrag).toHaveBeenCalledTimes(3)
  })

  it('rejects malformed drag payloads before they reach the window seam', async () => {
    const harness = createIpcHarness()
    harness.cleanup()
    const { widgetContents, widgetFrame, widgetUrl } = widgetSender()
    const reportDrag = vi.fn()
    registerIpc(harness.ipc, {
      settings: harness.settings,
      history: harness.history,
      startup: harness.startup,
      hotkeys: harness.hotkeys,
      app: harness.app,
      trustedSenders: () => [
        { role: 'widget' as const, webContents: widgetContents, url: widgetUrl },
      ],
      widget: { setPresentation: vi.fn(), reportDrag },
    })
    const widgetEvent = { sender: widgetContents, senderFrame: widgetFrame }

    for (const payload of [
      { phase: 'hover', generation: 1, gestureId: 3 },
      { phase: 'move', generation: 1, gestureId: 3, x: 1, y: 0 },
      { phase: 'move', generation: 1, gestureId: 3, extra: true },
      { phase: 'start', generation: 1, gestureId: 3, x: 1, y: 1 },
      { phase: 'end', generation: 1, gestureId: 3, extra: true },
      { phase: 'move', generation: 1 },
      { phase: 'move' },
      'start',
      null,
    ]) {
      await expect(
        harness.ipc.invoke(WIDGET_DRAG, payload, widgetEvent),
      ).rejects.toMatchObject({ code: 'INVALID_IPC_PAYLOAD' })
    }
    expect(reportDrag).not.toHaveBeenCalled()
  })

  it('reports unavailable drag handling when no widget dependency is registered', async () => {
    const harness = createIpcHarness()
    harness.cleanup()
    const { widgetContents, widgetFrame, widgetUrl } = widgetSender()
    registerIpc(harness.ipc, {
      settings: harness.settings,
      history: harness.history,
      startup: harness.startup,
      hotkeys: harness.hotkeys,
      app: harness.app,
      trustedSenders: () => [
        { role: 'widget' as const, webContents: widgetContents, url: widgetUrl },
      ],
    })

    await expect(
      harness.ipc.invoke(WIDGET_DRAG, { phase: 'start', generation: 0, gestureId: 0 }, {
        sender: widgetContents,
        senderFrame: widgetFrame,
      }),
    ).resolves.toEqual({ ok: false, reason: 'unavailable' })
  })
})
