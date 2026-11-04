// @vitest-environment node
// ADR-0188: the window reads every computer's to-do list, and a press goes to the computer that holds the item.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerToDoIpc, type RemoteToDos } from '../../../src/main/agents/toDoIpc'
import { ToDoStore } from '../../../src/main/agents/toDos'
import { hostEntityKey } from '../../../src/shared/clientIdentity'
import { TO_DOS_CHANGED, TO_DOS_READ, TO_DOS_REQUEST, type MachineToDos, type ToDosView } from '../../../src/shared/toDos'
import { ipcRegistry } from '../../fixtures/ipcHarness'

const LOCAL = '11111111-1111-4111-8111-111111111111'
const FORGE = '22222222-2222-4222-8222-222222222222'
const folders: string[] = []
afterEach(async () => { await Promise.all(folders.splice(0).map(folder => rm(folder, { recursive: true, force: true }))) })
const localStore = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sotto-to-do-ipc-'))
  folders.push(directory)
  return new ToDoStore({ directory, historyEnabled: () => false, told: async () => undefined })
}
function remote(machines: MachineToDos[]): RemoteToDos & { change(): void; requests: unknown[] } {
  const listeners = new Set<() => void>(), requests: unknown[] = []
  return { requests, hostToDos: () => machines, subscribeToDos: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
    toDoRequest: async (hostId, request) => { requests.push({ hostId, request }) }, change: () => { for (const listener of listeners) listener() } }
}

describe('the window’s to-do list (ADR-0188)', () => {
  it('registers nothing and sends nothing where the feature is off, as in stable', async () => {
    const { ipc, handlers, main } = ipcRegistry()
    const send = vi.fn(), hosts = remote([])
    registerToDoIpc(ipc, false, await localStore(), () => [main], () => LOCAL, send, hosts)()
    hosts.change()
    expect(handlers.size).toBe(0)
    expect(send).not.toHaveBeenCalled()
  })
  it('joins this computer’s list and each host’s, by the window’s keys for their threads', async () => {
    const { ipc, handlers, main, mainEvent } = ipcRegistry()
    const local = await localStore()
    await local.add({ title: 'Here' }, 'thread', 't1')
    const forge: MachineToDos = { hostId: FORGE, thisComputer: false, items: [{ id: 'f1', title: 'There', by: 'thread', threadId: hostEntityKey(FORGE, 't2'), waits: false, seen: false, addedAt: '2026-11-03T00:00:00.000Z' }] }
    registerToDoIpc(ipc, true, local, () => [main], () => LOCAL, vi.fn(), remote([forge]))
    const view = await handlers.get(TO_DOS_READ)!(mainEvent) as ToDosView
    expect(view.machines.map(machine => machine.hostId)).toEqual([LOCAL, FORGE])
    expect(view.machines[0]).toMatchObject({ thisComputer: true })
    expect(view.machines[0]!.items[0]!.threadId).toBe(hostEntityKey(LOCAL, 't1'))
    expect(view.machines[1]!.items[0]!.title).toBe('There')
  })
  it('sends a press to the computer that holds the item, and the whole view again when a list changes', async () => {
    const { ipc, handlers, main, mainEvent } = ipcRegistry()
    const local = await localStore(), hosts = remote([]), send = vi.fn()
    registerToDoIpc(ipc, true, local, () => [main], () => LOCAL, send, hosts)
    const press = handlers.get(TO_DOS_REQUEST)!
    await press(mainEvent, { hostId: LOCAL, request: { kind: 'add', title: 'Mine' } })
    expect(local.view()[0]).toMatchObject({ title: 'Mine', by: 'user' })
    await expect.poll(() => send.mock.calls.some(call => call[0] === TO_DOS_CHANGED)).toBe(true)
    await press(mainEvent, { hostId: FORGE, request: { kind: 'seen' } })
    expect(hosts.requests).toEqual([{ hostId: FORGE, request: { kind: 'seen' } }])
    send.mockClear()
    hosts.change()
    expect(send).toHaveBeenCalledWith(TO_DOS_CHANGED, expect.objectContaining({ machines: expect.any(Array) }))
  })
  it('refuses a window it does not trust', async () => {
    const { ipc, handlers, main, widgetEvent } = ipcRegistry()
    registerToDoIpc(ipc, true, await localStore(), () => [main], () => LOCAL, vi.fn())
    expect(() => handlers.get(TO_DOS_READ)!(widgetEvent)).toThrow()
  })
})
