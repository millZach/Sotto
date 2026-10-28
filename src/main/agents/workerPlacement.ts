import type { AgentProject } from '../../shared/agents'
import type { HostOsFamily, MachineCpuState, MachineMemoryState } from '../../shared/hostFacts'
import type { WatcherRefusal } from '../../shared/watcher'
import { WORKER_SYSTEM_WORDS, type ProjectOrigins, type ProjectSetupRequest, type ProjectSetupResult, type WorkerMachineSetting, type WorkerPlacementReceipt,
  type WorkerSystem } from '../../shared/workerMachine'
import { sameRepository } from './github'

type WatcherRefusalCode = WatcherRefusal['code']

/**
 * Where a new worker starts (#1032, Owl `cross-machine-work`). Sotto supplies the facts and keeps to what was asked;
 * Watcher judges. A start names a project on one machine and may name a machine or a system besides:
 *
 * - **A machine** starts it there, and nowhere else.
 * - **A system** starts it on a connected machine of that system, and never falls back to another system. The machine
 *   new workers start on comes first when it is one, then the machine the project was named on, then This computer.
 * - **Neither** keeps a project named on another machine there, as Watcher has always placed work. A project named on
 *   This computer goes to the machine Settings say new workers start on, when that is another machine; one that is not
 *   connected, or no longer saved, starts the worker on This computer instead, and the receipt says why. So does one
 *   that reuses a worktree there or starts from a base branch read there: those choices mean nothing on another machine.
 *   Where Settings leave the machine to Watcher, a project named on This computer stays here unless This computer is busy
 *   or short on memory and another connected machine is neither; then it goes to the one with the most CPU to spare, and
 *   the receipt says why. A load anywhere unknown moves nothing, and a start Sotto moved that cannot start there comes
 *   back here: Sotto's own choice never refuses a start that would have run on This computer.
 *
 * On another machine than the project was named on, the project is found by its GitHub origin (`sameRepository`). A
 * machine with no copy gets one (#1690): its host adds a clone already in its usual projects folder, or clones the
 * repository there, and the receipt says which. A machine whose host cannot say its projects' repositories, or cannot set
 * up a copy, refuses with what to do. Nothing here starts a worker: it answers where, or refuses.
 */
export interface PlacementMachine {
  readonly hostId: string
  /** "This computer" for this one; another machine's name as this computer saved it. */
  readonly name: string
  readonly thisComputer: boolean
  readonly connected: boolean
}
export interface PlacementSources {
  /** This computer first, then every other machine this computer knows, connected or not. */
  machines(): readonly PlacementMachine[]
  /** A machine's system from its host facts, or null when it does not say. Read only when a start names a system. */
  system(hostId: string): Promise<HostOsFamily | null>
  /** A machine's projects as its host publishes them. */
  projects(hostId: string): readonly Pick<AgentProject, 'id' | 'title'>[]
  /** A machine's projects' GitHub origins, or undefined when its host does not report them. Rejects when the read fails. */
  origins(hostId: string): Promise<ProjectOrigins | undefined>
  /**
   * Sets up a copy of a repository on a machine that has none (#1690), or undefined when its host cannot. A setup that
   * cannot finish answers in plain words; rejects only when the machine cannot be asked.
   */
  setUp?(hostId: string, request: ProjectSetupRequest): Promise<ProjectSetupResult | undefined>
  /** How busy a machine is now, or null when it does not say. Read only where Watcher's own choice may move a start. */
  load?(hostId: string): Promise<MachineLoad | null>
}
export interface MachineLoad { readonly cpu: MachineCpuState; readonly memory: MachineMemoryState; readonly cpuBusyPercent: number | null }
export interface PlacementAsk {
  readonly machine?: string | undefined
  readonly os?: WorkerSystem | undefined
  /**
   * A working-copy choice read for the project where it was named, which ties a start that names neither machine nor
   * system to that machine: an existing worktree it reuses, or the base branch it starts from (Zach, October 25, 2026).
   */
  readonly pinnedBy?: 'existing-worktree' | 'base-branch' | undefined
}
/** Why a start that the machine new workers start on would have taken stayed on This computer instead. */
const PINNED_WORDS = { 'existing-worktree': 'It reuses a worktree on This computer', 'base-branch': 'Its base branch was read on This computer' } as const
export interface WorkerPlacement {
  readonly hostId: string
  readonly projectId: string
  readonly receipt: WorkerPlacementReceipt
}
/** A start Sotto will not place as asked, with Watcher's refusal code for it and the words that say why. */
export class PlacementRefusal extends Error {
  constructor(readonly code: WatcherRefusalCode, message: string, readonly retryable = false) { super(message) }
}

