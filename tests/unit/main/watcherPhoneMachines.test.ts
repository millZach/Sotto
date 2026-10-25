// @vitest-environment node
import { expect, it, vi } from 'vitest'
import { WatcherPhoneService } from '../../../src/main/agents/watcherPhone'
import type { AgentControl } from '../../../src/main/agents/control'
import type { WatcherService } from '../../../src/main/agents/watcher'
import type { AgentThread } from '../../../src/shared/agents'

const HOST = '11111111-1111-4111-8111-111111111111'
const FORGE = '0b7f4c1e-2a9d-4f61-8c3e-5d2b9a7e4f10'

function threads(count: number, prefix: string): AgentThread[] {
  return Array.from({ length: count }, (_, index) => ({ id: `${prefix}-${index}`, projectId: 'project', title: `${prefix} ${index}`, modelId: 'codex:gpt',
    status: 'running', messages: [], requests: [] }) as unknown as AgentThread)
}

/**
 * An iPhone's machines line (#1032) is projected on every phone shell, so its work must not grow with Watcher's history:
 * it never rebuilds the room, and asks who started a thread only for the few threads each panel names.
 */
it('says who started the threads a phone’s panel names without reading Watcher’s history or rebuilding its room', () => {
  const local = threads(20, 'local'), remote = threads(9, 'forge')
  const startedByWatcher = vi.fn((hostId: string, threadId: string) => hostId === HOST && threadId === 'local-1' || hostId === FORGE && threadId === 'forge-0')
  const state = vi.fn(() => { throw new Error('The room was rebuilt') })
  const watcher = {
    state, startedByWatcher, lastMachines: () => null,
    pairedMachines: () => [{ hostId: FORGE, name: 'forge', connected: true }],
    machineThreads: (hostId: string) => hostId === HOST ? local : hostId === FORGE ? remote : [],
  } as unknown as WatcherService
  const service = new WatcherPhoneService({ hostId: () => HOST } as unknown as AgentControl, watcher, true)
  const machines = service.machines()
  expect(machines.rows.map(row => [row.name, row.working, row.threads.length])).toEqual([['This computer', 20, 6], ['forge', 9, 6]])
  expect(machines.rows[0]!.threads.slice(0, 2)).toEqual([{ title: 'local 0', who: 'your thread' }, { title: 'local 1', who: 'Watcher' }])
  expect(machines.rows[1]!.threads[0]).toEqual({ title: 'forge 0', who: 'Watcher' })
  expect(state).not.toHaveBeenCalled()
  // Once per thread named, six on each machine, however many requests and participants Watcher's record holds.
  expect(startedByWatcher).toHaveBeenCalledTimes(12)
})
