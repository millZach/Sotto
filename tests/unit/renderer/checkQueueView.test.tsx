// #1312, fourth part (Zach's pick C): a machine's checks show on the machines line, in its panel and in Tools › Agents, and
// nowhere while Work across machines is off.
import React from 'react'
import { i18n } from '@lingui/core'
import { generateMessageId } from '@lingui/message-utils/generateMessageId'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentState, AgentThread } from '../../../src/shared/agents'
import type { CheckQueuesBridge, CheckQueuesView } from '../../../src/shared/checkQueue'
import type { WatcherMachine, WatcherMachinesRead } from '../../../src/shared/watcherRoom'
import { THIS_COMPUTER } from '../../../src/shared/workingThreads'
import { machineEntries } from '../../../src/shared/machineLine'
import { WatcherMachines } from '../../../src/renderer/src/watcher/WatcherMachines'
import { calmWords, lineText } from '../../../src/renderer/src/watcher/machineWords'
import { checkQueuesStore, unmadeChecks } from '../../../src/renderer/src/watcher/checkQueues'
import { WaitingCheckRow } from '../../../src/renderer/src/tools/WaitingChecks'
import { useWatcherRoom } from '../../../src/renderer/src/watcher/watcherRoom'
import { machinesStore } from '../../../src/renderer/src/watcher/useMachines'
import { useOptionalApp } from '../../../src/renderer/src/state/AppContext'

vi.mock('../../../src/renderer/src/watcher/watcherRoom', async importOriginal => ({ ...await importOriginal<typeof import('../../../src/renderer/src/watcher/watcherRoom')>(), useWatcherRoom: vi.fn() }))
vi.mock('../../../src/renderer/src/state/AppContext', async importOriginal => ({ ...await importOriginal<typeof import('../../../src/renderer/src/state/AppContext')>(), useOptionalApp: vi.fn() }))
afterEach(() => { cleanup(); vi.clearAllMocks(); machinesStore.clear(); checkQueuesStore.clear() })

const NOW = Date.parse('2026-10-27T14:20:00Z')
const LOCAL = '7d1c8a52-5f0a-4d55-9a38-1f9b7a2a0c11', FORGE = '0b7f4c1e-2a9d-4f61-8c3e-5d2b9a7e4f10'
const GIB = 1024 ** 3
const key = (hostId: string, id: string) => `host:${hostId}:${id}`
function machine(over: Partial<WatcherMachine> & Pick<WatcherMachine, 'hostId' | 'name'>): WatcherMachine {
  return { thisComputer: false, connected: true, factsState: 'reported', runningThreads: 0, placedNotStarted: 0, memoryState: 'enough', cpuState: 'not-busy',
    facts: { observedAt: new Date(NOW).toISOString(), os: { family: 'linux', name: 'Omarchy', version: null }, architecture: 'x64', totalMemoryBytes: 64 * GIB, freeMemoryBytes: null, logicalCpuCount: 24 },
    load: { observedAt: new Date(NOW - 6_000).toISOString(), windowMs: 2_000, cpuBusyPercent: 22, loadAverage: null, availableMemoryBytes: 41 * GIB, windowStartAvailableMemoryBytes: 41 * GIB, memoryPressurePercent: null }, ...over }
}
const local = () => machine({ hostId: LOCAL, name: 'This computer', thisComputer: true })
const forge = () => machine({ hostId: FORGE, name: 'forge' })
function thread(id: string, title: string, remote?: string, over: Partial<AgentThread> = {}): AgentThread {
  return { id, title, status: 'running', ...remote ? { remoteHost: true, hostId: remote } : {}, ...over } as AgentThread
}

/** forge runs Watcher's capture check; a thread's journeys and Watcher's unit suite wait behind it. */
const QUEUES: CheckQueuesView = { machines: [{ hostId: LOCAL, thisComputer: true, checks: [] }, { hostId: FORGE, thisComputer: false, checks: [
  { id: 'one', whose: 'watcher', thread: key(FORGE, 'capture'), title: 'Omarchy capture check' },
  { id: 'two', whose: 'thread', by: key(LOCAL, 'paste'), thread: key(FORGE, 'journeys'), title: 'Linux journeys for the paste fix', work: 'building', provider: 'grok' },
  { id: 'three', whose: 'watcher', title: 'Linux unit suite for the paste fix' },
] }] }
const THREADS = [thread(key(LOCAL, 'paste'), 'Fix the paste on Hyprland'), thread(key(FORGE, 'capture'), 'Omarchy capture check', FORGE),
  thread(key(FORGE, 'docs'), 'Tidy the host protocol docs', FORGE)]