function refuse(code: WatcherRefusalCode, message: string, retryable = false): never { throw new PlacementRefusal(code, message, retryable) }
/** A machine's name at the start of a sentence: "Forge has no copy of Sotto." */
const capital = (name: string): string => name.charAt(0).toUpperCase() + name.slice(1)
/** A machine's name inside a sentence: This computer keeps its capital, as the app writes it everywhere. */
const named = (machine: PlacementMachine): string => machine.name

/** The machine Settings say new workers start on, by host ID: This computer's, a saved machine's, or none for Watcher's choice. */
function defaultHostId(setting: WorkerMachineSetting, local: PlacementMachine): string | undefined {
  return setting === 'watcher' ? undefined : setting === 'this-computer' ? local.hostId : setting
}

export async function placeWorker(ask: PlacementAsk, setting: WorkerMachineSetting, project: { readonly hostId: string; readonly projectId: string },
  sources: PlacementSources): Promise<WorkerPlacement> {
  const machines = sources.machines(), local = machines.find(machine => machine.thisComputer)
  if (!local) throw new Error('This computer is not among the machines.')
  // A project on a machine this computer no longer knows is refused where its start is admitted, as before.
  const from = machines.find(machine => machine.hostId === project.hostId)
  const defaultId = defaultHostId(setting, local)
  let target: PlacementMachine, note: string | undefined, moved: { machine: PlacementMachine; state: string; why: string } | undefined
  if (ask.machine !== undefined) {
    target = machines.find(machine => machine.hostId === ask.machine)
      ?? refuse('UNKNOWN_TARGET', 'Sotto knows no machine by that host ID. Call list_machines and name one it lists. Nothing was started.')
    if (!target.connected) refuse('HOST_DISCONNECTED', `${capital(named(target))} is not connected. Connect it from the Threads page, or name another machine. Nothing was started.`, true)
    if (ask.os !== undefined) {
      const system = await sources.system(target.hostId)
      if (system === null) refuse('HOST_FEATURE_UNAVAILABLE', `${capital(named(target))} does not say what system it runs. Update Sotto on it, or leave the system out. Nothing was started.`)
      if (system !== ask.os) refuse('INVALID_INPUT', `${capital(named(target))} runs ${WORKER_SYSTEM_WORDS[system].name}, not ${WORKER_SYSTEM_WORDS[ask.os].name}. Name ${WORKER_SYSTEM_WORDS[ask.os].a}, or leave the system out. Nothing was started.`)
    }
  } else if (ask.os !== undefined) {
    const connected = machines.filter(machine => machine.connected)
    const systems = await Promise.all(connected.map(machine => sources.system(machine.hostId).catch(() => null)))
    const matching = connected.filter((_, index) => systems[index] === ask.os)
    const words = WORKER_SYSTEM_WORDS[ask.os]
    // An explicit system never falls back to another (#1312): with none connected, nothing starts.
    if (!matching.length) refuse('HOST_DISCONNECTED', `No ${words.one} is connected. Connect ${words.a}, or run this on This computer. Nothing was started.`, true)
    target = [defaultId, project.hostId, local.hostId].flatMap(id => matching.find(machine => machine.hostId === id) ?? []).at(0) ?? matching[0]!
  } else if (project.hostId === local.hostId && defaultId === undefined && ask.pinnedBy === undefined && (moved = await roomElsewhere(local, machines, sources))) {
    // Watcher's own choice, with This computer busy and another machine with room (#1690).
    target = moved.machine
    note = moved.why
  } else if (project.hostId !== local.hostId || defaultId === undefined || defaultId === local.hostId) {
    // Where new workers start applies only to this computer's projects (Zach, October 23, 2026). A project named on another
    // machine is placed there, whatever the setting says, as Watcher has always placed work; so is Watcher's own choice.
    target = from ?? { hostId: project.hostId, name: 'Paired machine', thisComputer: false, connected: false }
  } else if (ask.pinnedBy !== undefined) {
    // An explicit machine or system keeps the refusal where the start is placed; a default only stays here.
    const chosen = machines.find(machine => machine.hostId === defaultId)
    target = local
    note = `${PINNED_WORDS[ask.pinnedBy]}, so it started here rather than on ${chosen ? `${named(chosen)}, where new workers start` : 'the machine new workers start on'}.`
  } else {
    const chosen = machines.find(machine => machine.hostId === defaultId)
    if (chosen?.connected) target = chosen
    else {
      target = local
      note = chosen ? `${capital(named(chosen))}, where new workers start, is not connected, so this one started on This computer.`
        : 'The machine new workers start on is no longer saved, so this one started on This computer.'
    }
  }
  const awayFromDefault = defaultId !== undefined && target.hostId !== defaultId
  // The machine new workers start on, by name, for a receipt that says the start is not there (Zach, October 23, 2026).
  const defaultName = awayFromDefault ? machines.find(machine => machine.hostId === defaultId)?.name : undefined
  const receipt = (at: PlacementMachine, ...notes: (string | undefined)[]): WorkerPlacementReceipt => {
    const said = notes.filter(Boolean).join(' ')
    return { hostId: at.hostId, name: named(at), awayFromDefault, ...defaultName ? { defaultName } : {}, ...said ? { note: said } : {} }
  }
  if (target.hostId === project.hostId) return { hostId: target.hostId, projectId: project.projectId, receipt: receipt(target, note) }
  if (!from) refuse('UNKNOWN_TARGET', 'That project is unavailable. Read the project list again. Nothing was started.')
  let found: FoundProject
  try { found = await sameProject(from, target, project.projectId, sources) } catch (error) {
    if (!moved || !(error instanceof PlacementRefusal)) throw error
    // Sotto moved it, so it never refuses what would have run here: it comes back to This computer, and says so.
    return { hostId: local.hostId, projectId: project.projectId,
      receipt: receipt(local, `This computer is ${moved.state}, so Sotto tried ${named(moved.machine)}, which has room, but could not start this one there, so it started on This computer.`) }
  }
  return { hostId: target.hostId, projectId: found.projectId, receipt: { ...receipt(target, note, found.note), ...found.setUp ? { setUp: found.setUp } : {} } }
}

