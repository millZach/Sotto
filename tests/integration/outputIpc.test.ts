// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import {
  registerIpc
} from '../../src/main/ipc/registerIpc'
import { OutputService } from '../../src/main/output/outputService'
import {
  OUTPUT_DELIVER
} from '../../src/shared/channels'
import {
  DEFAULT_SETTINGS
} from '../../src/shared/settings'
import { createIpcHarness } from '../fixtures/ipcHarness'

describe('IPC validation and lifecycle', () => {
  it('clamps stale renderer output policy against current authoritative settings', async () => {
      const harness = createIpcHarness()
      const pasteProcess = { run: vi.fn(async () => true) }
      const clipboard = { writeText: vi.fn() }
      const output = new OutputService({
        clipboard,
        widget: { hideWidget: vi.fn(), showWidget: vi.fn() },
        delay: vi.fn(),
        process: pasteProcess,
        buildPasteInvocation: () => ({ executable: 'static-paste', args: [] }),
      })
      const deliver = vi.spyOn(output, 'deliver')
      harness.cleanup()
      registerIpc(harness.ipc, {
        settings: harness.settings,
        history: harness.history,
        startup: harness.startup,
        hotkeys: harness.hotkeys,
        app: harness.app,
        trustedSenders: () => [
          {
            role: 'main',
            webContents: harness.trustedContents,
            url: harness.trustedUrl,
          },
        ],
        output,
      })
      harness.settings.get.mockResolvedValueOnce({
        ...DEFAULT_SETTINGS,
        autoPaste: false,
        pasteDelayMs: 480,
      })
      const request = { text: 'hello world', autoPaste: true, pasteDelayMs: 120 }
      await expect(harness.ipc.invoke(OUTPUT_DELIVER, request)).resolves.toBe('copied')
      expect(deliver).toHaveBeenCalledWith('hello world', {
        autoPaste: false,
        pasteDelayMs: 480,
        restoreWidget: DEFAULT_SETTINGS.showWidgetWhenIdle,
      })
      expect(pasteProcess.run).not.toHaveBeenCalled()
      expect(clipboard.writeText).toHaveBeenCalledWith('hello world')
      expect(harness.settings.get).toHaveBeenCalledOnce()

      harness.settings.get.mockResolvedValueOnce({
        ...DEFAULT_SETTINGS,
        autoPaste: true,
        pasteDelayMs: 80,
        showWidgetWhenIdle: false,
      })
      await harness.ipc.invoke(OUTPUT_DELIVER, {
        text: 'session disabled',
        autoPaste: false,
        pasteDelayMs: 700,
      })
      expect(deliver).toHaveBeenLastCalledWith('session disabled', {
        autoPaste: false,
        pasteDelayMs: 700,
        restoreWidget: false,
      })
      expect(pasteProcess.run).not.toHaveBeenCalled()

      await expect(
        harness.ipc.invoke(OUTPUT_DELIVER, {
          text: 'hostile',
          autoPaste: true,
          pasteDelayMs: 49,
        }),
      ).rejects.toThrow('Invalid IPC payload')
      await expect(harness.ipc.invoke(OUTPUT_DELIVER, 42)).rejects.toThrow(
        'Invalid IPC payload',
      )
      await expect(
        harness.ipc.invoke(OUTPUT_DELIVER, {
          text: 'x'.repeat(200_001),
          autoPaste: true,
          pasteDelayMs: 150,
        }),
      ).rejects.toThrow('Invalid IPC payload')
      await expect(
        harness.ipc.invoke(OUTPUT_DELIVER, { ...request, injected: 'app:quit' }),
      ).rejects.toThrow('Invalid IPC payload')
      expect(deliver).toHaveBeenCalledTimes(2)
    })

  it('delivers empty output with the captured session policy', async () => {
      const harness = createIpcHarness()
      const deliver = vi.fn(async () => 'empty' as const)
      harness.cleanup()
      registerIpc(harness.ipc, {
        settings: harness.settings,
        history: harness.history,
        startup: harness.startup,
        hotkeys: harness.hotkeys,
        app: harness.app,
        trustedSenders: () => [
          {
            role: 'main',
            webContents: harness.trustedContents,
            url: harness.trustedUrl,
          },
        ],
        output: { deliver },
      })
      await expect(harness.ipc.invoke(OUTPUT_DELIVER, {
        text: '',
        autoPaste: true,
        pasteDelayMs: 410,
      })).resolves.toBe('empty')
      expect(deliver).toHaveBeenCalledWith('', {
        autoPaste: true,
        pasteDelayMs: 410,
        restoreWidget: DEFAULT_SETTINGS.showWidgetWhenIdle,
      })
    })
})
