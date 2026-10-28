// @vitest-environment node
// #1032: where a new worker starts, from what the start asked, where new workers start and what each machine reports.
import { describe, expect, it, vi } from 'vitest'
import { PlacementRefusal, placeWorker, type MachineLoad, type PlacementMachine, type PlacementSources } from '../../../src/main/agents/workerPlacement'
import type { HostOsFamily } from '../../../src/shared/hostFacts'
import type { ProjectOrigins, ProjectSetupRequest, ProjectSetupResult } from '../../../src/shared/workerMachine'

const LAPTOP = '11111111-1111-4111-8111-111111111111', FORGE = '22222222-2222-4222-8222-222222222222', MAC = '33333333-3333-4333-8333-333333333333'
const sotto = { host: 'github.com', owner: 'millZach', name: 'Sotto' }

interface Machine { machine: PlacementMachine; system: HostOsFamily | null; projects: { id: string; title: string }[]; origins?: ProjectOrigins['projects'] | 'fails' | undefined
  /** What setting up a copy there answers (#1690): undefined for an older host, 'fails' for one out of reach. */
  setUp?: ProjectSetupResult | 'fails' | undefined
  load?: MachineLoad | null }
function sources(machines: Machine[]): PlacementSources & { originReads: string[]; setUps: [string, ProjectSetupRequest][] } {
  const originReads: string[] = [], setUps: [string, ProjectSetupRequest][] = []
  const find = (hostId: string) => machines.find(item => item.machine.hostId === hostId)
  return {
    originReads, setUps,
    setUp: async (hostId, request) => {
      setUps.push([hostId, request])
      const answer = find(hostId)?.setUp
      if (answer === 'fails') throw new Error('unreachable')
      return answer
    },
    load: async hostId => find(hostId)?.load ?? null,
    machines: () => machines.map(item => item.machine),
    system: async hostId => find(hostId)?.system ?? null,
    projects: hostId => find(hostId)?.projects ?? [],
    origins: async hostId => {
      originReads.push(hostId)
      const origins = find(hostId)?.origins
      if (origins === 'fails') throw new Error('read failed')
      return origins === undefined ? undefined : { projects: origins }
    },
  }
}
const laptop = (patch: Partial<Machine> = {}): Machine => ({ machine: { hostId: LAPTOP, name: 'This computer', thisComputer: true, connected: true }, system: 'windows',
  projects: [{ id: 'laptop-sotto', title: 'Sotto' }, { id: 'laptop-notes', title: 'Notes' }],
  origins: [{ projectId: 'laptop-sotto', repository: sotto }, { projectId: 'laptop-notes', repository: null }], ...patch })
const forge = (patch: Partial<Machine> = {}): Machine => ({ machine: { hostId: FORGE, name: 'forge', thisComputer: false, connected: true }, system: 'linux',
  projects: [{ id: 'forge-other', title: 'Other' }, { id: 'forge-sotto', title: 'Sotto' }],
  origins: [{ projectId: 'forge-other', repository: { host: 'github.com', owner: 'someone', name: 'Other' } }, { projectId: 'forge-sotto', repository: { host: 'github.com', owner: 'MILLZACH', name: 'sotto' } }], ...patch })
const mac = (patch: Partial<Machine> = {}): Machine => ({ machine: { hostId: MAC, name: 'Studio', thisComputer: false, connected: true }, system: 'macos',
  projects: [{ id: 'mac-notes', title: 'Notes' }], origins: [{ projectId: 'mac-notes', repository: { host: 'github.com', owner: 'someone', name: 'Notes' } }], ...patch })
const onLaptop = { hostId: LAPTOP, projectId: 'laptop-sotto' }
const refusal = async (placing: Promise<unknown>) => {
  const error = await placing.then(() => undefined, (failure: unknown) => failure)
  if (!(error instanceof PlacementRefusal)) throw new Error('not refused')
  return { code: error.code, message: error.message, retryable: error.retryable }
}

