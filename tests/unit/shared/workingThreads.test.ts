// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { AgentThread } from '../../../src/shared/agents'
import { countMachineWorkingThreads, countWorkingThreads, machineWorkingThreadsWarning, THIS_COMPUTER, WORKING_THREADS_QUIET_MAX, workingThreadsByMachine,
  workingThreadsLead, workingThreadsWarning } from '../../../src/shared/workingThreads'

const thread = (id: string, patch: Partial<AgentThread> = {}): AgentThread =>
  ({ id, projectId: 'project', providerId: 'codex', title: id, modelId: 'model', status: 'idle', messages: [], requests: [], ...patch })

describe('working threads (#1183)', () => {
  it('counts this computer’s threads with a turn running, whoever started them', () => {
    expect(countWorkingThreads([thread('user', { status: 'running' }), thread('worker', { status: 'running' }),
      thread('delegated', { status: 'running', delegatedBy: 'user' }), thread('idle')])).toBe(3)
  })
  it('counts a last turn still reported running, as isThreadTurnRunning has it', () => {
    expect(countWorkingThreads([thread('ending', { status: 'idle', lastTurn: { id: 'turn', status: 'running' } })])).toBe(1)
    expect(countWorkingThreads([thread('ended', { status: 'idle', lastTurn: { id: 'turn', status: 'completed' } })])).toBe(0)
  })
  it('does not count Watcher’s own thread, an older Watcher’s or a thread on another computer', () => {
    expect(countWorkingThreads([thread('watcher', { status: 'running', kind: 'watcher' }), thread('earlier', { status: 'running', kind: 'watcher-history' }),
      thread('remote', { status: 'running', remoteHost: true, hostId: '22222222-2222-4222-8222-222222222222' })])).toBe(0)
  })
  it('counts a start whose first prompt is on its way before its status says so, once', () => {
    expect(countWorkingThreads([thread('new')], 'new')).toBe(1)
    expect(countWorkingThreads([thread('new', { status: 'running' })], 'new')).toBe(1)
    expect(countWorkingThreads([thread('other')], 'missing')).toBe(0)
  })
  it('warns above ten and says nothing at ten or fewer, in the same words on every computer', () => {
    expect(WORKING_THREADS_QUIET_MAX).toBe(10)
    expect(workingThreadsWarning(10)).toBeUndefined()
    expect(workingThreadsWarning(0)).toBeUndefined()
    expect(workingThreadsWarning(11)).toBe('11 threads are working. This computer may slow down or use its battery faster.')
    expect(workingThreadsLead(12)).toBe('12 threads are working.')
  })
})

describe('working threads per machine (#1032)', () => {
  const forge = '22222222-2222-4222-8222-222222222222', mac = '33333333-3333-4333-8333-333333333333'
  it('counts each machine’s working threads under its host ID and this computer’s under its own key, leaving idle machines out', () => {
    const counted = workingThreadsByMachine([thread('local', { status: 'running', hostId: '11111111-1111-4111-8111-111111111111', remoteHost: false }),
      thread('forge-1', { status: 'running', remoteHost: true, hostId: forge }), thread('forge-2', { status: 'idle', lastTurn: { id: 'turn', status: 'running' }, remoteHost: true, hostId: forge }),
      thread('forge-watcher', { status: 'running', kind: 'watcher', remoteHost: true, hostId: forge }), thread('mac-idle', { remoteHost: true, hostId: mac })])
    expect(Object.fromEntries(counted)).toEqual({ [THIS_COMPUTER]: 1, [forge]: 2 })
  })
  it('counts one machine’s own list whatever marks it, and a start that has not reached it yet once', () => {
    const own = [thread('a', { status: 'running', hostId: forge }), thread('b', { status: 'running', remoteHost: true, hostId: forge }), thread('c')]
    expect(countMachineWorkingThreads(own)).toBe(2)
    expect(countMachineWorkingThreads(own, new Set(['c']))).toBe(3)
    expect(countMachineWorkingThreads(own, new Set(['a']))).toBe(2)
    expect(countMachineWorkingThreads(own, new Set(['not-there-yet']))).toBe(3)
  })
  it('counts every accepted start the list does not hold yet once, and none twice', () => {
    const nine = Array.from({ length: 9 }, (_, index) => thread(`w${index}`, { status: 'running', remoteHost: true, hostId: forge }))
    const count = countMachineWorkingThreads(nine, new Set(['first', 'second']))
    expect(count).toBe(11)
    expect(machineWorkingThreadsWarning(count, 'forge')).toBe('11 threads are working on forge. Forge may slow down.')
    // One of them reached the list, already running: still eleven.
    expect(countMachineWorkingThreads([...nine, thread('first', { status: 'running', remoteHost: true, hostId: forge })], new Set(['first', 'second']))).toBe(11)
  })
  it('warns for another machine above ten in its own name, never of its battery', () => {
    expect(machineWorkingThreadsWarning(10, 'forge')).toBeUndefined()
    expect(machineWorkingThreadsWarning(11, 'forge')).toBe('11 threads are working on forge. Forge may slow down.')
    expect(machineWorkingThreadsWarning(12, ' ')).toBe('12 threads are working on that machine. That machine may slow down.')
  })
})
