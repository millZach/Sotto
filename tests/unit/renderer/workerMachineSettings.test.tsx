import React from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type SettingsPatch } from '../../../src/shared/settings'
import type { WatcherMachine, WatcherMachinesRead } from '../../../src/shared/watcherRoom'
import { useOptionalAgents } from '../../../src/renderer/src/agents/AgentContext'
import { WorkerCapacitySettings, WorkerMachineSettings } from '../../../src/renderer/src/features/settings/WorkerMachineSettings'
import { useOwlFeature } from '../../../src/renderer/src/state/owlFeature'
import { useWatcherRoom } from '../../../src/renderer/src/watcher/watcherRoom'
import { hostsBridgeFixture, hostsState, hostStatus } from '../../fixtures/renderer/hostBridges'

vi.mock('../../../src/renderer/src/watcher/watcherRoom', async importOriginal => ({ ...await importOriginal<typeof import('../../../src/renderer/src/watcher/watcherRoom')>(), useWatcherRoom: vi.fn() }))
vi.mock('../../../src/renderer/src/agents/AgentContext', async importOriginal => ({ ...await importOriginal<typeof import('../../../src/renderer/src/agents/AgentContext')>(), useOptionalAgents: vi.fn() }))
vi.mock('../../../src/renderer/src/state/owlFeature', async importOriginal => ({ ...await importOriginal<typeof import('../../../src/renderer/src/state/owlFeature')>(), useOwlFeature: vi.fn(() => false) }))
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.mocked(useOwlFeature).mockImplementation(() => false) })

const NOW = Date.now()
const LOCAL = '7d1c8a52-5f0a-4d55-9a38-1f9b7a2a0c11', FORGE = '0b7f4c1e-2a9d-4f61-8c3e-5d2b9a7e4f10'
const GIB = 1024 ** 3
const load = (cpu: number, available: number) => ({ observedAt: new Date(NOW - 4_000).toISOString(), windowMs: 2_000, cpuBusyPercent: cpu, loadAverage: null,
  availableMemoryBytes: available * GIB, windowStartAvailableMemoryBytes: available * GIB, memoryPressurePercent: null })
const facts = (name: string, family: 'windows' | 'linux', cpus: number, total: number) => ({ observedAt: new Date(NOW).toISOString(), os: { family, name, version: null },
  architecture: 'x64', totalMemoryBytes: total * GIB, freeMemoryBytes: null, logicalCpuCount: cpus })
const local: WatcherMachine = { hostId: LOCAL, name: 'This computer', thisComputer: true, connected: true, factsState: 'reported', facts: facts('Windows 11', 'windows', 16, 32),
  runningThreads: 2, load: load(34, 14), placedNotStarted: 0, memoryState: 'enough', cpuState: 'not-busy' }
const forge: WatcherMachine = { hostId: FORGE, name: 'forge', thisComputer: false, connected: true, factsState: 'reported', facts: facts('Omarchy', 'linux', 24, 64),
  runningThreads: 3, load: load(93, 41), placedNotStarted: 0, memoryState: 'enough', cpuState: 'busy' }

function show(options: { machines?: WatcherMachine[]; saved?: Parameters<typeof hostStatus>[0][]; chosen?: string } = {}) {
  const machines = options.machines ?? [local, forge]
  const readMachines = vi.fn(async (): Promise<WatcherMachinesRead> => ({ status: 'ok', machines, observedAt: new Date(NOW).toISOString() }))
  vi.mocked(useWatcherRoom).mockReturnValue({ readMachines, state: null } as unknown as ReturnType<typeof useWatcherRoom>)
  vi.mocked(useOptionalAgents).mockReturnValue(null)
  const hosts = hostsBridgeFixture({ initial: hostsState({ localHostId: LOCAL, hosts: (options.saved ?? [{ hostId: FORGE, name: 'forge' }]).map(hostStatus) }) })
  const update = vi.fn<(patch: SettingsPatch) => Promise<boolean>>(async () => true)
  const openHosts = vi.fn()
  render(<WorkerMachineSettings settings={{ ...DEFAULT_SETTINGS, ...options.chosen ? { newWorkerMachine: options.chosen } : {} }} onUpdateSettings={update} onOpenHosts={openHosts} hosts={hosts.bridge} />)
  return { update, openHosts }
}
const group = () => within(screen.getByRole('group', { name: 'Where new workers start' }))

