import React from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentState, AgentThread } from '../../../src/shared/agents'
import { MACHINE_FACTS_OLDER } from '../../../src/shared/watcher'
import type { WatcherMachine, WatcherMachinesRead } from '../../../src/shared/watcherRoom'
import { THIS_COMPUTER } from '../../../src/shared/workingThreads'
import { WatcherMachines } from '../../../src/renderer/src/watcher/WatcherMachines'
import { lineText, machineEntries, machineLabel, shortLine, unknownWhy } from '../../../src/renderer/src/watcher/machineLine'
import { placementLine } from '../../../src/renderer/src/watcher/WatcherReceipts'
import { useWatcherRoom } from '../../../src/renderer/src/watcher/watcherRoom'
import { machinesStore } from '../../../src/renderer/src/watcher/useMachines'
import { hostsBridgeFixture, hostsState, hostStatus } from '../../fixtures/renderer/hostBridges'
import type { HostsBridge } from '../../../src/shared/hosts'
import { useOptionalApp } from '../../../src/renderer/src/state/AppContext'

vi.mock('../../../src/renderer/src/watcher/watcherRoom', async importOriginal => ({ ...await importOriginal<typeof import('../../../src/renderer/src/watcher/watcherRoom')>(), useWatcherRoom: vi.fn() }))
vi.mock('../../../src/renderer/src/state/AppContext', async importOriginal => ({ ...await importOriginal<typeof import('../../../src/renderer/src/state/AppContext')>(), useOptionalApp: vi.fn() }))
afterEach(() => { cleanup(); vi.clearAllMocks(); machinesStore.clear() })

const NOW = Date.parse('2026-10-23T12:40:00Z')
const LOCAL = '7d1c8a52-5f0a-4d55-9a38-1f9b7a2a0c11', FORGE = '0b7f4c1e-2a9d-4f61-8c3e-5d2b9a7e4f10', STUDIO = 'c5e2a1f8-9b3d-4e72-a6c1-3f8d2b5e9a07'
const GIB = 1024 ** 3
const read = (cpu: number | null, available: number | null, at = NOW - 6_000) => ({ observedAt: new Date(at).toISOString(), windowMs: 2_000, cpuBusyPercent: cpu,
  loadAverage: null, availableMemoryBytes: available, windowStartAvailableMemoryBytes: available, memoryPressurePercent: null })
const facts = (name: string, family: 'windows' | 'linux' | 'macos', cpus: number, total: number) => ({ observedAt: new Date(NOW).toISOString(),
  os: { family, name, version: null }, architecture: 'x64', totalMemoryBytes: total * GIB, freeMemoryBytes: null, logicalCpuCount: cpus })
function machine(over: Partial<WatcherMachine> & Pick<WatcherMachine, 'hostId' | 'name'>): WatcherMachine {
  return { thisComputer: false, connected: true, factsState: 'reported', facts: facts('Omarchy', 'linux', 24, 64), runningThreads: 0, load: read(22, 41 * GIB),
    placedNotStarted: 0, memoryState: 'enough', cpuState: 'not-busy', ...over }
}
const local = (over: Partial<WatcherMachine> = {}) => machine({ hostId: LOCAL, name: 'This computer', thisComputer: true, facts: facts('Windows 11', 'windows', 16, 32), load: read(34, 14 * GIB), ...over })
const forge = (over: Partial<WatcherMachine> = {}) => machine({ hostId: FORGE, name: 'forge', ...over })
const counts = (entries: Record<string, number>) => new Map(Object.entries(entries))

function thread(id: string, title: string, remote?: string, over: Partial<AgentThread> = {}): AgentThread {
  return { id, title, status: 'running', ...remote ? { remoteHost: true, hostId: remote } : {}, ...over } as AgentThread
}
function agentState(threads: AgentThread[]): AgentState {
  return { host: { threads, projects: [] } } as unknown as AgentState
}
/** A start Watcher placed this run, which the line reads the machines for. */
const PLACED = { requests: [], receiptPlacements: [{ operationId: '5b3c9e1a-7d24-4f6b-8a90-2c1e4d7f6a35', placement: { hostId: FORGE, name: 'forge', awayFromDefault: false } }] }
function show(machines: WatcherMachine[], threads: AgentThread[], extra: Partial<Extract<WatcherMachinesRead, { status: 'ok' }>> = {},
  options: { readonly placed?: boolean; readonly hosts?: HostsBridge } = {}) {
  const readMachines = vi.fn(async (): Promise<WatcherMachinesRead> => ({ status: 'ok', machines, observedAt: new Date(NOW).toISOString(), ...extra }))
  vi.mocked(useWatcherRoom).mockReturnValue({ readMachines, state: options.placed === false ? null : PLACED } as unknown as ReturnType<typeof useWatcherRoom>)
  const navigate = vi.fn()
  vi.mocked(useOptionalApp).mockReturnValue({ actions: { navigate } } as unknown as ReturnType<typeof useOptionalApp>)
  const view = render(<WatcherMachines state={agentState(threads)} now={NOW} hosts={options.hosts} />)
  return { ...view, readMachines, navigate }
}
const wide = () => within(document.querySelector<HTMLElement>('.watcher-machines__wide')!)
const narrow = () => within(document.querySelector<HTMLElement>('.watcher-machines__narrow')!)