/**
 * The connected machine with the most CPU to spare, when This computer is busy or short on memory and that machine is
 * neither (#1690), with the sentence that says why. Undefined when This computer has room, or a load reads unknown.
 */
async function roomElsewhere(local: PlacementMachine, machines: readonly PlacementMachine[], sources: PlacementSources)
  : Promise<{ machine: PlacementMachine; state: string; why: string } | undefined> {
  const load = sources.load
  if (!load) return undefined
  const here = await load(local.hostId).catch(() => null)
  if (!here || here.cpu === 'unknown' || here.memory === 'unknown' || here.cpu === 'not-busy' && here.memory === 'enough') return undefined
  const others = machines.filter(machine => !machine.thisComputer && machine.connected)
  const loads = await Promise.all(others.map(machine => load(machine.hostId).catch(() => null)))
  const chosen = others.flatMap((machine, index) => {
    const there = loads[index]
    return there && there.cpu === 'not-busy' && there.memory === 'enough' && there.cpuBusyPercent !== null ? [{ machine, busy: there.cpuBusyPercent }] : []
  }).sort((a, b) => a.busy - b.busy)[0]?.machine
  if (!chosen) return undefined
  const state = here.memory === 'short' && here.cpu === 'busy' ? 'busy and short on memory' : here.memory === 'short' ? 'short on memory' : 'busy'
  return { machine: chosen, state, why: `This computer is ${state}, so Sotto started this one on ${named(chosen)}, which has room.` }
}