describe('Settings, under Watcher: Where new workers start (#1032)', () => {
  it('offers Let Watcher choose, This computer (chosen by default) and each paired machine, each with what it is and how busy it is', async () => {
    show()
    await act(async () => undefined)
    const radios = group().getAllByRole('radio')
    expect(radios.map(radio => radio.getAttribute('value'))).toEqual(['watcher', 'this-computer', FORGE])
    expect(group().getByRole('radio', { name: 'This computer' })).toBeChecked()
    const thisComputer = group().getByRole('radio', { name: 'This computer' }).closest('label')!
    expect(thisComputer).toHaveTextContent('New workers start here')
    expect(thisComputer).toHaveTextContent('Windows 11 · 16 CPUs · 32 GB')
    const forgeCard = group().getByRole('radio', { name: 'forge' }).closest('label')!
    expect(forgeCard).toHaveTextContent('Omarchy (Linux) · 24 CPUs · 64 GB')
    expect(within(forgeCard).getByText('CPU 93%, busy')).toHaveAttribute('data-warn', 'true')
    expect(forgeCard).toHaveTextContent('41 GB free')
  })

  it('shows the CPU of a machine that does not report its memory, and says only the memory is unknown', async () => {
    show({ machines: [local, { ...forge, load: { ...load(93, 41), availableMemoryBytes: null }, memoryState: 'unknown' }] })
    await act(async () => undefined)
    const forgeCard = group().getByRole('radio', { name: 'forge' }).closest('label')!
    expect(within(forgeCard).getByText('CPU 93%, busy')).toBeInTheDocument()
    expect(forgeCard).toHaveTextContent('memory unknown')
    expect(forgeCard).not.toHaveTextContent('load unknown')
  })

  it('saves the choice as it is made', async () => {
    const { update } = show()
    await act(async () => undefined)
    fireEvent.click(group().getByRole('radio', { name: 'forge' }))
    expect(update).toHaveBeenCalledWith({ newWorkerMachine: FORGE })
    fireEvent.click(group().getByRole('radio', { name: 'Let Watcher choose' }))
    expect(update).toHaveBeenLastCalledWith({ newWorkerMachine: 'watcher' })
  })

  it('says what happens while the chosen machine is not connected', async () => {
    show({ machines: [local, { ...forge, connected: false, factsState: 'not-connected', facts: null, load: null, memoryState: 'unknown', cpuState: 'unknown' }], chosen: FORGE,
      saved: [{ hostId: FORGE, name: 'forge', phase: 'disconnected' }] })
    await act(async () => undefined)
    const radio = group().getByRole('radio', { name: 'forge' })
    expect(radio).toBeChecked()
    expect(radio).toHaveAccessibleDescription('forge is not connected. Until it is, new workers start on this computer, and Watcher says so in its reply.')
    expect(radio.closest('label')).toHaveTextContent('Not connected')
  })

  it('takes whether a machine is connected from the saved hosts now, not from the last read, as the machines line does', async () => {
    // The last read found forge connected; it has since dropped.
    show({ machines: [local, forge], chosen: FORGE, saved: [{ hostId: FORGE, name: 'forge', phase: 'disconnected' }] })
    await act(async () => undefined)
    const card = group().getByRole('radio', { name: 'forge' }).closest('label')!
    expect(card).toHaveTextContent('Not connected')
    expect(card).not.toHaveTextContent('CPU 93%')
    expect(group().getByRole('radio', { name: 'forge' })).toHaveAccessibleDescription(/forge is not connected\./u)
    cleanup()
    // The last read found forge not connected; it is connected now.
    show({ machines: [local, { ...forge, connected: false, factsState: 'not-connected', facts: null, load: null, memoryState: 'unknown', cpuState: 'unknown' }],
      saved: [{ hostId: FORGE, name: 'forge', phase: 'connected' }] })
    await act(async () => undefined)
    const now = group().getByRole('radio', { name: 'forge' }).closest('label')!
    expect(now).not.toHaveTextContent('Not connected')
    expect(now).toHaveTextContent('0 working')
    cleanup()
    // A machine reconnecting is not connected yet.
    show({ machines: [local, forge], saved: [{ hostId: FORGE, name: 'forge', phase: 'connected', reconnecting: true }] })
    await act(async () => undefined)
    expect(group().getByRole('radio', { name: 'forge' }).closest('label')).toHaveTextContent('Not connected')
  })

  it('says only this computer is connected when no machine is paired, and offers Hosts & phones', async () => {
    const { openHosts } = show({ machines: [local], saved: [] })
    await act(async () => undefined)
    expect(group().getAllByRole('radio').map(radio => radio.getAttribute('value'))).toEqual(['this-computer'])
    fireEvent.click(screen.getByRole('button', { name: 'Hosts & phones' }))
    expect(openHosts).toHaveBeenCalled()
  })
})