describe('a start that names no machine or system', () => {
  it('stays on This computer, away from the default and saying why, when it reuses a worktree or a base branch read here (Zach, October 25)', async () => {
    const read = sources([laptop(), forge()])
    expect(await placeWorker({ pinnedBy: 'existing-worktree' }, FORGE, onLaptop, read)).toEqual({ hostId: LAPTOP, projectId: 'laptop-sotto',
      receipt: { hostId: LAPTOP, name: 'This computer', awayFromDefault: true, defaultName: 'forge',
        note: 'It reuses a worktree on This computer, so it started here rather than on forge, where new workers start.' } })
    expect((await placeWorker({ pinnedBy: 'base-branch' }, FORGE, onLaptop, read)).receipt).toEqual({ hostId: LAPTOP, name: 'This computer', awayFromDefault: true, defaultName: 'forge',
      note: 'Its base branch was read on This computer, so it started here rather than on forge, where new workers start.' })
    expect(read.originReads).toEqual([])
    // A start that names the machine still goes there; where it is placed refuses the choices that do not travel.
    expect((await placeWorker({ machine: FORGE, pinnedBy: 'existing-worktree' }, FORGE, onLaptop, read)).hostId).toBe(FORGE)
    // While new workers start on This computer, nothing is away from the default.
    expect((await placeWorker({ pinnedBy: 'base-branch' }, 'this-computer', onLaptop, read)).receipt).toEqual({ hostId: LAPTOP, name: 'This computer', awayFromDefault: false })
  })
  it('stays where its project is while new workers start on This computer, and reads no machine', async () => {
    const read = sources([laptop(), forge()])
    expect(await placeWorker({}, 'this-computer', onLaptop, read)).toEqual({ hostId: LAPTOP, projectId: 'laptop-sotto',
      receipt: { hostId: LAPTOP, name: 'This computer', awayFromDefault: false } })
    expect(read.originReads).toEqual([])
  })
  it('goes to the copy of its project on the machine new workers start on, found by GitHub origin over any spelling', async () => {
    expect(await placeWorker({}, FORGE, onLaptop, sources([laptop(), forge()]))).toEqual({ hostId: FORGE, projectId: 'forge-sotto',
      receipt: { hostId: FORGE, name: 'forge', awayFromDefault: false } })
  })
  it('starts on This computer and says why when the machine new workers start on is not connected or no longer saved', async () => {
    expect(await placeWorker({}, FORGE, onLaptop, sources([laptop(), forge({ machine: { hostId: FORGE, name: 'forge', thisComputer: false, connected: false } })]))).toEqual({
      hostId: LAPTOP, projectId: 'laptop-sotto', receipt: { hostId: LAPTOP, name: 'This computer', awayFromDefault: true, defaultName: 'forge',
        note: 'Forge, where new workers start, is not connected, so this one started on This computer.' } })
    expect((await placeWorker({}, MAC, onLaptop, sources([laptop(), forge()]))).receipt).toEqual({ hostId: LAPTOP, name: 'This computer', awayFromDefault: true,
      note: 'The machine new workers start on is no longer saved, so this one started on This computer.' })
  })
  it('keeps a project named on another machine there, and says it is away from where new workers start', async () => {
    const onForge = { hostId: FORGE, projectId: 'forge-sotto' }
    expect(await placeWorker({}, 'this-computer', onForge, sources([laptop(), forge()]))).toEqual({ hostId: FORGE, projectId: 'forge-sotto',
      receipt: { hostId: FORGE, name: 'forge', awayFromDefault: true, defaultName: 'This computer' } })
    expect((await placeWorker({}, 'watcher', onForge, sources([laptop(), forge()]))).receipt.awayFromDefault).toBe(false)
    expect((await placeWorker({}, MAC, onForge, sources([laptop(), forge(), mac()]))).hostId).toBe(FORGE)
  })
  it('leaves the choice where Watcher made it when Watcher chooses', async () => {
    expect(await placeWorker({}, 'watcher', onLaptop, sources([laptop(), forge()]))).toMatchObject({ hostId: LAPTOP, receipt: { awayFromDefault: false } })
  })
  it('leaves a project on a machine Sotto no longer knows to admission, which refuses it as before', async () => {
    const gone = '44444444-4444-4444-8444-444444444444'
    expect(await placeWorker({}, 'this-computer', { hostId: gone, projectId: 'p' }, sources([laptop()]))).toMatchObject({ hostId: gone, projectId: 'p' })
  })
})