function bridge(view: CheckQueuesView): CheckQueuesBridge & { push(next: CheckQueuesView): void; read: ReturnType<typeof vi.fn> } {
  const listeners = new Set<(next: CheckQueuesView) => void>()
  return { read: vi.fn(async () => view), onChanged: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
    push: next => { for (const listener of listeners) listener(next) } }
}
function show(crossMachine: boolean, checks: CheckQueuesBridge) {
  const readMachines = vi.fn(async (): Promise<WatcherMachinesRead> => ({ status: 'ok', machines: [local(), forge()], observedAt: new Date(NOW).toISOString() }))
  vi.mocked(useWatcherRoom).mockReturnValue({ readMachines, state: PLACED } as unknown as ReturnType<typeof useWatcherRoom>)
  vi.mocked(useOptionalApp).mockReturnValue({ actions: { navigate: vi.fn() }, update: { owlFeatures: { 'cross-machine-work': crossMachine } } } as unknown as ReturnType<typeof useOptionalApp>)
  Object.defineProperty(window, 'sotto', { configurable: true, value: { checks } })
  return render(<WatcherMachines state={{ host: { threads: THREADS, projects: [] } } as unknown as AgentState} now={NOW} />)
}
const wide = () => document.querySelector<HTMLElement>('.watcher-machines__wide')!
/** A start Watcher placed this run, which the line reads the machines for. */
const PLACED = { requests: [], receiptPlacements: [{ operationId: '5b3c9e1a-7d24-4f6b-8a90-2c1e4d7f6a35', placement: { hostId: FORGE, name: 'forge', awayFromDefault: false } }] }

describe('The machines line counts the checks waiting on a machine (#1312)', () => {
  it('says them after the working count, shorter on the narrow line, and in the count of every machine', () => {
    const entries = machineEntries([local(), forge()], new Map([[THIS_COMPUTER, 2], [FORGE, 3]]))
    expect(lineText(entries[1]!, true, 2)).toBe('forge 3 working, 2 checks waiting')
    expect(lineText(entries[1]!, true, 1)).toBe('forge 3 working, 1 check waiting')
    expect(lineText(entries[1]!, false, 2)).toBe('forge 3 working, 2 waiting')
    expect(calmWords(entries, 2)).toBe('2 machines, 5 working, 2 waiting')
    expect(calmWords(entries)).toBe('2 machines, 5 working')
  })

  it('reads the queues once, then follows main’s pushes, and lists forge’s checks in its panel with whose each is and where it stands', async () => {
    const checks = bridge(QUEUES)
    show(true, checks)
    await act(async () => undefined)
    expect(checks.read).toHaveBeenCalledTimes(1)
    expect(wide()).toHaveTextContent('forge 2 working, 2 checks waiting')
    await act(async () => { fireEvent.click(within(wide()).getByRole('button', { name: /^forge, 2 working, 2 checks waiting\./u })) })
    const panel = screen.getByRole('dialog', { name: 'forge' })
    const list = within(panel).getByRole('region', { name: 'Checks, one at a time' })
    expect([...list.querySelectorAll('li')].map(item => item.textContent)).toEqual([
      'Omarchy capture checkWatcher’s · running',
      '1Linux journeys for the paste fixDelegated by Fix the paste on Hyprland · 1 ahead',
      '2Linux unit suite for the paste fixWatcher’s · 2 ahead'])
    expect(panel).toHaveTextContent('forge runs one check at a time. The rest wait here in the order they were asked for, whoever asked.')
    // The running check is listed once, with the checks; what else works there follows.
    expect(within(panel).getByRole('heading', { name: 'Also working' })).toBeInTheDocument()
    expect(within(panel).getAllByText('Omarchy capture check')).toHaveLength(1)
    expect(within(panel).getByText('Tidy the host protocol docs')).toBeInTheDocument()
    // A change main sends moves the line and the panel without another read.
    await act(async () => { checks.push({ machines: [{ hostId: FORGE, thisComputer: false, checks: [QUEUES.machines[1]!.checks[1]!] }] }) })
    expect(checks.read).toHaveBeenCalledTimes(1)
    expect(wide()).toHaveTextContent('forge 2 working')
    expect(wide()).not.toHaveTextContent('waiting')
    expect(within(panel).getByText('Linux journeys for the paste fix').parentElement).toHaveTextContent('Delegated by Fix the paste on Hyprland · running')
  })

  it('says a running check installs its packages first while it does', async () => {
    const installing = [...THREADS, thread(key(FORGE, 'journeys'), 'Linux journeys for the paste fix', FORGE, { worktree: { check: { install: 'running' } } } as Partial<AgentThread>)]
    const checks = bridge({ machines: [{ hostId: FORGE, thisComputer: false, checks: [QUEUES.machines[1]!.checks[1]!] }] })
    vi.mocked(useWatcherRoom).mockReturnValue({ readMachines: async () => ({ status: 'ok', machines: [local(), forge()], observedAt: new Date(NOW).toISOString() }), state: PLACED } as unknown as ReturnType<typeof useWatcherRoom>)
    vi.mocked(useOptionalApp).mockReturnValue({ actions: { navigate: vi.fn() }, update: { owlFeatures: { 'cross-machine-work': true } } } as unknown as ReturnType<typeof useOptionalApp>)
    Object.defineProperty(window, 'sotto', { configurable: true, value: { checks } })
    render(<WatcherMachines state={{ host: { threads: installing, projects: [] } } as unknown as AgentState} now={NOW} />)
    await act(async () => undefined)
    await act(async () => { fireEvent.click(within(wide()).getByRole('button', { name: /^forge,/u })) })
    expect(screen.getByRole('dialog', { name: 'forge' })).toHaveTextContent('Delegated by Fix the paste on Hyprland · installing packages first, because package-lock.json changed')
  })

  it('shows and reads nothing of the queues while Work across machines is off', async () => {
    const checks = bridge(QUEUES)
    show(false, checks)
    await act(async () => undefined)
    expect(checks.read).not.toHaveBeenCalled()
    expect(wide()).not.toHaveTextContent('waiting')
    await act(async () => { fireEvent.click(within(wide()).getByRole('button', { name: /^forge, 2 working\./u })) })
    const panel = screen.getByRole('dialog', { name: 'forge' })
    expect(within(panel).queryByRole('region', { name: 'Checks, one at a time' })).toBeNull()
    expect(within(panel).queryByRole('heading', { name: 'Also working' })).toBeNull()
  })

  it('drops a first read that answers after main already sent a newer queue', async () => {
    let answer!: (view: CheckQueuesView) => void
    const listeners = new Set<(view: CheckQueuesView) => void>()
    const late: CheckQueuesBridge = { read: () => new Promise(resolve => { answer = resolve }), onChanged: listener => { listeners.add(listener); return () => { listeners.delete(listener) } } }
    const stop = checkQueuesStore.use(late)
    const newer: CheckQueuesView = { machines: [{ hostId: FORGE, thisComputer: false, checks: [] }] }
    for (const listener of listeners) listener(newer)
    answer(QUEUES)
    await act(async () => undefined)
    expect(checkQueuesStore.get()).toBe(newer)
    stop()
    expect(checkQueuesStore.get()).toBeNull()
    expect(listeners.size).toBe(0)
  })
})

