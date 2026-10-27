// @vitest-environment node
// #1312, fourth part: the window reads every machine's check queue, and main sends it again only when one changes.
import { describe, expect, it, vi } from 'vitest'
import { CheckQueue } from '../../../src/main/agents/checkQueue'
import { registerCheckQueueIpc, type RemoteCheckQueues } from '../../../src/main/agents/checkQueueIpc'
import { CHECK_QUEUES_CHANGED, CHECK_QUEUES_READ, type MachineChecks } from '../../../src/shared/checkQueue'
import { hostEntityKey } from '../../../src/shared/clientIdentity'
import { ipcRegistry } from '../../fixtures/ipcHarness'

const LOCAL = '11111111-1111-4111-8111-111111111111'
const FORGE = '22222222-2222-4222-8222-222222222222'
const settle = () => new Promise<void>(resolve => queueMicrotask(resolve))

function remote(machines: MachineChecks[]): RemoteCheckQueues & { change(): void } {
  const listeners = new Set<() => void>()
  return { hostCheckQueues: () => machines, subscribeCheckQueues: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
    change: () => { for (const listener of listeners) listener() } }
}

describe('the window’s read of every machine’s check queue (#1312)', () => {
  it('registers nothing and sends nothing where this computer keeps no queue, as stable keeps none', () => {
    const { ipc, handlers, main } = ipcRegistry()
    const send = vi.fn()
    const hosts = remote([])
    registerCheckQueueIpc(ipc, undefined, () => [main], () => LOCAL, send, hosts)()
    hosts.change()
    expect(handlers.size).toBe(0)
    expect(send).not.toHaveBeenCalled()
  })

  it('answers the main window with this computer’s queue first, its threads named as the window names them, then each host’s', async () => {
    const { ipc, handlers, main, mainEvent, widgetEvent } = ipcRegistry()
    const queue = new CheckQueue('This computer')
    queue.join('one', vi.fn(), { whose: 'watcher', title: 'Capture check', thread: 'capture' })
    queue.join('two', vi.fn(), { whose: 'thread', by: 'parent', thread: 'child', work: 'building' })
    const forge: MachineChecks = { hostId: FORGE, thisComputer: false, checks: [{ id: 'three', whose: 'thread', thread: hostEntityKey(FORGE, 'journeys') }] }
    const close = registerCheckQueueIpc(ipc, queue, () => [main], () => LOCAL, vi.fn(), remote([forge]))
    const read = handlers.get(CHECK_QUEUES_READ)!
    expect(await read(mainEvent)).toEqual({ machines: [
      { hostId: LOCAL, thisComputer: true, checks: [{ id: 'one', whose: 'watcher', title: 'Capture check', thread: hostEntityKey(LOCAL, 'capture') },
        { id: 'two', whose: 'thread', by: hostEntityKey(LOCAL, 'parent'), thread: hostEntityKey(LOCAL, 'child'), work: 'building' }] },
      forge] })
    expect(() => read(widgetEvent)).toThrow('main Sotto window')
    close()
    expect(handlers.size).toBe(0)
  })

  it('sends the whole view once for each change of a queue, and nothing once closed', async () => {
    const { ipc, main } = ipcRegistry()
    const send = vi.fn()
    const queue = new CheckQueue('This computer')
    const hosts = remote([])
    const close = registerCheckQueueIpc(ipc, queue, () => [main], () => LOCAL, send, hosts)
    queue.join('one', vi.fn(), { whose: 'watcher' }); queue.join('two', vi.fn(), { whose: 'thread' })
    await settle()
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenLastCalledWith(CHECK_QUEUES_CHANGED, { machines: [{ hostId: LOCAL, thisComputer: true, checks: [{ id: 'one', whose: 'watcher' }, { id: 'two', whose: 'thread' }] }] })
    hosts.change()
    expect(send).toHaveBeenCalledTimes(2)
    close()
    queue.leave('one'); hosts.change()
    await settle()
    expect(send).toHaveBeenCalledTimes(2)
  })
})
