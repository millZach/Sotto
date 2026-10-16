// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { registerDelegationIpc, type DelegationViews } from '../../../src/main/agents/delegationIpc'
import { hostEntityKey } from '../../../src/shared/clientIdentity'
import { DELEGATIONS_CHANGED, DELEGATIONS_READ, type DelegationView } from '../../../src/shared/delegation'
import { ipcRegistry } from '../../fixtures/ipcHarness'

const LOCAL = '11111111-1111-4111-8111-111111111111'
const REMOTE = '22222222-2222-4222-8222-222222222222'
const view = (thread: string): DelegationView => ({ id: randomUUID(), thread, action: 'start', work: 'code-review', rootUserMessageId: 'root', outcome: 'working',
  createdAt: '2026-10-15T12:00:00.000Z', wait: { seconds: 300, startedAt: '2026-10-15T12:00:01.000Z' }, waiting: true })

function service(views: Record<string, DelegationView[]> = {}) {
  let listener: ((threadIds: readonly string[]) => void) | undefined
  const delegation: DelegationViews & { readonly asked: string[] } = {
    asked: [],
    views: threadId => { delegation.asked.push(threadId); return views[threadId] ?? [] },
    onViewsChanged: given => { listener = given; return () => { listener = undefined } },
  }
  return { delegation, change: (ids: readonly string[]) => listener?.(ids), listening: () => listener !== undefined }
}

describe('the window\'s read of a thread\'s delegations (#1029)', () => {
  it('registers nothing and listens to nothing where stable built no delegation', () => {
    const { ipc, handlers, main } = ipcRegistry()
    const send = vi.fn()
    registerDelegationIpc(ipc, undefined, () => [main], () => LOCAL, send)()
    expect(handlers.size).toBe(0)
    expect(send).not.toHaveBeenCalled()
  })

  it('answers the main window by this computer\'s threads, named as the window names them, and refuses anything else', async () => {
    const { ipc, handlers, main, mainEvent, widgetEvent } = ipcRegistry()
    const { delegation } = service({ parent: [view('child')] })
    const close = registerDelegationIpc(ipc, delegation, () => [main], () => LOCAL, vi.fn())
    const read = handlers.get(DELEGATIONS_READ)!
    // The window keys this computer's threads by host; the record knows them by their own IDs.
    expect(await read(mainEvent, { threadId: hostEntityKey(LOCAL, 'parent') })).toMatchObject({ threadId: hostEntityKey(LOCAL, 'parent'),
      delegations: [{ thread: hostEntityKey(LOCAL, 'child'), outcome: 'working', waiting: true }] })
    expect(delegation.asked).toEqual(['parent'])
    // A thread on a paired host has no delegations: it is not read for.
    expect(await read(mainEvent, { threadId: hostEntityKey(REMOTE, 'parent') })).toEqual({ threadId: hostEntityKey(REMOTE, 'parent'), delegations: [] })
    expect(delegation.asked).toEqual(['parent'])
    expect(() => read(widgetEvent, { threadId: 'parent' })).toThrow('main Sotto window')
    expect(() => read(mainEvent, { threadId: 'parent', brief: 'words' })).toThrow()
    expect(() => read(mainEvent, { threadId: 'parent' }, 'extra')).toThrow()
    close()
    expect(handlers.size).toBe(0)
  })

  it('tells the main window which delegating threads changed, by the window\'s IDs, until it closes', () => {
    const { ipc, main } = ipcRegistry()
    const { delegation, change, listening } = service()
    const send = vi.fn()
    const close = registerDelegationIpc(ipc, delegation, () => [main], () => LOCAL, send)
    change(['a', 'b'])
    expect(send).toHaveBeenCalledWith(DELEGATIONS_CHANGED, { threadIds: [hostEntityKey(LOCAL, 'a'), hostEntityKey(LOCAL, 'b')] })
    close()
    expect(listening()).toBe(false)
  })
})
