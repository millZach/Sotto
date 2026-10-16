// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { registerDelegationIpc, type DelegationViews } from '../../../src/main/agents/delegationIpc'
import { hostEntityKey } from '../../../src/shared/clientIdentity'
import { DELEGATIONS_CHANGED, DELEGATIONS_READ, type DelegatedView, type DelegationView, type RefusedView } from '../../../src/shared/delegation'
import { ipcRegistry } from '../../fixtures/ipcHarness'

const LOCAL = '11111111-1111-4111-8111-111111111111'
const REMOTE = '22222222-2222-4222-8222-222222222222'
const view = (thread: string): DelegatedView => ({ id: randomUUID(), thread, action: 'start', work: 'code-review', rootUserMessageId: 'root', anchorMessageId: 'root',
  briefMessageId: randomUUID(), outcome: 'working', told: true, createdAt: '2026-10-15T12:00:00.000Z', wait: { seconds: 300, startedAt: '2026-10-15T12:00:01.000Z' }, waiting: true })

const refused = (thread?: string): RefusedView => ({ id: randomUUID(), ...(thread ? { thread } : { provider: 'codex' as const }), action: thread ? 'send' : 'start', work: 'code-review',
  outcome: 'refused', refusal: thread ? 'PAUSED' : 'PERMISSION_TOO_WIDE', rootUserMessageId: 'root', anchorMessageId: 'root', createdAt: '2026-10-15T12:00:02.000Z' })

function service(views: Record<string, { made: DelegationView[]; received: DelegatedView[] }> = {}) {
  let listener: ((threadIds: readonly string[]) => void) | undefined
  const delegation: DelegationViews & { readonly asked: string[] } = {
    asked: [],
    views: threadId => { delegation.asked.push(threadId); return views[threadId] ?? { made: [], received: [] } },
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
    const { delegation } = service({ parent: { made: [view('child')], received: [] }, child: { made: [], received: [view('child')] } })
    let close = registerDelegationIpc(ipc, delegation, () => [main], () => LOCAL, vi.fn())
    const read = handlers.get(DELEGATIONS_READ)!
    // The window keys this computer's threads by host; the record knows them by their own IDs.
    expect(await read(mainEvent, { threadId: hostEntityKey(LOCAL, 'parent') })).toMatchObject({ threadId: hostEntityKey(LOCAL, 'parent'),
      delegations: [{ thread: hostEntityKey(LOCAL, 'child'), outcome: 'working', waiting: true }], received: [] })
    // The delegated thread reads the briefs it was sent, by its own ID.
    expect(await read(mainEvent, { threadId: hostEntityKey(LOCAL, 'child') })).toMatchObject({ delegations: [], received: [{ thread: hostEntityKey(LOCAL, 'child') }] })
    expect(delegation.asked).toEqual(['parent', 'child'])
    close()
    // A refused start names no thread, since nothing was started; a refused send names the thread it would have gone to.
    const again = service({ parent: { made: [view('child'), refused(), refused('child')], received: [] } })
    close = registerDelegationIpc(ipc, again.delegation, () => [main], () => LOCAL, vi.fn())
    const read2 = handlers.get(DELEGATIONS_READ)!
    const answer = await read2(mainEvent, { threadId: hostEntityKey(LOCAL, 'parent') }) as { delegations: DelegationView[] }
    expect(answer.delegations.map(item => [item.outcome, item.thread])).toEqual([['working', hostEntityKey(LOCAL, 'child')], ['refused', undefined], ['refused', hostEntityKey(LOCAL, 'child')]])
    expect(answer.delegations[1]).toMatchObject({ provider: 'codex', refusal: 'PERMISSION_TOO_WIDE' })
    expect(answer.delegations[1]).not.toHaveProperty('thread')
    // A thread on a paired host has no delegations: it is not read for.
    expect(await read2(mainEvent, { threadId: hostEntityKey(REMOTE, 'parent') })).toEqual({ threadId: hostEntityKey(REMOTE, 'parent'), delegations: [], received: [] })
    expect(again.delegation.asked).toEqual(['parent'])
    expect(() => read2(widgetEvent, { threadId: 'parent' })).toThrow('main Sotto window')
    expect(() => read2(mainEvent, { threadId: 'parent', brief: 'words' })).toThrow()
    expect(() => read2(mainEvent, { threadId: 'parent' }, 'extra')).toThrow()
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
