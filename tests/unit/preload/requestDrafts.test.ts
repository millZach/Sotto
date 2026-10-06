// @vitest-environment node
import { expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ contextBridge: { exposeInMainWorld: vi.fn() }, ipcRenderer: { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() } }))
import { createSottoBridge, createSottoWidgetBridge } from '../../../src/preload'
import { REQUEST_DRAFT_GET, REQUEST_DRAFT_SAVE, REQUEST_DRAFT_LIST, REQUEST_DRAFT_DISCARD, REQUEST_DRAFT_CHANGED, requestDraftSchema, type RequestDraftTarget } from '../../../src/shared/requestDrafts'

it('validates identity-only draft change events and removes their listener on unsubscribe', () => {
  const ipc = { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() }
  const bridge = createSottoBridge(ipc, 'win32').requestDrafts!
  const changed = vi.fn()
  const off = bridge.onChanged!(changed)
  expect(ipc.on).toHaveBeenCalledWith(REQUEST_DRAFT_CHANGED, expect.any(Function))
  const listener = ipc.on.mock.calls.find(([channel]) => channel === REQUEST_DRAFT_CHANGED)![1] as (event: unknown, value: unknown) => void
  const owner = { kind: 'thread', ownerId: 'thread', providerId: 'codex' }
  for (const invalid of [null, {}, { ...owner, kind: 'unknown' }, { ...owner, providerId: 'unknown' },
    { ...owner, answer: 'Synthetic private answer' }, { ...owner, questions: [] }]) listener({}, invalid)
  expect(changed).not.toHaveBeenCalled()
  listener({}, owner)
  expect(changed).toHaveBeenCalledExactlyOnceWith(owner)
  off()
  expect(ipc.removeListener).toHaveBeenCalledExactlyOnceWith(REQUEST_DRAFT_CHANGED, listener)
})

it('exposes validated request draft persistence only to the main renderer', async () => {
  const ipc = { invoke: vi.fn().mockResolvedValue(null), on: vi.fn(), removeListener: vi.fn() }
  const bridge = createSottoBridge(ipc, 'win32').requestDrafts!
  expect(Object.isFrozen(bridge)).toBe(true)
  expect(createSottoWidgetBridge(ipc, 'win32')).not.toHaveProperty('requestDrafts')
  const target: RequestDraftTarget = { kind: 'thread', ownerId: 'thread', providerId: 'grok', requestId: 'request', questions: [
    { id: 'q', question: 'Notes', options: [], multiSelect: false, allowFreeText: true },
  ] }
  expect(await bridge.get(target)).toBeNull()
  expect(ipc.invoke).toHaveBeenLastCalledWith(REQUEST_DRAFT_GET, target)
  const draft = requestDraftSchema.parse({ target, revision: 1, held: false, selections: { q: { optionIds: [], other: false, text: 'Saved locally' } } })
  ipc.invoke.mockResolvedValue(draft)
  expect(await bridge.save(draft)).toEqual(draft)
  expect(ipc.invoke).toHaveBeenLastCalledWith(REQUEST_DRAFT_SAVE, draft)
  const owner = { kind: target.kind, ownerId: target.ownerId, providerId: target.providerId }
  ipc.invoke.mockResolvedValue([draft])
  expect(await bridge.list(owner)).toEqual([draft])
  expect(ipc.invoke).toHaveBeenLastCalledWith(REQUEST_DRAFT_LIST, owner)
  ipc.invoke.mockResolvedValue(true)
  expect(await bridge.discard({ target, revision: 1 })).toBe(true)
  expect(ipc.invoke).toHaveBeenLastCalledWith(REQUEST_DRAFT_DISCARD, { target, revision: 1 })
  ipc.invoke.mockResolvedValue('true')
  await expect(bridge.discard({ target, revision: 1 })).rejects.toThrow()
  ipc.invoke.mockResolvedValue([{}])
  await expect(bridge.list(owner)).rejects.toThrow()
  expect(() => bridge.save({ ...draft, revision: -1 })).toThrow()
  ipc.invoke.mockResolvedValue({ ...draft, selections: { wrong: { optionIds: [], other: false, text: 'Foreign' } } })
  await expect(bridge.get(target)).rejects.toThrow()
})
