// @vitest-environment node
import { expect, it, vi } from 'vitest'
import { registerRequestDraftIpc } from '../../../src/main/agents/requestDraftIpc'
import { REQUEST_DRAFT_GET, REQUEST_DRAFT_STATUS, REQUEST_DRAFT_SAVE, REQUEST_DRAFT_CHECK, REQUEST_DRAFT_LIST, REQUEST_DRAFT_DISCARD, type RequestDraftTarget } from '../../../src/shared/requestDrafts'

import { ipcRegistry } from '../../fixtures/ipcHarness'

it('authorizes main-frame draft access only, validates identity/selections, and exposes no delivery command', async () => {
  const registry = ipcRegistry()
  const { ipc, handlers } = registry
  const { main, widget, mainEvent: event } = registry
  const service = { list: vi.fn(async () => []), discard: vi.fn(async () => false), get: vi.fn(), status: vi.fn(), save: vi.fn(), check: vi.fn() }
  const cleanup = registerRequestDraftIpc(ipc, service, () => [main, widget])
  for (const channel of [REQUEST_DRAFT_GET, REQUEST_DRAFT_STATUS, REQUEST_DRAFT_SAVE, REQUEST_DRAFT_CHECK, REQUEST_DRAFT_LIST, REQUEST_DRAFT_DISCARD]) {
    for (const bad of [{ sender: widget.webContents, senderFrame: widget.webContents.mainFrame }, { ...event, senderFrame: { parent: {}, url: main.url } },
      { ...event, senderFrame: { parent: null, url: main.url } }, { ...event, senderFrame: null }]) expect(() => handlers.get(channel)!(bad)).toThrow('MAIN_WINDOW_REQUIRED')
    expect(() => handlers.get(channel)!(event)).toThrow()
    expect(() => handlers.get(channel)!(event, {}, {})).toThrow()
  }
  const target: RequestDraftTarget = { kind: 'thread', ownerId: 'thread', providerId: 'codex', requestId: 'request', questions: [
    { id: 'q', question: 'Notes', options: [], multiSelect: false, allowFreeText: true },
  ] }
  expect(() => handlers.get(REQUEST_DRAFT_GET)!(event, { ...target, cwd: 'C:/' })).toThrow()
  expect(() => handlers.get(REQUEST_DRAFT_SAVE)!(event, { target, revision: 1, selections: {}, held: false, send: true })).toThrow()
  expect(service.save).not.toHaveBeenCalled()
  handlers.get(REQUEST_DRAFT_GET)!(event, target)
  expect(service.get).toHaveBeenCalledWith(target)
  for (const status of [{ status: 'accepted', decisionId: 'read-only-attempt', revision: 2 }, { status: 'unconfirmed', revision: 2 }]) {
    service.status.mockResolvedValue(status)
    expect(await handlers.get(REQUEST_DRAFT_STATUS)!(event, target)).toEqual(status)
    expect(service.status).toHaveBeenLastCalledWith(target)
  }
  expect(service.check).not.toHaveBeenCalled()
  for (const result of [{ status: 'accepted', decisionId: 'exact-attempt', revision: 1 }, { status: 'editable', draft: null }]) {
    service.check.mockResolvedValue(result)
    expect(await handlers.get(REQUEST_DRAFT_CHECK)!(event, target)).toEqual(result)
    expect(service.check).toHaveBeenLastCalledWith(target)
  }
  const owner = { kind: target.kind, ownerId: target.ownerId, providerId: target.providerId }
  handlers.get(REQUEST_DRAFT_LIST)!(event, owner)
  expect(service.list).toHaveBeenCalledWith(owner)
  handlers.get(REQUEST_DRAFT_DISCARD)!(event, { target, revision: 1 })
  expect(service.discard).toHaveBeenCalledWith({ target, revision: 1 })
  expect(() => handlers.get(REQUEST_DRAFT_LIST)!(event, {})).toThrow()
  expect(() => handlers.get(REQUEST_DRAFT_DISCARD)!(event, { target, revision: 0 })).toThrow()
  expect(() => handlers.get(REQUEST_DRAFT_DISCARD)!(event, { target, revision: 1, send: true })).toThrow()
  cleanup(); expect(handlers.size).toBe(0)
})