describe('Settings, under Watcher: Worker capacity (worker swarms, ADR-0162)', () => {
  function capacity(options: { crossMachine?: boolean; ceilings?: Record<string, number> } = {}) {
    vi.mocked(useOwlFeature).mockImplementation(id => id === 'cross-machine-work' && options.crossMachine === true)
    const hosts = hostsBridgeFixture({ initial: hostsState({ localHostId: LOCAL, hosts: [{ hostId: LOCAL, name: 'This PC' }, { hostId: FORGE, name: 'forge' }].map(hostStatus) }) })
    const update = vi.fn<(patch: SettingsPatch) => Promise<boolean>>(async () => true)
    render(<WorkerCapacitySettings settings={{ ...DEFAULT_SETTINGS, workerMachineCeilings: options.ceilings ?? {} }} onUpdateSettings={update} hosts={hosts.bridge} />)
    return { update }
  }

  it('saves how many may work at once here, ten by default, and says so when the number is not one it takes', () => {
    const { update } = capacity()
    const field = screen.getByRole('textbox', { name: 'Most working at once' })
    expect(field).toHaveValue('10')
    expect(screen.queryByRole('textbox', { name: 'forge' })).toBeNull()
    fireEvent.change(field, { target: { value: '0' } })
    fireEvent.blur(field)
    expect(update).not.toHaveBeenCalled()
    expect(screen.getByText('Enter a whole number, 1 or more. Nothing was changed.')).toBeInTheDocument()
    fireEvent.change(field, { target: { value: '6' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(update).toHaveBeenLastCalledWith({ workerCeiling: 6 })
  })

  it('with Work across machines on, lets each paired machine ask for its own by its host ID, and empty puts it back on the page’s', async () => {
    const { update } = capacity({ crossMachine: true, ceilings: { [FORGE]: 16 } })
    await act(async () => undefined)
    const forgeField = await screen.findByRole('textbox', { name: 'forge' })
    expect(forgeField).toHaveValue('16')
    expect(screen.queryByRole('textbox', { name: 'This PC' })).toBeNull()
    fireEvent.change(forgeField, { target: { value: '12' } })
    fireEvent.blur(forgeField)
    expect(update).toHaveBeenLastCalledWith({ workerMachineCeilings: { [FORGE]: 12 } })
    fireEvent.change(forgeField, { target: { value: '' } })
    fireEvent.blur(forgeField)
    expect(update).toHaveBeenLastCalledWith({ workerMachineCeilings: {} })
  })
})
