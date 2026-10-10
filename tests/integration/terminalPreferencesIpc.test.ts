// @vitest-environment node
import { expect, it } from 'vitest'
import { SETTINGS_UPDATE } from '../../src/shared/channels'
import { createIpcHarness } from '../fixtures/ipcHarness'

it('persists terminal font size through settings IPC and rejects sizes outside the terminal range', async () => {
  const { ipc, settings, cleanup } = createIpcHarness()
  try {
    await expect(ipc.invoke(SETTINGS_UPDATE, { terminalFontSize: 19 })).resolves.toMatchObject({ terminalFontSize: 19 })
    expect(settings.update).toHaveBeenCalledExactlyOnceWith({ terminalFontSize: 19 })
    for (const terminalFontSize of [7, 33, 12.5, '16']) await expect(ipc.invoke(SETTINGS_UPDATE, { terminalFontSize })).rejects.toThrow('Invalid IPC payload')
    expect(settings.update).toHaveBeenCalledOnce()
  } finally { cleanup() }
})
