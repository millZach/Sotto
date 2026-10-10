// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { createDeferred, createHarness } from '../../fixtures/windowManager'

describe('WindowManager lifecycle', () => {
  it('disposes both windows idempotently and releases listeners', async () => {
    const { manager, windows } = createHarness()
    await manager.createWindows()

    manager.dispose()
    manager.dispose()

    expect(windows[0]!.destroy).toHaveBeenCalledOnce()
    expect(windows[1]!.destroy).toHaveBeenCalledOnce()
    expect(windows[0]!.removedListeners).toStrictEqual(['maximize', 'unmaximize', 'hide', 'minimize', 'close', 'closed'])
    expect(windows[0]!.webContents.removeListener).toHaveBeenCalledTimes(3)
    expect(windows[1]!.removedListeners).toStrictEqual(['closed', 'moved'])
    expect(windows[1]!.webContents.removeListener).toHaveBeenCalledTimes(3)
  })

  it('denies all renderer-created windows and subsequent navigation', async () => {
    const { manager, windows } = createHarness()
    await manager.createMainWindow()
    const contents = windows[0]!.webContents

    const openHandler = contents.setWindowOpenHandler.mock.calls[0]?.[0]
    expect(openHandler?.({ url: 'https://attacker.invalid' })).toEqual({ action: 'deny' })

    for (const eventName of ['will-navigate', 'will-frame-navigate', 'will-redirect']) {
      const navigationRegistration = contents.on.mock.calls.find(
        ([event]) => event === eventName,
      )
      const navigationEvent = { preventDefault: vi.fn() }
      navigationRegistration?.[1]?.(navigationEvent, { url: 'https://attacker.invalid' })
      expect(navigationEvent.preventDefault).toHaveBeenCalledOnce()
    }
  })

  it('rejects every create and show entry point after disposal without constructing a window', async () => {
    const { createWindow, manager } = createHarness()
    manager.dispose()

    await expect(manager.createMainWindow()).rejects.toMatchObject({
      name: 'WindowManagerStoppedError',
      code: 'WINDOW_MANAGER_STOPPED',
    })
    await expect(manager.createWidgetWindow()).rejects.toMatchObject({
      name: 'WindowManagerStoppedError',
      code: 'WINDOW_MANAGER_STOPPED',
    })
    await expect(manager.showMain()).rejects.toMatchObject({
      name: 'WindowManagerStoppedError',
      code: 'WINDOW_MANAGER_STOPPED',
    })
    await expect(manager.showWidget()).rejects.toMatchObject({
      name: 'WindowManagerStoppedError',
      code: 'WINDOW_MANAGER_STOPPED',
    })
    expect(createWindow).not.toHaveBeenCalled()
  })

  it('does not resurrect or cache a main window when disposal wins an in-flight renderer load', async () => {
    const rendererLoad = createDeferred<void>()
    const { createWindow, manager, windows } = createHarness({}, (window) => {
      window.loadFile.mockImplementationOnce(() => rendererLoad.promise)
    })
    const creation = manager.createMainWindow()

    manager.dispose()
    rendererLoad.resolve()

    await expect(creation).rejects.toMatchObject({
      name: 'WindowManagerStoppedError',
      code: 'WINDOW_MANAGER_STOPPED',
    })
    expect(windows[0]!.destroy).toHaveBeenCalledOnce()
    await expect(manager.createMainWindow()).rejects.toMatchObject({
      code: 'WINDOW_MANAGER_STOPPED',
    })
    expect(createWindow).toHaveBeenCalledOnce()
  })

  it('destroys and replaces the main window after its renderer process exits', async () => {
    const { createWindow, manager, windows } = createHarness()
    await manager.createMainWindow()
    const crashed = windows[0]!

    crashed.emitRenderProcessGone()

    expect(crashed.destroy).toHaveBeenCalledOnce()
    expect(crashed.removedListeners).toStrictEqual(['maximize', 'unmaximize', 'hide', 'minimize', 'close', 'closed'])
    expect(crashed.webContents.removeListener).toHaveBeenCalledTimes(3)
    expect(crashed.removeRenderProcessGoneListener).toHaveBeenCalledOnce()
    expect(manager.getMainWebContents()).toBeNull()

    await manager.showMain()

    expect(createWindow).toHaveBeenCalledTimes(2)
    expect(windows[1]!.loadFile).toHaveBeenCalledWith('C:/Sotto/out/renderer/index.html')
    expect(windows[1]!.show).toHaveBeenCalledOnce()
    expect(windows[1]!.focus).toHaveBeenCalledOnce()
  })

  it('reports renderer loss through the public lifecycle seam and contains handler details', async () => {
    const onRendererProcessGone = vi.fn(() => {
      throw new Error('private renderer crash detail')
    })
    const { log, manager, windows } = createHarness({ onRendererProcessGone })
    await manager.createMainWindow()

    expect(() => windows[0]!.emitRenderProcessGone()).not.toThrow()

    expect(onRendererProcessGone).toHaveBeenCalledWith('main')
    expect(log).toHaveBeenCalledWith('renderer-process-gone-handler-failed:main')
    expect(JSON.stringify(log.mock.calls)).not.toContain('private renderer crash detail')
  })

  it('exposes only the live loaded renderer identities after crash recovery', async () => {
    const { manager, windows } = createHarness()
    await manager.createWindows()
    const originalMain = windows[0]!
    const originalWidget = windows[1]!

    expect(manager.getTrustedRenderers()).toStrictEqual([
      {
        role: 'main',
        webContents: originalMain.webContents,
        url: 'file:///C:/Sotto/out/renderer/index.html',
      },
      {
        role: 'widget',
        webContents: originalWidget.webContents,
        url: 'file:///C:/Sotto/out/renderer/index.html',
      },
    ])

    originalMain.emitRenderProcessGone()
    expect(manager.getTrustedRenderers()).toStrictEqual([
      {
        role: 'widget',
        webContents: originalWidget.webContents,
        url: 'file:///C:/Sotto/out/renderer/index.html',
      },
    ])

    await manager.createMainWindow()
    expect(manager.getTrustedRenderers()).toStrictEqual([
      {
        role: 'main',
        webContents: windows[2]!.webContents,
        url: 'file:///C:/Sotto/out/renderer/index.html',
      },
      {
        role: 'widget',
        webContents: originalWidget.webContents,
        url: 'file:///C:/Sotto/out/renderer/index.html',
      },
    ])
    expect(manager.getTrustedRenderers()).not.toContainEqual(
      expect.objectContaining({ webContents: originalMain.webContents }),
    )
  })

  it('destroys and replaces the widget window after its renderer process exits', async () => {
    const { createWindow, manager, windows } = createHarness()
    await manager.createWidgetWindow()
    const crashed = windows[0]!

    crashed.emitRenderProcessGone()

    expect(crashed.destroy).toHaveBeenCalledOnce()
    expect(crashed.removedListeners).toStrictEqual(['closed', 'moved'])
    expect(crashed.webContents.removeListener).toHaveBeenCalledTimes(3)
    expect(crashed.removeRenderProcessGoneListener).toHaveBeenCalledOnce()
    expect(manager.getWidgetWebContents()).toBeNull()

    await manager.showWidget()

    expect(createWindow).toHaveBeenCalledTimes(2)
    expect(windows[1]!.loadFile).toHaveBeenCalledWith('C:/Sotto/out/renderer/widget.html')
    expect(windows[1]!.showInactive).toHaveBeenCalledOnce()
  })

  it('rejects an in-flight creation whose renderer exits and allows a fresh retry', async () => {
    const firstLoad = createDeferred<void>()
    let creationCount = 0
    const { createWindow, manager, windows } = createHarness({}, (window) => {
      if (creationCount === 0) {
        window.loadFile.mockImplementationOnce(() => firstLoad.promise)
      }
      creationCount += 1
    })
    const creation = manager.createMainWindow()

    windows[0]!.emitRenderProcessGone()
    firstLoad.resolve()

    await expect(creation).rejects.toMatchObject({
      name: 'RendererProcessGoneError',
      code: 'RENDERER_PROCESS_GONE',
    })
    expect(windows[0]!.destroy).toHaveBeenCalledOnce()
    expect(windows[0]!.removeRenderProcessGoneListener).toHaveBeenCalledOnce()

    await expect(manager.createMainWindow()).resolves.toBe(windows[1])
    expect(createWindow).toHaveBeenCalledTimes(2)
  })

  it('does not cache a renderer that exits synchronously while its load starts', async () => {
    const firstLoad = createDeferred<void>()
    let creationCount = 0
    const { createWindow, manager, windows } = createHarness({}, (window) => {
      if (creationCount === 0) {
        window.loadFile.mockImplementationOnce(() => {
          window.emitRenderProcessGone()
          return firstLoad.promise
        })
      }
      creationCount += 1
    })

    const firstCreation = manager.createMainWindow()
    const retry = manager.createMainWindow()

    await expect(retry).resolves.toBe(windows[1])
    expect(createWindow).toHaveBeenCalledTimes(2)
    firstLoad.resolve()
    await expect(firstCreation).rejects.toMatchObject({ code: 'RENDERER_PROCESS_GONE' })
  })

  it('does not duplicate cleanup when renderer exit overlaps a pending load and quit', async () => {
    const rendererLoad = createDeferred<void>()
    const { manager, windows } = createHarness({}, (window) => {
      window.loadFile.mockImplementationOnce(() => rendererLoad.promise)
    })
    const creation = manager.createWidgetWindow()

    manager.beginQuit()
    manager.dispose()
    windows[0]!.emitRenderProcessGone()
    rendererLoad.resolve()

    await expect(creation).rejects.toMatchObject({ code: 'WINDOW_MANAGER_STOPPED' })
    expect(windows[0]!.destroy).toHaveBeenCalledOnce()
    expect(windows[0]!.removeRenderProcessGoneListener).toHaveBeenCalledOnce()
    expect(windows[0]!.renderProcessGoneListeners.size).toBe(0)
  })
})