describe('a start that names a machine', () => {
  it('starts on that machine’s copy, whatever the setting says', async () => {
    expect(await placeWorker({ machine: FORGE }, 'this-computer', onLaptop, sources([laptop(), forge()]))).toEqual({ hostId: FORGE, projectId: 'forge-sotto',
      receipt: { hostId: FORGE, name: 'forge', awayFromDefault: true, defaultName: 'This computer' } })
    expect(await placeWorker({ machine: LAPTOP }, FORGE, { hostId: FORGE, projectId: 'forge-sotto' }, sources([laptop(), forge()]))).toMatchObject({ hostId: LAPTOP, projectId: 'laptop-sotto',
      receipt: { awayFromDefault: true } })
  })
  it('has a machine with no copy set one up, and says in the receipt how (#1690)', async () => {
    const cloned: ProjectSetupResult = { ok: true, projectId: 'mac-sotto', title: 'Sotto', path: '/Users/zach/Projects/Sotto', how: 'cloned', current: true }
    const read = sources([laptop(), mac({ setUp: cloned })])
    expect(await placeWorker({ machine: MAC }, 'this-computer', onLaptop, read)).toEqual({ hostId: MAC, projectId: 'mac-sotto',
      receipt: { hostId: MAC, name: 'Studio', awayFromDefault: true, defaultName: 'This computer', setUp: { how: 'cloned', path: '/Users/zach/Projects/Sotto', current: true },
        note: 'Studio had no copy of Sotto, so Sotto cloned millZach/Sotto into /Users/zach/Projects/Sotto there.' } })
    // It is asked for the repository and the project's title, never a path or a URL.
    expect(read.setUps).toEqual([[MAC, { repository: sotto, title: 'Sotto' }]])
    const added = (current: boolean, reason?: string): Machine => forge({ projects: [{ id: 'forge-other', title: 'Other' }],
      setUp: { ok: true, projectId: 'forge-sotto', title: 'Sotto', path: '/home/zach/Projects/Sotto', how: 'added', current, ...reason ? { reason } : {} } })
    expect((await placeWorker({ machine: FORGE }, 'this-computer', onLaptop, sources([laptop(), added(true)]))).receipt).toMatchObject({
      setUp: { how: 'added', path: '/home/zach/Projects/Sotto', current: true },
      note: 'Sotto added the copy of Sotto already at /home/zach/Projects/Sotto to forge\'s projects and brought it up to date.' })
    expect((await placeWorker({ machine: FORGE }, 'this-computer', onLaptop, sources([laptop(), added(false, 'it has uncommitted changes')]))).receipt).toMatchObject({
      setUp: { how: 'added', current: false },
      note: 'Sotto added the copy of Sotto already at /home/zach/Projects/Sotto to forge\'s projects; it was left as it was because it has uncommitted changes, so the worker starts from that checkout\'s commit.' })
  })
  it('joins the sentence of the setup to the one saying why Sotto placed it there', async () => {
    const cloned: ProjectSetupResult = { ok: true, projectId: 'mac-sotto', title: 'Sotto', path: '/Users/zach/Projects/Sotto', how: 'cloned', current: true }
    const load = { busy: { cpu: 'busy', memory: 'enough', cpuBusyPercent: 97 }, roomy: { cpu: 'not-busy', memory: 'enough', cpuBusyPercent: 3 } } as const
    expect((await placeWorker({}, 'watcher', onLaptop, sources([laptop({ load: load.busy }), mac({ setUp: cloned, load: load.roomy })]))).receipt.note)
      .toBe('This computer is busy, so Sotto started this one on Studio, which has room. Studio had no copy of Sotto, so Sotto cloned millZach/Sotto into /Users/zach/Projects/Sotto there.')
  })
  it('refuses in plain words when a machine with no copy cannot set one up', async () => {
    expect(await refusal(placeWorker({ machine: MAC }, 'this-computer', onLaptop, sources([laptop(), mac()])))).toEqual({ code: 'HOST_FEATURE_UNAVAILABLE', retryable: false,
      message: 'Studio has no copy of Sotto, and its Sotto is too old to set one up. Update Sotto on it, or add the project there. Nothing was started.' })
    const occupied = 'There is already a folder named Sotto in /home/zach/Projects that is not a copy of millZach/Sotto. Clone millZach/Sotto there under another name yourself, or name another machine.'
    expect(await refusal(placeWorker({ machine: FORGE }, 'this-computer', onLaptop, sources([laptop(), forge({ projects: [{ id: 'forge-other', title: 'Other' }], setUp: { ok: false, message: occupied } })]))))
      .toEqual({ code: 'UNKNOWN_TARGET', retryable: false, message: `Forge has no copy of Sotto, and Sotto could not set one up. ${occupied} Nothing was started.` })
    expect(await refusal(placeWorker({ machine: FORGE }, 'this-computer', onLaptop, sources([laptop(), forge({ projects: [{ id: 'forge-other', title: 'Other' }], setUp: 'fails' })]))))
      .toEqual({ code: 'HOST_DISCONNECTED', retryable: true, message: 'Forge has no copy of Sotto, and Sotto could not reach it to set one up. Nothing was started. Try again.' })
  })
  it('refuses one it does not know or that is not connected', async () => {
    expect(await refusal(placeWorker({ machine: MAC }, 'this-computer', onLaptop, sources([laptop(), forge()])))).toMatchObject({ code: 'UNKNOWN_TARGET' })
    expect(await refusal(placeWorker({ machine: FORGE }, 'this-computer', onLaptop, sources([laptop(), forge({ machine: { hostId: FORGE, name: 'forge', thisComputer: false, connected: false } })]))))
      .toEqual({ code: 'HOST_DISCONNECTED', retryable: true, message: 'Forge is not connected. Connect it from the Threads page, or name another machine. Nothing was started.' })
  })
  it('takes an older machine that reports no facts or origins when the project is already on it', async () => {
    const older = forge({ system: null, origins: undefined })
    expect(await placeWorker({ machine: FORGE }, 'this-computer', { hostId: FORGE, projectId: 'forge-sotto' }, sources([laptop(), older]))).toMatchObject({ hostId: FORGE, projectId: 'forge-sotto' })
    expect(await refusal(placeWorker({ machine: FORGE }, 'this-computer', onLaptop, sources([laptop(), older])))).toEqual({ code: 'HOST_FEATURE_UNAVAILABLE', retryable: false,
      message: 'Forge cannot say which repository its projects are copies of. Update Sotto on it, or name one of its projects from list_projects. Nothing was started.' })
  })
  it('refuses a project with no GitHub origin, and a read that fails says to try again', async () => {
    expect(await refusal(placeWorker({ machine: FORGE }, 'this-computer', { hostId: LAPTOP, projectId: 'laptop-notes' }, sources([laptop(), forge()])))).toMatchObject({ code: 'UNKNOWN_TARGET',
      message: 'Notes has no GitHub origin on This computer, so Sotto cannot find its copy on forge. Name a project on forge from list_projects. Nothing was started.' })
    expect(await refusal(placeWorker({ machine: FORGE }, 'this-computer', onLaptop, sources([laptop(), forge({ origins: 'fails' })])))).toMatchObject({ code: 'HOST_DISCONNECTED', retryable: true })
  })
  it('prefers the copy with the same title when a machine has two', async () => {
    const two = forge({ projects: [{ id: 'forge-fork', title: 'Sotto fork' }, { id: 'forge-sotto', title: 'Sotto' }],
      origins: [{ projectId: 'forge-fork', repository: sotto }, { projectId: 'forge-sotto', repository: sotto }] })
    expect((await placeWorker({ machine: FORGE }, 'this-computer', onLaptop, sources([laptop(), two]))).projectId).toBe('forge-sotto')
  })
  it('checks a system named beside it, and never starts on a machine of another', async () => {
    expect((await placeWorker({ machine: FORGE, os: 'linux' }, 'this-computer', onLaptop, sources([laptop(), forge()]))).hostId).toBe(FORGE)
    expect(await refusal(placeWorker({ machine: FORGE, os: 'windows' }, 'this-computer', onLaptop, sources([laptop(), forge()])))).toEqual({ code: 'INVALID_INPUT', retryable: false,
      message: 'Forge runs Linux, not Windows. Name a Windows machine, or leave the system out. Nothing was started.' })
    expect(await refusal(placeWorker({ machine: FORGE, os: 'linux' }, 'this-computer', onLaptop, sources([laptop(), forge({ system: null })])))).toMatchObject({ code: 'HOST_FEATURE_UNAVAILABLE',
      message: 'Forge does not say what system it runs. Update Sotto on it, or leave the system out. Nothing was started.' })
  })
})

