import { describe, expect, it, vi } from 'vitest'

import type { TrayIconSource } from '../../../src/main/platformProfile'
import { createTrayResource } from '../../../src/main/tray/trayIcon'

const EXECUTABLE_SOURCE: TrayIconSource = { kind: 'executable' }
const TEMPLATE_SOURCE: TrayIconSource = {
  kind: 'template',
  relativePath: 'tray/sottoTemplate.png',
}

function createHarness(
  options: {
    readonly empty?: boolean
    readonly failLoad?: boolean
    readonly failCreate?: boolean
  } = {},
) {
  const icon = { isEmpty: vi.fn(() => options.empty === true) }
  const tray = {
    destroy: vi.fn(() => undefined),
    setToolTip: vi.fn((text: string) => {
      void text
    }),
  }
  return {
    icon,
    tray,
    getFileIcon: vi.fn(
      async (path: string, iconOptions: { readonly size: 'small' }) => {
        void path
        void iconOptions
        if (options.failLoad === true) throw new Error('secret icon path')
        return icon
      },
    ),
    loadImageIcon: vi.fn((path: string) => {
      void path
      if (options.failLoad === true) throw new Error('secret icon path')
      return icon
    }),
    markTemplate: vi.fn((templateIcon: typeof icon) => {
      void templateIcon
    }),
    createTray: vi.fn((trayIcon: typeof icon) => {
      void trayIcon
      if (options.failCreate === true) throw new Error('secret native tray detail')
      return tray
    }),
  }
}

type Harness = ReturnType<typeof createHarness>

function createOptions(
  harness: Harness,
  source: TrayIconSource,
  configure: (tray: Harness['tray']) => void = (created) =>
    created.setToolTip('Sotto'),
) {
  return {
    source,
    executablePath: 'C:/Sotto/Sotto.exe',
    getFileIcon: harness.getFileIcon,
    resolveResourcePath: (relativePath: string) =>
      `/Applications/Sotto.app/Contents/Resources/${relativePath}`,
    loadImageIcon: harness.loadImageIcon,
    markTemplate: harness.markTemplate,
    createTray: harness.createTray,
    configure,
  }
}

describe('createTrayResource', () => {
  it('loads and validates the executable icon before constructing the tray', async () => {
    const harness = createHarness()

    await expect(
      createTrayResource(createOptions(harness, EXECUTABLE_SOURCE)),
    ).resolves.toBe(harness.tray)

    expect(harness.getFileIcon).toHaveBeenCalledWith('C:/Sotto/Sotto.exe', {
      size: 'small',
    })
    expect(harness.loadImageIcon).not.toHaveBeenCalled()
    expect(harness.markTemplate).not.toHaveBeenCalled()
    expect(harness.createTray).toHaveBeenCalledWith(harness.icon)
    expect(harness.tray.setToolTip).toHaveBeenCalledWith('Sotto')
  })

  it('loads the template image from the resolved resource path and marks it', async () => {
    const harness = createHarness()

    await expect(
      createTrayResource(createOptions(harness, TEMPLATE_SOURCE)),
    ).resolves.toBe(harness.tray)

    expect(harness.loadImageIcon).toHaveBeenCalledWith(
      '/Applications/Sotto.app/Contents/Resources/tray/sottoTemplate.png',
    )
    expect(harness.getFileIcon).not.toHaveBeenCalled()
    expect(harness.markTemplate).toHaveBeenCalledWith(harness.icon)
    expect(harness.createTray).toHaveBeenCalledWith(harness.icon)
    expect(harness.tray.setToolTip).toHaveBeenCalledWith('Sotto')
  })

  it.each([
    ['executable', EXECUTABLE_SOURCE],
    ['template', TEMPLATE_SOURCE],
  ] as const)(
    'fails with a finite error when the %s icon is missing',
    async (_name, source) => {
      const harness = createHarness({ empty: true })

      await expect(
        createTrayResource(createOptions(harness, source)),
      ).rejects.toMatchObject({ code: 'NATIVE_TRAY_CREATION_FAILED' })

      expect(harness.markTemplate).not.toHaveBeenCalled()
      expect(harness.createTray).not.toHaveBeenCalled()
      expect(harness.tray.destroy).not.toHaveBeenCalled()
    },
  )

  const failures = ['empty', 'load', 'create', 'configure'] as const
  const sources = [
    ['executable', EXECUTABLE_SOURCE],
    ['template', TEMPLATE_SOURCE],
  ] as const

  it.each(
    sources.flatMap(([name, source]) =>
      failures.map((failure) => [name, source, failure] as const),
    ),
  )(
    'fails with a finite error and cleans a partially created %s tray for %s failure',
    async (_name, source, failure) => {
      const harness = createHarness({
        ...(failure === 'empty' ? { empty: true } : {}),
        ...(failure === 'load' ? { failLoad: true } : {}),
        ...(failure === 'create' ? { failCreate: true } : {}),
      })

      let creationError: unknown
      try {
        await createTrayResource(
          createOptions(harness, source, (created) => {
            if (failure === 'configure') {
              throw new Error('secret tooltip detail')
            }
            created.setToolTip('Sotto')
          }),
        )
      } catch (error) {
        creationError = error
      }

      expect(creationError).toMatchObject({ code: 'NATIVE_TRAY_CREATION_FAILED' })
      expect(JSON.stringify(creationError)).not.toContain('secret')
      expect(harness.createTray).toHaveBeenCalledTimes(
        failure === 'empty' || failure === 'load' ? 0 : 1,
      )
      expect(harness.tray.destroy).toHaveBeenCalledTimes(
        failure === 'configure' ? 1 : 0,
      )
    },
  )

  it.each([
    ['executable', EXECUTABLE_SOURCE],
    ['template', TEMPLATE_SOURCE],
  ] as const)(
    'contains destroy failure while unwinding %s configuration',
    async (_name, source) => {
      const harness = createHarness()
      harness.tray.destroy.mockImplementation(() => {
        throw new Error('secret destroy detail')
      })

      await expect(
        createTrayResource(
          createOptions(harness, source, () => {
            throw new Error('secret configure detail')
          }),
        ),
      ).rejects.toMatchObject({ code: 'NATIVE_TRAY_CREATION_FAILED' })
    },
  )
})
