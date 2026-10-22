// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import {
  registerIpc
} from '../../src/main/ipc/registerIpc'
import { OutputService } from '../../src/main/output/outputService'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HistoryRepository } from '../../src/main/storage/historyRepository'
import {
  DICTATION_RECORDS_LIST,
  HISTORY_ADD,
  HISTORY_CLEAR,
  HISTORY_DELETE,
  HISTORY_LIST,
  OUTPUT_COPY_IMAGE,
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

  it.each([
    ['pasted', true, 'Microsoft Outlook'],
    ['copied', false, 'Windows Terminal'],
  ] as const)('keeps the delivered app with a %s dictation, and its text only while history is on', async (outcome, autoPaste, appName) => {
      const root = await mkdtemp(join(tmpdir(), 'sotto-delivered-app-'))
      try {
        const harness = createIpcHarness()
        harness.cleanup()
        const history = new HistoryRepository(join(root, 'history.json'))
        await history.initialize()
        const order: string[] = []
        const output = new OutputService({
          clipboard: { writeText: () => { order.push('clipboard') } },
          widget: { hideWidget: () => { order.push('hide') }, showWidget: vi.fn() },
          delay: vi.fn(),
          process: { run: async () => { order.push('paste'); return true } },
          buildPasteInvocation: () => ({ executable: 'static-paste', args: [] }),
          readFocusedApp: async () => { order.push('app'); return `  ${appName} ` },
        })
        let settings = { ...DEFAULT_SETTINGS, autoPaste: true, historyEnabled: true }
        harness.settings.get.mockImplementation(async () => settings)
        registerIpc(harness.ipc, {
          settings: harness.settings, history, startup: harness.startup, hotkeys: harness.hotkeys, app: harness.app,
          trustedSenders: () => [{ role: 'main', webContents: harness.trustedContents, url: harness.trustedUrl }],
          output,
        })
        const finished = (id: string) => ({ id, text: 'three spoken words', createdAt: id === 'on' ? 2 : 1, durationMs: 1_500, language: 'en', modelPreset: 'parakeet' as const })

        await expect(harness.ipc.invoke(OUTPUT_DELIVER, { text: 'three spoken words', autoPaste, pasteDelayMs: 100, dictationId: 'on' })).resolves.toBe(outcome)
        expect(order[0]).toBe('app')
        await harness.ipc.invoke(HISTORY_ADD, finished('on'))

        settings = { ...settings, historyEnabled: false }
        await harness.ipc.invoke(OUTPUT_DELIVER, { text: 'three spoken words', autoPaste, pasteDelayMs: 100, dictationId: 'off' })
        await expect(harness.ipc.invoke(HISTORY_ADD, finished('off'))).resolves.toEqual([{ ...finished('on'), app: appName }])

        await expect(harness.ipc.invoke(HISTORY_LIST)).resolves.toEqual([{ ...finished('on'), app: appName }])
        await expect(harness.ipc.invoke(DICTATION_RECORDS_LIST)).resolves.toEqual([
          { id: 'on', createdAt: 2, durationMs: 1_500, words: 3, app: appName },
          { id: 'off', createdAt: 1, durationMs: 1_500, words: 3, app: appName },
        ])
        // The records file holds numbers and app names only: no text reaches it.
        expect(await readFile(join(root, 'dictation-records.jsonl'), 'utf8')).not.toContain('spoken')

        // Deleting the transcript deletes its record; clearing deletes every record.
        await expect(harness.ipc.invoke(HISTORY_DELETE, 'on')).resolves.toBe(true)
        await expect(harness.ipc.invoke(DICTATION_RECORDS_LIST)).resolves.toEqual([{ id: 'off', createdAt: 1, durationMs: 1_500, words: 3, app: appName }])
        await harness.ipc.invoke(HISTORY_CLEAR)
        await expect(harness.ipc.invoke(DICTATION_RECORDS_LIST)).resolves.toEqual([])
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })

  it('keeps no delivered app when it cannot be read, the text was not delivered, or the delivery is not a dictation', async () => {
      const harness = createIpcHarness()
      harness.cleanup()
      const readFocusedApp = vi.fn(async (): Promise<string | null> => 'Slack')
      const log = vi.fn()
      let clipboardFails = false
      const output = new OutputService({
        clipboard: { writeText: () => { if (clipboardFails) throw new Error('busy') } },
        widget: { hideWidget: vi.fn(), showWidget: vi.fn() },
        delay: vi.fn(),
        process: { run: async () => true },
        buildPasteInvocation: () => ({ executable: 'static-paste', args: [] }),
        readFocusedApp,
        log,
      })
      harness.settings.get.mockResolvedValue({ ...DEFAULT_SETTINGS, historyEnabled: true })
      registerIpc(harness.ipc, {
        settings: harness.settings, history: harness.history, startup: harness.startup, hotkeys: harness.hotkeys, app: harness.app,
        trustedSenders: () => [{ role: 'main', webContents: harness.trustedContents, url: harness.trustedUrl }],
        output,
      })
      const finished = (id: string) => ({ id, text: 'words', createdAt: 1, durationMs: 1, language: 'en', modelPreset: 'parakeet' as const })
      const deliverAndAdd = async (id: string) => {
        await harness.ipc.invoke(OUTPUT_DELIVER, { text: 'words', autoPaste: false, pasteDelayMs: 100, dictationId: id }).catch(() => undefined)
        await harness.ipc.invoke(HISTORY_ADD, finished(id))
      }

      readFocusedApp.mockRejectedValueOnce(new Error('C:/private/window title'))
      await deliverAndAdd('unreadable')
      readFocusedApp.mockResolvedValueOnce('   ')
      await deliverAndAdd('blank')
      clipboardFails = true
      await deliverAndAdd('undelivered')
      clipboardFails = false
      await harness.ipc.invoke(OUTPUT_DELIVER, { text: 'words', autoPaste: false, pasteDelayMs: 100 })
      await harness.ipc.invoke(HISTORY_ADD, finished('copied-from-history'))

      expect((harness.history.add.mock.calls as unknown as [unknown][]).map(([entry]) => entry)).toEqual([
        finished('unreadable'), finished('blank'), finished('undelivered'), finished('copied-from-history'),
      ])
      expect(readFocusedApp).toHaveBeenCalledTimes(3)
      expect(log.mock.calls).toEqual([['delivered-app-unreadable']])
    })

  it('puts a PNG on the clipboard and refuses anything that is not one', async () => {
      const harness = createIpcHarness()
      const writePng = vi.fn()
      harness.cleanup()
      const register = (imageClipboard?: { writePng(png: Buffer): void }): (() => void) => registerIpc(harness.ipc, {
        settings: harness.settings,
        history: harness.history,
        startup: harness.startup,
        hotkeys: harness.hotkeys,
        app: harness.app,
        trustedSenders: () => [{ role: 'main', webContents: harness.trustedContents, url: harness.trustedUrl }],
        ...(imageClipboard === undefined ? {} : { imageClipboard }),
      })
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
      const dataUrl = `data:image/png;base64,${png.toString('base64')}`
      let cleanup = register({ writePng })
      await expect(harness.ipc.invoke(OUTPUT_COPY_IMAGE, { dataUrl })).resolves.toEqual({ ok: true })
      expect(writePng).toHaveBeenCalledOnce()
      expect(writePng.mock.calls[0]![0].equals(png)).toBe(true)

      // Labelled PNG but not one, another format, or extra fields never reach the clipboard.
      await expect(harness.ipc.invoke(OUTPUT_COPY_IMAGE, { dataUrl: `data:image/png;base64,${Buffer.from('GIF89a').toString('base64')}` })).resolves.toEqual({ ok: false, reason: 'unavailable' })
      await expect(harness.ipc.invoke(OUTPUT_COPY_IMAGE, { dataUrl: dataUrl.replace('image/png', 'image/jpeg') })).rejects.toThrow()
      await expect(harness.ipc.invoke(OUTPUT_COPY_IMAGE, { dataUrl, path: 'C:/secret.png' })).rejects.toThrow()
      expect(writePng).toHaveBeenCalledOnce()
      cleanup()

      // A clipboard that refuses, or none at all, reads as unavailable.
      cleanup = register({ writePng: () => { throw new Error('busy') } })
      await expect(harness.ipc.invoke(OUTPUT_COPY_IMAGE, { dataUrl })).resolves.toEqual({ ok: false, reason: 'unavailable' })
      cleanup()
      cleanup = register()
      await expect(harness.ipc.invoke(OUTPUT_COPY_IMAGE, { dataUrl })).resolves.toEqual({ ok: false, reason: 'unavailable' })
      cleanup()
    })
})
