import { expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ contextBridge: { exposeInMainWorld: vi.fn() }, ipcRenderer: { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() } }))
import { createSottoBridge, createSottoWidgetBridge } from '../../../src/preload'
import { PERSONAL_CHAT_COMMAND, PERSONAL_CHAT_STATE, type PersonalChatState } from '../../../src/shared/personalChats'
const state: PersonalChatState = { selectedChatId: null, chats: [], connected: false, connecting: false, availability: { provider: 'claude', supported: false } }
it('exposes personal chat only in the main window and validates payloads and subscribed snapshots', async () => {
  const ipc = { invoke: vi.fn().mockResolvedValue(state), on: vi.fn(), removeListener: vi.fn() }
  const bridge = createSottoBridge(ipc, 'win32').personalChats!
  expect(Object.isFrozen(bridge)).toBe(true)
  expect(createSottoWidgetBridge(ipc, 'win32')).not.toHaveProperty('personalChats')
  expect(await bridge.create()).toEqual(state)
  expect(ipc.invoke).toHaveBeenLastCalledWith(PERSONAL_CHAT_COMMAND, { type: 'create' })
  await bridge.saveDraft({ chatId: 'chat', revision: 3, text: 'Hello', skills: [] })
  expect(ipc.invoke).toHaveBeenLastCalledWith(PERSONAL_CHAT_COMMAND, { type: 'draft', chatId: 'chat', revision: 3, text: 'Hello', skills: [] })
  expect(() => bridge.send({ chatId: 'chat', revision: -1 })).toThrow()
  const listener = vi.fn(), unsubscribe = bridge.onState(listener)
  const subscription = ipc.on.mock.calls.find(call => call[0] === PERSONAL_CHAT_STATE)!
  subscription[1]({}, state)
  expect(listener).toHaveBeenCalledWith(state)
  unsubscribe(); expect(ipc.removeListener).toHaveBeenCalledWith(PERSONAL_CHAT_STATE, subscription[1])
  ipc.invoke.mockResolvedValueOnce({ ...state, chats: [{ projectId: 'fake-project' }] })
  await expect(bridge.get()).rejects.toThrow()
})
