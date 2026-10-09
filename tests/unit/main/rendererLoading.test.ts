// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { parseDevelopmentRendererSources, RendererLoadError, WindowManager } from '../../../src/main/windows/windowManager'
import { createHarness } from '../../fixtures/windowManager'

describe('WindowManager renderer loading', () => {
  it('withholds the bundled identity until loadFile resolves', async () => {
    const managerRef: { current?: WindowManager } = {}
    let identityDuringLoad: ReturnType<WindowManager['getTrustedRenderers']> = []
    const harness = createHarness({}, (window) => {
      window.loadFile.mockImplementationOnce(async () => {
        identityDuringLoad = managerRef.current!.getTrustedRenderers()
      })
    })
    managerRef.current = harness.manager

    await harness.manager.createMainWindow()

    expect(identityDuringLoad).toStrictEqual([])
  })

  it('withholds trust during development and bundled fallback loads', async () => {
    const managerRef: { current?: WindowManager } = {}
    let identityDuringDevelopmentLoad: ReturnType<
      WindowManager['getTrustedRenderers']
    > = []
    let identityDuringBundledFallback: ReturnType<
      WindowManager['getTrustedRenderers']
    > = []
    const harness = createHarness(
      {
        isPackaged: false,
        developmentSources: parseDevelopmentRendererSources('http://127.0.0.1:5173')!,
      },
      (window) => {
        window.loadURL.mockImplementationOnce(async () => {
          identityDuringDevelopmentLoad = managerRef.current!.getTrustedRenderers()
          throw new Error('development renderer unavailable')
        })
        window.loadFile.mockImplementationOnce(async () => {
          identityDuringBundledFallback = managerRef.current!.getTrustedRenderers()
        })
      },
    )
    managerRef.current = harness.manager

    await harness.manager.createMainWindow()

    expect(identityDuringDevelopmentLoad).toStrictEqual([])
    expect(identityDuringBundledFallback).toStrictEqual([])
  })

  it('falls back from a failed development URL to the bundled local renderer without leaking details', async () => {
    const loadFailure = new Error('token=secret C:/Users/private/source')
    const { log, manager, windows } = createHarness(
      {
        isPackaged: false,
        developmentSources: parseDevelopmentRendererSources('http://127.0.0.1:5173')!,
      },
      (window) => window.loadURL.mockRejectedValueOnce(loadFailure),
    )

    await manager.createMainWindow()

    expect(windows[0]!.loadURL).toHaveBeenCalledWith(
      'http://127.0.0.1:5173/index.html',
    )
    expect(windows[0]!.loadFile).toHaveBeenCalledWith('C:/Sotto/out/renderer/index.html')
    expect(log).toHaveBeenCalledWith('renderer-load-failed:main:development')
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret')
    expect(JSON.stringify(log.mock.calls)).not.toContain('C:/Users')
  })

  it('never trusts a development renderer URL in a packaged build', async () => {
    const { manager, windows } = createHarness({
      isPackaged: true,
      developmentSources: {
        main: new URL('https://attacker.invalid/main'),
        widget: new URL('https://attacker.invalid/widget'),
      },
    })

    const creation = manager.createMainWindow()
    await creation

    expect(windows[0]!.loadURL).not.toHaveBeenCalled()
    expect(windows[0]!.loadFile).toHaveBeenCalledWith('C:/Sotto/out/renderer/index.html')
  })

  it('rejects a failed bundled renderer with a sanitized operational error', async () => {
    const { log, manager } = createHarness(
      {},
      (window) =>
        window.loadFile.mockRejectedValueOnce(
          new Error('password=private C:/Users/private/out/renderer/index.html'),
        ),
    )

    await expect(manager.createMainWindow()).rejects.toEqual(new RendererLoadError('main'))
    expect(manager.getTrustedRenderers()).toStrictEqual([])
    expect(log).toHaveBeenCalledWith('renderer-load-failed:main:bundled')
    expect(JSON.stringify(log.mock.calls)).not.toContain('private')
  })

  it('clears a rejected creation promise so a later local renderer retry can recover', async () => {
    let creationCount = 0
    const { createWindow, manager } = createHarness({}, (window) => {
      if (creationCount === 0) {
        window.loadFile.mockRejectedValueOnce(new Error('first load fails'))
      }
      creationCount += 1
    })

    await expect(manager.createMainWindow()).rejects.toEqual(new RendererLoadError('main'))
    await expect(manager.createMainWindow()).resolves.toBeDefined()

    expect(createWindow).toHaveBeenCalledTimes(2)
  })

  it('loads distinct exact main and widget development URLs from validated URL objects', async () => {
    const { manager, windows } = createHarness({
      isPackaged: false,
      developmentSources: parseDevelopmentRendererSources('https://localhost:5173')!,
    })

    await manager.createWindows()

    expect(windows[0]!.loadURL).toHaveBeenCalledWith(
      'https://localhost:5173/index.html',
    )
    expect(windows[1]!.loadURL).toHaveBeenCalledWith(
      'https://localhost:5173/widget.html',
    )
  })
})

describe('parseDevelopmentRendererSources', () => {
  it.each([
    'https://attacker.invalid',
    'http://user:password@localhost:5173',
    'file:///C:/renderer/index.html',
    'ftp://127.0.0.1/renderer',
    'http://192.168.1.10:5173',
    'http://localhost:5173/not-the-dev-root',
    'not a URL',
  ])('rejects unsafe raw development renderer source %s', (raw) => {
    expect(parseDevelopmentRendererSources(raw)).toBeUndefined()
  })

  it.each(['http://localhost:5173', 'http://127.0.0.1:5173/', 'https://[::1]:5173/'])(
    'accepts loopback http(s) without credentials: %s',
    (raw) => {
      const sources = parseDevelopmentRendererSources(raw)

      expect(sources?.main).toBeInstanceOf(URL)
      expect(sources?.widget).toBeInstanceOf(URL)
      expect(sources?.main.href).toBe(`${new URL(raw).origin}/index.html`)
      expect(sources?.widget.href).toBe(`${new URL(raw).origin}/widget.html`)
    },
  )
})