describe('A delegated check waiting its turn in Tools › Agents (#1312)', () => {
  it('finds the checks a thread or its delegated threads asked for whose threads are not made yet', () => {
    const owners = new Set([key(LOCAL, 'paste')])
    expect(unmadeChecks(QUEUES, owners, () => false).map(item => [item.check.id, item.at])).toEqual([['two', 1]])
    expect(unmadeChecks(QUEUES, owners, id => id === key(FORGE, 'journeys'))).toEqual([])
    expect(unmadeChecks(null, owners, () => false)).toEqual([])
  })

  it('reads Working, opens to where it stands and its machine’s checks, and closes on Escape', async () => {
    vi.mocked(useOptionalApp).mockReturnValue({ update: { owlFeatures: { 'cross-machine-work': true } } } as unknown as ReturnType<typeof useOptionalApp>)
    const waiting = unmadeChecks(QUEUES, new Set([key(LOCAL, 'paste')]), () => false)[0]!
    render(<ul><WaitingCheckRow waiting={waiting} machine="forge" threadOf={id => THREADS.find(item => item.id === id)} /></ul>)
    const head = screen.getByRole('button', { name: 'Linux journeys for the paste fix, check on forge, Working' })
    expect(head).toHaveTextContent('Check')
    expect(head).toHaveTextContent('Grok Build · Building · forge')
    fireEvent.click(head)
    expect(head).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('Waiting for forge’s check to finish. 1 ahead.')).toBeInTheDocument()
    const list = screen.getByRole('region', { name: 'Checks on forge, one at a time' })
    expect(list.querySelector('li[data-current]')).toHaveTextContent('Linux journeys for the paste fix')
    fireEvent.keyDown(head, { key: 'Escape' })
    expect(head).toHaveAttribute('aria-expanded', 'false')
    expect(head).toHaveFocus()
    expect(screen.queryByRole('region', { name: 'Checks on forge, one at a time' })).toBeNull()
  })

  it('names its kind of work in the interface language, as every word on the row is (ADR-0123)', () => {
    vi.mocked(useOptionalApp).mockReturnValue({ update: { owlFeatures: { 'cross-machine-work': true } } } as unknown as ReturnType<typeof useOptionalApp>)
    i18n.loadAndActivate({ locale: 'de', messages: { [generateMessageId('Building', 'kind of work')]: 'Bauen' } })
    try {
      const waiting = unmadeChecks(QUEUES, new Set([key(LOCAL, 'paste')]), () => false)[0]!
      render(<ul><WaitingCheckRow waiting={waiting} machine="forge" threadOf={id => THREADS.find(item => item.id === id)} /></ul>)
      expect(document.querySelector('.subagent-meta')).toHaveTextContent('Grok Build · Bauen · forge')
    } finally { act(() => i18n.activate('en')) }
  })
})