describe('The machines line’s words (#1032, pick D)', () => {
  it('counts each machine and adds only the words a problem calls for, in the prototype’s order', () => {
    const entries = machineEntries([local(), forge({ cpuState: 'busy', placedNotStarted: 1 }),
      machine({ hostId: STUDIO, name: 'studio', load: null, memoryState: 'unknown', cpuState: 'unknown' })], counts({ [THIS_COMPUTER]: 2, [FORGE]: 12, [STUDIO]: 1 }))
    expect(entries.map(entry => lineText(entry))).toEqual(['This computer 2 working', 'forge 12 working, 1 starting, may slow down, busy', 'studio 1 working, load unknown'])
    // The narrow line drops the starting counts.
    expect(lineText(entries[1]!, false)).toBe('forge 12 working, may slow down, busy')
    expect(machineLabel(entries[0]!)).toBe('This computer, 2 working. Show this computer’s load and what runs there.')
  })

  it('says a machine is short on memory, and says only that it is not connected when it is not', () => {
    const entries = machineEntries([local({ memoryState: 'short' }), forge({ connected: false, factsState: 'not-connected', facts: null, load: null, memoryState: 'unknown', cpuState: 'unknown' })],
      counts({ [THIS_COMPUTER]: 2 }))
    expect(entries.map(entry => lineText(entry))).toEqual(['This computer 2 working, short on memory', 'forge not connected'])
  })

  it('reads a machine listed without any load as load unknown, never idle', () => {
    const { load: _load, placedNotStarted: _placed, memoryState: _memory, cpuState: _cpu, ...bare } = forge()
    void _load; void _placed; void _memory; void _cpu
    expect(machineEntries([local(), bare], counts({ [FORGE]: 1 })).map(entry => lineText(entry))).toEqual(['This computer 0 working', 'forge 1 working, load unknown'])
  })

  it('stands This computer alone before the first read, so the line is never empty', () => {
    expect(machineEntries(null, counts({ [THIS_COMPUTER]: 3 })).map(entry => lineText(entry))).toEqual(['This computer 3 working'])
  })

  it('shortens to the machines with a problem and a count of the rest, or This computer when nothing is wrong', () => {
    const calm = machineEntries([local(), forge()], counts({}))
    expect(shortLine(calm)).toMatchObject({ shown: [calm[0]], more: 1 })
    const troubled = machineEntries([local(), forge({ cpuState: 'busy' }), machine({ hostId: STUDIO, name: 'studio' })], counts({}))
    expect(shortLine(troubled)).toMatchObject({ shown: [troubled[1]], more: 2 })
  })

  it('says why a load is unknown: an older host, a reading over a minute old, or memory a Mac does not report', () => {
    const older = machineEntries([local(), forge({ factsState: 'unknown', facts: null, note: MACHINE_FACTS_OLDER, load: null, memoryState: 'unknown', cpuState: 'unknown' })], counts({}))[1]!
    expect(unknownWhy(older, NOW)).toMatch(/^forge runs an older Sotto host that does not report its load\. Watcher treats it as unknown, never idle\./u)
    const stale = machineEntries([local(), forge({ load: read(22, 41 * GIB, NOW - 190_000), memoryState: 'unknown', cpuState: 'unknown' })], counts({}))[1]!
    expect(unknownWhy(stale, NOW)).toBe('The last reading is 3 min ago, older than a minute, so Watcher treats forge’s load as unknown, not idle.')
    const mac = machineEntries([local(), forge({ load: read(93, null), memoryState: 'unknown', cpuState: 'busy' })], counts({}))[1]!
    expect(unknownWhy(mac, NOW)).toMatch(/does not report the memory a new process could have/u)
    // The line says load unknown only when both halves are: a Mac says busy from its CPU and leaves its memory to the panel.
    expect(lineText(mac)).toBe('forge 0 working, busy')
    expect(unknownWhy(machineEntries([local(), forge()], counts({}))[1]!, NOW)).toBeNull()
  })

  it('says under a receipt why a start went where it did, and nothing when it went where it was meant to', () => {
    expect(placementLine({ hostId: LOCAL, name: 'This computer', awayFromDefault: true, note: 'Forge, where new workers start, is not connected, so this one started on This computer.' }))
      .toBe('Forge, where new workers start, is not connected, so this one started on This computer.')
    expect(placementLine({ hostId: FORGE, name: 'forge', awayFromDefault: true, defaultName: 'This computer' })).toBe('Not your default, This computer. Watcher says why in its reply.')
    // A default no longer saved has no name to give.
    expect(placementLine({ hostId: FORGE, name: 'forge', awayFromDefault: true })).toBe('Not your default machine. Watcher says why in its reply.')
    expect(placementLine({ hostId: FORGE, name: 'forge', awayFromDefault: false })).toBeNull()
    expect(placementLine(undefined)).toBeNull()
  })
})

