import { expect, it, vi } from 'vitest'
import { registerRequestDraftIpc } from '../../../src/main/agents/requestDraftIpc'
import { REQUEST_DRAFT_GET, REQUEST_DRAFT_SAVE, REQUEST_DRAFT_CHECK, type RequestDraftTarget } from '../../../src/shared/requestDrafts'
import type { IpcInvocationEvent, IpcMainAdapter, TrustedIpcSender } from '../../../src/main/ipc/registerIpc'

it('authorizes main-frame draft access only, validates identity/selections, and exposes no delivery command', () => {
  const handlers = new Map<string, (event: IpcInvocationEvent, ...args: unknown[]) => unknown>()
  const ipc: IpcMainAdapter = { handle: (channel, handler) => { handlers.set(channel, handler) }, removeHandler: channel => { handlers.delete(channel) } }
  const sender = (role: 'main' | 'widget'): TrustedIpcSender => { const url = `file:///${role}.html`, mainFrame = { parent: null, url }; return { role, url, webContents: { mainFrame, getURL: () => url, isDestroyed: () => false } } }
  const main = sender('main'), widget = sender('widget'), event = { sender: main.webContents, senderFrame: main.webContents.mainFrame }
  const service = { get: vi.fn(), save: vi.fn(), check: vi.fn() }
  const cleanup = registerRequestDraftIpc(ipc, service, () => [main, widget])
  for (const channel of [REQUEST_DRAFT_GET, REQUEST_DRAFT_SAVE, REQUEST_DRAFT_CHECK]) {
    for (const bad of [{ sender: widget.webContents, senderFrame: widget.webContents.mainFrame }, { ...event, senderFrame: { parent: {}, url: main.url } },
      { ...event, senderFrame: { parent: null, url: main.url } }, { ...event, senderFrame: null }]) expect(() => handlers.get(channel)!(bad)).toThrow('MAIN_WINDOW_REQUIRED')
    expect(() => handlers.get(channel)!(event)).toThrow()
    expect(() => handlers.get(channel)!(event, {}, {})).toThrow()
  }
  const target: RequestDraftTarget = { kind: 'personal', ownerId: 'chat', providerId: 'codex', requestId: 'request', questions: [
    { id: 'q', question: 'Notes', options: [], multiSelect: false, allowFreeText: true },
  ] }
  expect(() => handlers.get(REQUEST_DRAFT_GET)!(event, { ...target, cwd: 'C:/' })).toThrow()
  expect(() => handlers.get(REQUEST_DRAFT_SAVE)!(event, { target, revision: 1, selections: {}, held: false, send: true })).toThrow()
  expect(service.save).not.toHaveBeenCalled()
  handlers.get(REQUEST_DRAFT_GET)!(event, target)
  expect(service.get).toHaveBeenCalledWith(target)
  cleanup(); expect(handlers.size).toBe(0)
})