describe('Watcher\'s own choice with This computer busy (#1690)', () => {
  const busy: MachineLoad = { cpu: 'busy', memory: 'enough', cpuBusyPercent: 97 }
  const roomy = (cpuBusyPercent: number): MachineLoad => ({ cpu: 'not-busy', memory: 'enough', cpuBusyPercent })
  it('starts on a connected machine with room, the least busy first, and says why', async () => {
    const box = { machine: { hostId: MAC, name: 'box', thisComputer: false, connected: true }, system: 'linux' as const, projects: [{ id: 'box-sotto', title: 'Sotto' }],
      origins: [{ projectId: 'box-sotto', repository: sotto }], load: roomy(40) }
    expect(await placeWorker({}, 'watcher', onLaptop, sources([laptop({ load: busy }), forge({ load: roomy(10) }), box]))).toEqual({ hostId: FORGE, projectId: 'forge-sotto',
      receipt: { hostId: FORGE, name: 'forge', awayFromDefault: false, note: 'This computer is busy, so Sotto started this one on forge, which has room.' } })
    expect((await placeWorker({}, 'watcher', onLaptop, sources([laptop({ load: { cpu: 'not-busy', memory: 'short', cpuBusyPercent: 5 } }), forge({ load: roomy(10) })]))).receipt.note)
      .toBe('This computer is short on memory, so Sotto started this one on forge, which has room.')
    // A Mac reports its memory as unknown; a busy processor alone still moves the start.
    expect((await placeWorker({}, 'watcher', onLaptop, sources([laptop({ load: { cpu: 'busy', memory: 'unknown', cpuBusyPercent: 99 } }), forge({ load: roomy(10) })]))).hostId).toBe(FORGE)
  })
  it('stays on This computer when it has room, when its load says nothing is wrong, or when no other machine has room', async () => {
    const stays = async (machines: Machine[]) => (await placeWorker({}, 'watcher', onLaptop, sources(machines))).receipt
    expect(await stays([laptop({ load: roomy(20) }), forge({ load: roomy(1) })])).toEqual({ hostId: LAPTOP, name: 'This computer', awayFromDefault: false })
    expect(await stays([laptop({ load: null }), forge({ load: roomy(1) })])).toEqual({ hostId: LAPTOP, name: 'This computer', awayFromDefault: false })
    expect(await stays([laptop({ load: { cpu: 'unknown', memory: 'enough', cpuBusyPercent: null } }), forge({ load: roomy(1) })])).toMatchObject({ hostId: LAPTOP })
    expect(await stays([laptop({ load: busy }), forge({ load: null })])).toMatchObject({ hostId: LAPTOP })
    expect(await stays([laptop({ load: busy }), forge({ load: { cpu: 'not-busy', memory: 'short', cpuBusyPercent: 1 } })])).toMatchObject({ hostId: LAPTOP })
    expect(await stays([laptop({ load: busy }), forge({ load: roomy(1), machine: { hostId: FORGE, name: 'forge', thisComputer: false, connected: false } })])).toMatchObject({ hostId: LAPTOP })
  })
  it('comes back to This computer, and says so, when the machine Sotto chose cannot take it', async () => {
    const read = sources([laptop({ load: busy }), forge({ load: roomy(10), projects: [{ id: 'forge-other', title: 'Other' }], setUp: { ok: false, message: 'Git could not clone it.' } })])
    expect(await placeWorker({}, 'watcher', onLaptop, read)).toEqual({ hostId: LAPTOP, projectId: 'laptop-sotto', receipt: { hostId: LAPTOP, name: 'This computer', awayFromDefault: false,
      note: 'This computer is busy, so Sotto tried forge, which has room, but could not start this one there, so it started on This computer.' } })
    expect(read.setUps).toHaveLength(1)
  })
  it('moves nothing that was asked for, pinned here, set elsewhere or named on another machine', async () => {
    const machines = () => [laptop({ load: busy }), forge({ load: roomy(10) })]
    expect((await placeWorker({ machine: LAPTOP }, 'watcher', onLaptop, sources(machines()))).hostId).toBe(LAPTOP)
    expect((await placeWorker({ os: 'windows' }, 'watcher', onLaptop, sources(machines()))).hostId).toBe(LAPTOP)
    expect((await placeWorker({ pinnedBy: 'existing-worktree' }, 'watcher', onLaptop, sources(machines()))).hostId).toBe(LAPTOP)
    expect((await placeWorker({}, 'this-computer', onLaptop, sources(machines()))).hostId).toBe(LAPTOP)
    expect((await placeWorker({}, 'watcher', { hostId: FORGE, projectId: 'forge-sotto' }, sources([laptop({ load: roomy(1) }), forge({ load: busy })]))).hostId).toBe(FORGE)
  })
})

