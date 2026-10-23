import type { AgentProject } from '../../shared/agents'
import type { HostOsFamily } from '../../shared/hostFacts'
import type { WatcherRefusal } from '../../shared/watcher'
import { WORKER_SYSTEM_WORDS, type ProjectOrigins, type WorkerMachineSetting, type WorkerPlacementReceipt, type WorkerSystem } from '../../shared/workerMachine'
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
 *   connected, or no longer saved, starts the worker on This computer instead, and the receipt says why.
 *
 * On another machine than the project was named on, the project is found by its GitHub origin (`sameRepository`). A
 * machine with no copy refuses in plain words; Sotto never clones. A machine whose host cannot say its projects'
 * repositories refuses with what to do. Nothing here starts anything: it answers where, or refuses.
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
}
export interface PlacementAsk { readonly machine?: string | undefined; readonly os?: WorkerSystem | undefined }
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
  let target: PlacementMachine, note: string | undefined
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
  } else if (project.hostId !== local.hostId || defaultId === undefined || defaultId === local.hostId) {
    // A project named on another machine is placed there, as Watcher has always placed work; so is Watcher's own choice.
    target = from ?? { hostId: project.hostId, name: 'Paired machine', thisComputer: false, connected: false }
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
  const receipt = { hostId: target.hostId, name: named(target), awayFromDefault, ...defaultName ? { defaultName } : {}, ...note ? { note } : {} }
  if (target.hostId === project.hostId) return { hostId: target.hostId, projectId: project.projectId, receipt }
  if (!from) refuse('UNKNOWN_TARGET', 'That project is unavailable. Read the project list again. Nothing was started.')
  return { hostId: target.hostId, projectId: await sameProject(from, target, project.projectId, sources), receipt }
}

/** The project on `target` that is a copy of the same GitHub repository as `projectId` on `from`. */
async function sameProject(from: PlacementMachine, target: PlacementMachine, projectId: string, sources: PlacementSources): Promise<string> {
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
  // Sotto never clones on its own: a machine with no copy refuses, and says how to give it one.
  if (!copies.length) refuse('UNKNOWN_TARGET', `${capital(named(target))} has no copy of ${title}. Add the project on ${named(target)} first. Nothing was started.`)
  return (copies.find(item => item.title === title) ?? copies[0]!).id
}
