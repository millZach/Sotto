import { describe, expect, it, vi } from 'vitest'

import { createTrayResource } from '../../../src/main/tray/trayIcon'

describe('createTrayResource', () => {
  it('loads and validates the executable icon before constructing the tray', async () => {
    const icon = { isEmpty: vi.fn(() => false) }
    const tray = { destroy: vi.fn(), setToolTip: vi.fn() }
    const getFileIcon = vi.fn(async () => icon)
    const createTray = vi.fn(() => tray)

    await expect(
      createTrayResource({
        executablePath: 'C:/Sotto/Sotto.exe',
        getFileIcon,
        createTray,
        configure: (created) => created.setToolTip('Sotto'),
      }),
    ).resolves.toBe(tray)

    expect(getFileIcon).toHaveBeenCalledWith('C:/Sotto/Sotto.exe', {
      size: 'small',
    })
    expect(createTray).toHaveBeenCalledWith(icon)
    expect(tray.setToolTip).toHaveBeenCalledWith('Sotto')
  })

  it.each(['empty', 'load', 'create', 'configure'] as const)(
    'fails with a finite error and cleans a partially created tray for %s failure',
    async (failure) => {
      const icon = { isEmpty: vi.fn(() => failure === 'empty') }
      const tray = { destroy: vi.fn(), setToolTip: vi.fn() }
      const getFileIcon = vi.fn(async () => {
        if (failure === 'load') {
          throw new Error('secret icon path')
        }
        return icon
      })
      const createTray = vi.fn(() => {
        if (failure === 'create') {
          throw new Error('secret native tray detail')
        }
        return tray
      })

      let creationError: unknown
      try {
        await createTrayResource({
          executablePath: 'C:/Sotto/Sotto.exe',
          getFileIcon,
          createTray,
          configure: (created) => {
            if (failure === 'configure') {
              throw new Error('secret tooltip detail')
            }
            created.setToolTip('Sotto')
          },
        })
      } catch (error) {
        creationError = error
      }

      expect(creationError).toMatchObject({ code: 'NATIVE_TRAY_CREATION_FAILED' })
      expect(JSON.stringify(creationError)).not.toContain('secret')
      expect(createTray).toHaveBeenCalledTimes(
        failure === 'empty' || failure === 'load' ? 0 : 1,
      )
      expect(tray.destroy).toHaveBeenCalledTimes(failure === 'configure' ? 1 : 0)
    },
  )

  it('contains destroy failure while unwinding configuration', async () => {
    const tray = {
      destroy: vi.fn(() => {
        throw new Error('secret destroy detail')
      }),
    }

    await expect(
      createTrayResource({
        executablePath: 'C:/Sotto/Sotto.exe',
        getFileIcon: vi.fn(async () => ({ isEmpty: () => false })),
        createTray: () => tray,
        configure: () => {
          throw new Error('secret configure detail')
        },
      }),
    ).rejects.toMatchObject({ code: 'NATIVE_TRAY_CREATION_FAILED' })
  })
})