describe('a start that names a system', () => {
  it('starts on a connected machine of that system, the default first, then the project’s machine, then This computer', async () => {
    expect((await placeWorker({ os: 'linux' }, 'this-computer', onLaptop, sources([laptop(), forge()]))).hostId).toBe(FORGE)
    expect((await placeWorker({ os: 'windows' }, FORGE, onLaptop, sources([laptop(), forge()]))).hostId).toBe(LAPTOP)
    const second = { machine: { hostId: MAC, name: 'box', thisComputer: false, connected: true }, system: 'linux' as const, projects: [{ id: 'box-sotto', title: 'Sotto' }],
      origins: [{ projectId: 'box-sotto', repository: sotto }] }
    expect((await placeWorker({ os: 'linux' }, MAC, onLaptop, sources([laptop(), forge(), second]))).hostId).toBe(MAC)
    expect((await placeWorker({ os: 'linux' }, 'this-computer', onLaptop, sources([laptop(), second, forge()]))).hostId).toBe(MAC)
  })
  it('refuses with none connected and starts nothing elsewhere, in the words for each system', async () => {
    const read = sources([laptop(), forge({ machine: { hostId: FORGE, name: 'forge', thisComputer: false, connected: false } })])
    const system = vi.spyOn(read, 'system')
    expect(await refusal(placeWorker({ os: 'linux' }, FORGE, onLaptop, read))).toEqual({ code: 'HOST_DISCONNECTED', retryable: true,
      message: 'No Linux machine is connected. Connect a Linux machine, or run this on This computer. Nothing was started.' })
    // A machine not connected is not asked what it runs.
    expect(system.mock.calls.map(([hostId]) => hostId)).toEqual([LAPTOP])
    expect(await refusal(placeWorker({ os: 'macos' }, 'this-computer', onLaptop, sources([laptop(), forge()])))).toMatchObject({
      message: 'No Mac is connected. Connect a Mac, or run this on This computer. Nothing was started.' })
    expect(await refusal(placeWorker({ os: 'windows' }, 'this-computer', onLaptop, sources([laptop({ system: 'linux' }), forge()])))).toMatchObject({
      message: 'No Windows machine is connected. Connect a Windows machine, or run this on This computer. Nothing was started.' })
  })
  it('reads a machine whose facts fail as no system, never as a match', async () => {
    const read = sources([laptop(), forge()])
    vi.spyOn(read, 'system').mockImplementation(async hostId => { if (hostId === FORGE) throw new Error('read failed'); return 'windows' })
    expect(await refusal(placeWorker({ os: 'linux' }, 'this-computer', onLaptop, read))).toMatchObject({ code: 'HOST_DISCONNECTED' })
  })
})