interface FoundProject { readonly projectId: string; readonly setUp?: NonNullable<WorkerPlacementReceipt['setUp']>; readonly note?: string }

/**
 * The project on `target` that is a copy of the same GitHub repository as `projectId` on `from`. A machine with none gets
 * one set up (#1690), and what that did rides along for the receipt.
 */
async function sameProject(from: PlacementMachine, target: PlacementMachine, projectId: string, sources: PlacementSources): Promise<FoundProject> {
  const title = sources.projects(from.hostId).find(item => item.id === projectId)?.title
    ?? refuse('UNKNOWN_TARGET', 'That project is unavailable. Read the project list again. Nothing was started.')
  const read = async (machine: PlacementMachine, update: string) => {
    let origins: ProjectOrigins | undefined
    try { origins = await sources.origins(machine.hostId) } catch {
      refuse('HOST_DISCONNECTED', `Sotto could not read which projects ${named(machine)} has just now. Nothing was started. Try again.`, true)
    }
    return origins ?? refuse('HOST_FEATURE_UNAVAILABLE', update)
  }
  const fromOrigins = await read(from, `${capital(named(from))} cannot say which repository its projects are copies of. Update Sotto on it, or name a project on ${named(target)} from list_projects. Nothing was started.`)
  const repository = fromOrigins.projects.find(item => item.projectId === projectId)?.repository
  if (!repository) refuse('UNKNOWN_TARGET', `${title} has no GitHub origin on ${named(from)}, so Sotto cannot find its copy on ${named(target)}. Name a project on ${named(target)} from list_projects. Nothing was started.`)
  const targetOrigins = await read(target, `${capital(named(target))} cannot say which repository its projects are copies of. Update Sotto on it, or name one of its projects from list_projects. Nothing was started.`)
  const there = sources.projects(target.hostId)
  const copies = there.filter(item => targetOrigins.projects.some(origin => origin.projectId === item.id && origin.repository && sameRepository(origin.repository, repository)))
  if (copies.length) return { projectId: (copies.find(item => item.title === title) ?? copies[0]!).id }
  return setUpCopy(target, title, repository, sources)
}

/** Gives `target` a copy of the repository through its host (#1690), or refuses in plain words saying what to do. */
async function setUpCopy(target: PlacementMachine, title: string, repository: ProjectSetupRequest['repository'], sources: PlacementSources): Promise<FoundProject> {
  const machine = capital(named(target)), repo = `${repository.owner}/${repository.name}`
  let result: ProjectSetupResult | undefined
  try { result = await sources.setUp?.(target.hostId, { repository: { host: repository.host, owner: repository.owner, name: repository.name }, title }) } catch {
    refuse('HOST_DISCONNECTED', `${machine} has no copy of ${title}, and Sotto could not reach it to set one up. Nothing was started. Try again.`, true)
  }
  if (!result) refuse('HOST_FEATURE_UNAVAILABLE', `${machine} has no copy of ${title}, and its Sotto is too old to set one up. Update Sotto on it, or add the project there. Nothing was started.`)
  if (!result.ok) refuse('UNKNOWN_TARGET', `${machine} has no copy of ${title}, and Sotto could not set one up. ${result.message} Nothing was started.`)
  const setUp = { how: result.how, path: result.path, current: result.current }
  const added = `Sotto added the copy of ${title} already at ${result.path} to ${named(target)}'s projects`
  const note = result.how === 'cloned' ? `${machine} had no copy of ${title}, so Sotto cloned ${repo} into ${result.path} there.`
    : result.current ? `${added} and brought it up to date.`
      : `${added}; it was left as it was because ${result.reason ?? 'Sotto could not bring it up to date'}, so the worker starts from that checkout's commit.`
  return { projectId: result.projectId, setUp, note }
}
