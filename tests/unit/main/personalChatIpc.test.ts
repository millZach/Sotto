import { expect, it, vi } from 'vitest'
import { registerPersonalChatIpc } from '../../../src/main/agents/personalChatIpc'
import { PERSONAL_CHAT_GET, PERSONAL_CHAT_COMMAND, PERSONAL_CHAT_SKILLS } from '../../../src/shared/personalChats'
import type { IpcInvocationEvent, IpcMainAdapter, TrustedIpcSender } from '../../../src/main/ipc/registerIpc'
it('authorizes only the trusted main frame and rejects malformed or expanded authority before service dispatch', async () => {
  const handlers = new Map<string, (event: IpcInvocationEvent, ...args: unknown[]) => unknown>()
  const ipc: IpcMainAdapter = { handle: (channel, handler) => { handlers.set(channel, handler) }, removeHandler: channel => { handlers.delete(channel) } }
  const sender = (role: 'main' | 'widget'): TrustedIpcSender => { const url = `file:///${role}.html`, mainFrame = { parent: null, url }; return { role, url, webContents: { mainFrame, getURL: () => url, isDestroyed: () => false } } }
  const main = sender('main'), widget = sender('widget'), event = { sender: main.webContents, senderFrame: main.webContents.mainFrame }
  const service = { get: vi.fn(), command: vi.fn(), skills: vi.fn() }
  const dispose = registerPersonalChatIpc(ipc, service, () => [main, widget])
  for (const channel of [PERSONAL_CHAT_GET, PERSONAL_CHAT_COMMAND, PERSONAL_CHAT_SKILLS]) for (const bad of [
    { sender: widget.webContents, senderFrame: widget.webContents.mainFrame }, { ...event, senderFrame: { parent: {}, url: main.url } },
    { ...event, senderFrame: { parent: null, url: main.url } }, { ...event, senderFrame: null },
  ]) expect(() => handlers.get(channel)!(bad)).toThrow('PERSONAL_CHAT_MAIN_WINDOW_REQUIRED')
  expect(() => handlers.get(PERSONAL_CHAT_COMMAND)!(event, { type: 'create', projectId: 'invented' })).toThrow()
  expect(() => handlers.get(PERSONAL_CHAT_COMMAND)!(event, { type: 'send', chatId: 'x', revision: 0, providerId: 'claude' })).toThrow()
  expect(() => handlers.get(PERSONAL_CHAT_SKILLS)!(event, { chatId: 'x', cwd: 'C:/' })).toThrow()
  expect(service.command).not.toHaveBeenCalled(); expect(service.skills).not.toHaveBeenCalled()
  handlers.get(PERSONAL_CHAT_COMMAND)!(event, { type: 'select', chatId: 'owned' })
  expect(service.command).toHaveBeenCalledWith({ type: 'select', chatId: 'owned' })
  dispose(); expect(handlers.size).toBe(0)
})
