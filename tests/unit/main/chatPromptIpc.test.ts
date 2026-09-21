// @vitest-environment node
import { expect, it } from 'vitest'
import { registerChatPromptIpc } from '../../../src/main/agents/chatPromptIpc'
import { CHAT_PROMPT_GENERATE, CHAT_PROMPT_COPY } from '../../../src/shared/chatPrompts'
import type { IpcInvocationEvent, IpcMainAdapter, TrustedIpcSender } from '../../../src/main/ipc/registerIpc'

it('limits prompt generation and edited clipboard text to the trusted main frame with bounded inputs', async () => {
  const handlers = new Map<string, (event: IpcInvocationEvent, ...args: unknown[]) => unknown>()
  const ipc: IpcMainAdapter = { handle: (channel, handler) => { handlers.set(channel, handler) }, removeHandler: channel => { handlers.delete(channel) } }
  const sender = (role: 'main' | 'widget'): TrustedIpcSender => { const url = `file:///${role}.html`, mainFrame = { parent: null, url }; return { role, url, webContents: { mainFrame, getURL: () => url, isDestroyed: () => false } } }
  const main = sender('main'), widget = sender('widget'), event = { sender: main.webContents, senderFrame: main.webContents.mainFrame }
  let copied = '', generated = ''
  const dispose = registerChatPromptIpc(ipc, { generate: async ({ chatId }) => { generated = chatId; return { chatId, text: 'Reviewed prompt', sourceMessageIds: ['u1'], generatedAt: '2026-09-13T12:00:00Z' } } }, () => [main, widget], text => { copied = text })
  for (const channel of [CHAT_PROMPT_GENERATE, CHAT_PROMPT_COPY]) {
    expect(() => handlers.get(channel)!({ sender: widget.webContents, senderFrame: widget.webContents.mainFrame }, 'text')).toThrow('CHAT_PROMPT_MAIN_WINDOW_REQUIRED')
    expect(() => handlers.get(channel)!({ ...event, senderFrame: { parent: {}, url: main.url } }, 'text')).toThrow('CHAT_PROMPT_MAIN_WINDOW_REQUIRED')
  }
  expect(() => handlers.get(CHAT_PROMPT_COPY)!(event, 'x'.repeat(64001))).toThrow()
  expect(() => handlers.get(CHAT_PROMPT_GENERATE)!(event, { chatId: 'chat', projectId: 'extra-authority' })).toThrow()
  expect(copied).toBe(''); expect(generated).toBe('')
  await handlers.get(CHAT_PROMPT_GENERATE)!(event, { chatId: 'chat' })
  handlers.get(CHAT_PROMPT_COPY)!(event, 'My edited prompt')
  expect(generated).toBe('chat'); expect(copied).toBe('My edited prompt')
  dispose(); expect(handlers.size).toBe(0)
})
