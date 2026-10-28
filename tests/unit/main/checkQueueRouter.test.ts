// @vitest-environment node
// #1312, fourth part: a host's check queue, pushed after its hello, shows as soon as the router takes the connection.
import { describe, expect, it, vi } from 'vitest'
import { DesktopHostRouter, type DesktopHostConnection } from '../../../src/main/hosts/desktopHostRouter'
import { emptyDesktopState } from '../../../src/main/hosts/inactiveLocalHost'
import { SocketHostService } from '../../../src/main/agents/socketHostService'
import type { CheckQueueEntry } from '../../../src/shared/checkQueue'
import { hostEntityKey } from '../../../src/shared/clientIdentity'

const REMOTE = '22222222-2222-4222-8222-222222222222'

/** A connection to forge whose hello already brought its queue, as the socket has it before the router takes it. */
function connection(checks: CheckQueueEntry[]): DesktopHostConnection {
  const state = emptyDesktopState(REMOTE)
  state.host.connected = true; state.connection = 'connected'
  const service = new SocketHostService({ url: 'http://127.0.0.1:4319', token: 'paired-token', catchUpEvents: false, crossMachineEnabled: true })
  Object.assign(service, { cached: state, features: ['check-queue-views'], checks })
  return { hostId: REMOTE, name: 'forge', kind: 'remote', service, detail: async () => null, preview: () => null }
}

describe('a host’s check queue in the router (#1312)', () => {
  it('announces the queue a connection already holds as the router takes it, new or in place of one it had', () => {
    const router = new DesktopHostRouter(emptyDesktopState)
    const heard = vi.fn()
    router.subscribeCheckQueues(heard)
    router.add(connection([{ id: 'one', whose: 'thread', thread: 'child', by: 'parent' }]))
    expect(heard).toHaveBeenCalledTimes(1)
    expect(router.hostCheckQueues()).toEqual([{ hostId: REMOTE, thisComputer: false,
      checks: [{ id: 'one', whose: 'thread', thread: hostEntityKey(REMOTE, 'child'), by: hostEntityKey(REMOTE, 'parent') }] }])
    // A reconnect: the new connection's hello brought the queue as it stands now.
    router.replace(connection([{ id: 'two', whose: 'watcher' }]))
    expect(heard).toHaveBeenCalledTimes(2)
    expect(router.hostCheckQueues()).toEqual([{ hostId: REMOTE, thisComputer: false, checks: [{ id: 'two', whose: 'watcher' }] }])
  })
})
