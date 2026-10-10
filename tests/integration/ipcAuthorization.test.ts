// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import {
  registerIpc
} from '../../src/main/ipc/registerIpc'
import {
  APP_QUIT,
  APP_RELOAD,
  DICTATION_REQUEST,
  HISTORY_CLEAR,
  MICROPHONE_ENSURE_ACCESS,
  OUTPUT_DELIVER,
  SETTINGS_GET,
  SETTINGS_UPDATE,
  TRANSCRIPTION_CANCEL,
  TRANSCRIPTION_CHECK_KEY,
  TRANSCRIPTION_TRANSCRIBE,
  WIDGET_PUBLISH
} from '../../src/shared/channels'
import { createIpcHarness, FakeIpcMain } from '../fixtures/ipcHarness'

describe('IPC validation and lifecycle', () => {
  it('reloads the main window through the authenticated no-payload command', async () => {
      const { ipc, app } = createIpcHarness()
      await ipc.invokeArgs(APP_RELOAD, [])
      expect(app.reload).toHaveBeenCalledOnce()
      await expect(ipc.invoke(APP_RELOAD, 'https://example.com')).rejects.toThrow('Invalid IPC payload')
      expect(app.reload).toHaveBeenCalledOnce()
    })

  it('asks the operating system for microphone access when a gate is installed', async () => {
      const harness = createIpcHarness()
      await expect(harness.ipc.invokeArgs(MICROPHONE_ENSURE_ACCESS, [])).resolves.toBe(true)
      harness.cleanup()
      const ensure = vi.fn(async () => false)
      const ipc = new FakeIpcMain(harness.trustedEvent)
      const cleanup = registerIpc(ipc, {
        settings: harness.settings,
        history: harness.history,
        startup: harness.startup,
        hotkeys: harness.hotkeys,
        app: harness.app,
        trustedSenders: () => [{ role: 'main', webContents: harness.trustedContents, url: harness.trustedUrl }],
        microphoneAccess: { ensure },
      })
      try {
        await expect(ipc.invokeArgs(MICROPHONE_ENSURE_ACCESS, [])).resolves.toBe(false)
        expect(ensure).toHaveBeenCalledOnce()
      } finally {
        cleanup()
      }
    })

  it.each([
      SETTINGS_GET,
      SETTINGS_UPDATE,
      HISTORY_CLEAR,
      APP_RELOAD,
      APP_QUIT,
      WIDGET_PUBLISH,
      OUTPUT_DELIVER,
      TRANSCRIPTION_TRANSCRIBE,
      TRANSCRIPTION_CANCEL,
      TRANSCRIPTION_CHECK_KEY,
      MICROPHONE_ENSURE_ACCESS,
    ])(
      'denies widget renderer invocation of main-only channel %s',
      async (channel) => {
        const harness = createIpcHarness()
        harness.cleanup()
        const widgetUrl = 'file:///C:/Sotto/out/renderer/widget.html'
        const widgetFrame = { parent: null, url: widgetUrl }
        const widgetContents = {
          getURL: (): string => widgetUrl,
          isDestroyed: (): boolean => false,
          mainFrame: widgetFrame,
        }
        registerIpc(harness.ipc, {
          settings: harness.settings,
          history: harness.history,
          startup: harness.startup,
          hotkeys: harness.hotkeys,
          app: harness.app,
          trustedSenders: () => [
            {
              role: 'main' as const,
              webContents: harness.trustedContents,
              url: harness.trustedUrl,
            },
            { role: 'widget' as const, webContents: widgetContents, url: widgetUrl },
          ],
        })

        await expect(
          harness.ipc.invokeArgs(channel, [], {
            sender: widgetContents,
            senderFrame: widgetFrame,
          }),
        ).rejects.toMatchObject({ code: 'UNAUTHORIZED_IPC_SENDER' })
      },
    )

  it.each(['cancel', 'stop', 'toggle', 'retry', 'dismiss'] as const)(
      'allows a widget renderer to request the least-privilege %s command',
      async (type) => {
        const harness = createIpcHarness()
        harness.cleanup()
        const widgetUrl = 'file:///C:/Sotto/out/renderer/widget.html'
        const widgetFrame = { parent: null, url: widgetUrl }
        const widgetContents = {
          getURL: (): string => widgetUrl,
          isDestroyed: (): boolean => false,
          mainFrame: widgetFrame,
        }
        const request = vi.fn()
        registerIpc(harness.ipc, {
          settings: harness.settings,
          history: harness.history,
          startup: harness.startup,
          hotkeys: harness.hotkeys,
          app: harness.app,
          trustedSenders: () => [
            { role: 'widget', webContents: widgetContents, url: widgetUrl },
          ],
          dictation: { request, publishWidgetState: vi.fn() },
        })

        await expect(
          harness.ipc.invoke(
            DICTATION_REQUEST,
            { type },
            { sender: widgetContents, senderFrame: widgetFrame },
          ),
        ).resolves.toEqual({ ok: true })
        expect(request).toHaveBeenCalledWith({ type })
      },
    )

  it.each(['start'] as const)(
      'denies a widget renderer the privileged %s command',
      async (type) => {
        const harness = createIpcHarness()
        harness.cleanup()
        const widgetUrl = 'file:///C:/Sotto/out/renderer/widget.html'
        const widgetFrame = { parent: null, url: widgetUrl }
        const widgetContents = {
          getURL: (): string => widgetUrl,
          isDestroyed: (): boolean => false,
          mainFrame: widgetFrame,
        }
        const request = vi.fn()
        registerIpc(harness.ipc, {
          settings: harness.settings,
          history: harness.history,
          startup: harness.startup,
          hotkeys: harness.hotkeys,
          app: harness.app,
          trustedSenders: () => [
            { role: 'widget', webContents: widgetContents, url: widgetUrl },
          ],
          dictation: { request, publishWidgetState: vi.fn() },
        })

        await expect(
          harness.ipc.invoke(
            DICTATION_REQUEST,
            { type },
            { sender: widgetContents, senderFrame: widgetFrame },
          ),
        ).rejects.toMatchObject({ code: 'UNAUTHORIZED_IPC_SENDER' })
        expect(request).not.toHaveBeenCalled()
      },
    )

  it.each([
      [
        'unknown WebContents',
        (harness: ReturnType<typeof createIpcHarness>) => {
          const frame = { parent: null, url: harness.trustedUrl }
          return {
            sender: {
              getURL: (): string => harness.trustedUrl,
              isDestroyed: (): boolean => false,
              mainFrame: frame,
            },
            senderFrame: frame,
          }
        },
      ],
      [
        'destroyed WebContents',
        (harness: ReturnType<typeof createIpcHarness>) => ({
          sender: { ...harness.trustedContents, isDestroyed: (): boolean => true },
          senderFrame: harness.trustedFrame,
        }),
      ],
      [
        'throwing WebContents state check',
        (harness: ReturnType<typeof createIpcHarness>) => ({
          sender: {
            ...harness.trustedContents,
            isDestroyed: (): boolean => {
              throw new Error('secret renderer teardown detail')
            },
          },
          senderFrame: harness.trustedFrame,
        }),
      ],
      [
        'subframe',
        (harness: ReturnType<typeof createIpcHarness>) => ({
          sender: harness.trustedContents,
          senderFrame: { parent: {}, url: harness.trustedUrl },
        }),
      ],
      [
        'navigated top frame',
        (harness: ReturnType<typeof createIpcHarness>) => ({
          sender: harness.trustedContents,
          senderFrame: { parent: null, url: 'https://attacker.invalid/' },
        }),
      ],
      [
        'forged top-frame object',
        (harness: ReturnType<typeof createIpcHarness>) => ({
          sender: harness.trustedContents,
          senderFrame: { parent: null, url: harness.trustedUrl },
        }),
      ],
    ] as const)('rejects every handler call from an unauthorized %s', async (_name, eventFactory) => {
      const harness = createIpcHarness()

      await expect(
        harness.ipc.invokeArgs(
          SETTINGS_UPDATE,
          [{ theme: 'dark' }],
          eventFactory(harness),
        ),
      ).rejects.toThrow('Unauthorized IPC sender')
      expect(harness.settings.update).not.toHaveBeenCalled()
    })
})