describe('The machines line in Watcher’s room', () => {
  it('reads the machines and names each with its count, every name a press that says what it opens', async () => {
    const { readMachines } = show([local(), forge({ cpuState: 'busy' })], [thread('a', 'Installer tests'), thread('b', 'Paste fix'), thread('c', 'Linux journeys', FORGE)])
    await act(async () => undefined)
    expect(readMachines).toHaveBeenCalledTimes(1)
    expect(wide().getByRole('button', { name: 'This computer, 2 working. Show this computer’s load and what runs there.' })).toHaveAttribute('aria-expanded', 'false')
    expect(wide().getByRole('button', { name: 'forge, 1 working, busy. Show forge’s load and what runs there.' })).toBeInTheDocument()
    expect(document.querySelector('.watcher-machines__wide')).toHaveTextContent('This computer 2 working·forge 1 working, busy')
    // The narrow line keeps only the machine with a problem, and counts the rest.
    expect(document.querySelector('.watcher-machines__narrow')).toHaveTextContent('forge 1 working, busy·1 more')
    expect(narrow().getByRole('button', { name: '1 more machine. Show every machine' })).toBeInTheDocument()
  })

  it('opens a machine’s panel with focus in it, and Escape closes it and returns focus to the name', async () => {
    const { readMachines } = show([local(), forge({ cpuState: 'busy', load: read(93, 41 * GIB), placedNotStarted: 1 })],
      [thread('c', 'Linux journeys', FORGE), thread('d', 'Review the reconnect diff', FORGE, { delegatedBy: 'p' }), thread('p', 'Tailnet reconnect fix', undefined, { status: 'idle' })],
      { newWorkersStart: { choice: 'machine', hostId: FORGE, name: 'forge' } })
    await act(async () => undefined)
    const name = wide().getByRole('button', { name: /^forge, 2 working, 1 starting, busy\./u })
    await act(async () => { fireEvent.click(name) })
    const panel = screen.getByRole('dialog', { name: 'forge' })
    expect(panel).toHaveFocus()
    expect(name).toHaveAttribute('aria-expanded', 'true')
    expect(readMachines).toHaveBeenCalledTimes(2)
    const row = (term: string) => within(panel).getByText(term, { selector: 'dt' }).nextElementSibling
    expect(row('System')).toHaveTextContent('Omarchy (Linux) · 24 CPUs')
    expect(row('CPU')).toHaveTextContent('93% busy over the last 2 seconds. Busy')
    expect(row('CPU')).toHaveAttribute('data-warn', 'true')
    expect(row('Memory')).toHaveTextContent('41 GB of 64 GB available')
    expect(row('Memory')).not.toHaveAttribute('data-warn')
    expect(row('Read')).toHaveTextContent('6 s ago')
    expect(panel).toHaveTextContent('2 working, 1 starting. New workers start here.')
    expect(within(panel).getByText('Review the reconnect diff').parentElement).toHaveTextContent('delegated by Tailnet reconnect fix')
    expect(within(panel).getByText('1 placed here, starting')).toBeInTheDocument()
    fireEvent.keyDown(panel, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(name).toHaveFocus()
  })

  it('keeps Tab inside the panel and sends Change where new workers start to Settings, under Watcher', async () => {
    const { navigate } = show([local(), forge()], [])
    await act(async () => undefined)
    await act(async () => { fireEvent.click(wide().getByRole('button', { name: /^This computer,/u })) })
    const panel = screen.getByRole('dialog', { name: 'This computer' })
    const close = within(panel).getByRole('button', { name: 'Close This computer’s panel' })
    const change = within(panel).getByRole('button', { name: 'Change where new workers start' })
    close.focus()
    fireEvent.keyDown(panel, { key: 'Tab' })
    expect(change).toHaveFocus()
    fireEvent.keyDown(panel, { key: 'Tab' })
    expect(close).toHaveFocus()
    fireEvent.click(change)
    expect(navigate).toHaveBeenCalledWith('settings', 'settings-new-workers')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('says a machine that is not connected is not, and what that means when it is where new workers start', async () => {
    show([local(), forge({ connected: false, factsState: 'not-connected', facts: null, load: null, memoryState: 'unknown', cpuState: 'unknown' })], [],
      { newWorkersStart: { choice: 'machine', hostId: FORGE, name: 'forge' } })
    await act(async () => undefined)
    await act(async () => { fireEvent.click(wide().getByRole('button', { name: 'forge, not connected. Show forge’s load and what runs there.' })) })
    expect(screen.getByRole('dialog', { name: 'forge' })).toHaveTextContent('forge is not connected. It is where new workers start, so until it connects they start on this computer, and Watcher says so. Connect it in Settings, under Hosts & phones.')
  })

  it('shows every machine in a narrow room once more is pressed', async () => {
    show([local(), forge(), machine({ hostId: STUDIO, name: 'studio' })], [])
    await act(async () => undefined)
    await act(async () => { fireEvent.click(narrow().getByRole('button', { name: '2 more machines. Show every machine' })) })
    expect(document.querySelector('.watcher-machines')).toHaveAttribute('data-all', 'true')
    expect(wide().getByRole('button', { name: /^forge,/u })).toHaveFocus()
  })

  it('reads machine facts only when Watcher places work or a panel opens, never on a timer, and once per placement', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const { readMachines, unmount } = show([local(), forge()], [], {}, { placed: false })
      await act(async () => { await vi.advanceTimersByTimeAsync(120_000) })
      expect(readMachines).not.toHaveBeenCalled()
      await act(async () => { fireEvent.click(wide().getByRole('button', { name: /^This computer,/u })) })
      expect(readMachines).toHaveBeenCalledTimes(1)
      // A read that names This computer's host ID leaves its panel open.
      await act(async () => undefined)
      expect(screen.getByRole('dialog', { name: 'This computer' })).toBeInTheDocument()
      unmount()
      const again = show([local(), forge()], [])
      await act(async () => undefined)
      expect(again.readMachines).toHaveBeenCalledTimes(1)
      cleanup()
      // The same placements read for once already are not read for again when the room opens again.
      const third = show([local(), forge()], [])
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
      expect(third.readMachines).not.toHaveBeenCalled()
    } finally { vi.useRealTimers() }
  })

  it('takes whether a machine is connected from the saved hosts, which stay current between reads', async () => {
    const hosts = hostsBridgeFixture({ initial: hostsState({ localHostId: LOCAL, hosts: [hostStatus({ id: FORGE, hostId: FORGE, name: 'forge', phase: 'connected' }),
      hostStatus({ id: STUDIO, hostId: STUDIO, name: 'studio', phase: 'disconnected' })] }) })
    // The last read, from before forge connected, says it was not connected and knows nothing of studio.
    show([local(), forge({ connected: false, factsState: 'not-connected', facts: null, load: null, memoryState: 'unknown', cpuState: 'unknown' })], [], {}, { hosts: hosts.bridge })
    await act(async () => undefined)
    expect(document.querySelector('.watcher-machines__wide')).toHaveTextContent('This computer 0 working·forge 0 working·studio not connected')
  })

  it('shows This computer alone, with its count, where the bridge offers no machines read', () => {
    vi.mocked(useWatcherRoom).mockReturnValue({ readMachines: null, state: null } as unknown as ReturnType<typeof useWatcherRoom>)
    vi.mocked(useOptionalApp).mockReturnValue(null)
    render(<WatcherMachines state={agentState([thread('a', 'One')])} now={NOW} />)
    expect(document.querySelector('.watcher-machines__wide')).toHaveTextContent('This computer 1 working')
  })
})
