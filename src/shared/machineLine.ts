import { MACHINE_LOAD_THRESHOLDS } from './hostFacts'
import { MACHINE_FACTS_OLDER } from './watcher'
import type { NewWorkersStart } from './workerMachine'
import type { WatcherMachine } from './watcherRoom'
import { THIS_COMPUTER, WORKING_THREADS_QUIET_MAX } from './workingThreads'

/**
 * The machines line under Watcher's header (#1032, Zach's pick D "Names" on October 23, 2026): "This computer 2 working ·
 * forge 3 working". Each machine's name opens its panel. A problem only adds words after that machine's count, in the
 * order the prototype set: more than ten working, busy, short on memory, load unknown; a machine not connected says
 * only that. Names and counts never change colour. No pills, chips or meters (ADR-0110).
 *
 * What the line is made of lives here, for the window and for the iPhone's page main projects. The window says it in the
 * interface language (`src/renderer/src/watcher/machineWords.ts`, ADR-0123); what main sends the iPhone stays in the
 * host's English, as ADR-0123 has it for text a host sends.
 */
export interface MachineEntry {
  /** The machine's host ID; This computer's own. */
  readonly hostId: string
  /** "This computer", or the name the user saved for the machine. The window says This computer in its own language. */
  readonly name: string
  readonly thisComputer: boolean
  readonly connected: boolean
  /** Working threads there, counted from the window's own thread list (`workingThreadsByMachine`). */
  readonly working: number
  /** Work placed but not started there, as its host counts it (#1311); 0 when it does not say. */
  readonly starting: number
  /** The problems whose words follow the count, in the line's order; empty when nothing is wrong. */
  readonly problems: readonly MachineProblem[]
  /** Whether new workers start here: the default machine Settings names. */
  readonly isDefault: boolean
  readonly machine: WatcherMachine | null
}

/** What can be wrong with a machine, in the order the line says it: may slow down, busy, short on memory, load unknown. */
export type MachineProblem = 'not-connected' | 'over' | 'busy' | 'short' | 'unknown'

const cpuUnknown = (machine: WatcherMachine): boolean => (machine.cpuState ?? 'unknown') === 'unknown'
const memoryUnknown = (machine: WatcherMachine): boolean => (machine.memoryState ?? 'unknown') === 'unknown'
/**
 * Whether the line says a machine's load is unknown: only when its CPU and its memory both are (Zach, October 23, 2026),
 * as for a reading over a minute old, an older host, or a list without load at all. A Mac, which reports its CPU and not
 * its memory, says "busy" from its CPU, and its panel says the memory is unknown.
 */
export function loadUnknown(machine: WatcherMachine): boolean {
  return cpuUnknown(machine) && memoryUnknown(machine)
}
/** Whether any half of a machine's load is unknown, for its panel to say why. */
export function partlyUnknown(machine: WatcherMachine): boolean {
  return cpuUnknown(machine) || memoryUnknown(machine)
}

/** A machine's problems, in the line's order, empty when nothing is wrong. */
export function machineProblems(machine: WatcherMachine | null, working: number): readonly MachineProblem[] {
  if (machine !== null && (!machine.connected || machine.factsState === 'not-connected')) return ['not-connected']
  const problems: MachineProblem[] = []
  if (working > WORKING_THREADS_QUIET_MAX) problems.push('over')
  if (machine === null) return problems
  if (machine.cpuState === 'busy') problems.push('busy')
  if (machine.memoryState === 'short') problems.push('short')
  if (loadUnknown(machine)) problems.push('unknown')
  return problems
}

/** The machine new workers start on, by host ID, or null when Watcher chooses or nothing has been read. */
export function defaultMachineId(start: NewWorkersStart | undefined, thisComputerId: string | undefined): string | null {
  if (start === undefined || start.choice === 'watcher') return null
  if (start.choice === 'this-computer') return thisComputerId ?? null
  return start.hostId ?? null
}

/**
 * The line's machines: This computer first, then each machine this computer has paired with in the order Settings lists
 * them, then any other the last read named. Whether a machine is connected comes from the saved hosts, which main keeps
 * current; its facts and load come from the last read, which happens only when Watcher places work or the user opens a
 * machine's numbers, so a connected machine that read as not connected then has no facts yet, not "not connected". Before
 * any read, This computer stands alone with its count unless machines are saved, so the line is never empty.
 */
export function machineEntries(machines: readonly WatcherMachine[] | null, working: ReadonlyMap<string, number>, start?: NewWorkersStart,
  saved?: readonly { readonly hostId: string; readonly name: string; readonly connected: boolean }[]): readonly MachineEntry[] {
  const local = machines?.find(machine => machine.thisComputer)
  const defaultId = defaultMachineId(start, local?.hostId)
  const readAs = (machine: WatcherMachine | null): boolean => machine !== null && machine.connected && machine.factsState !== 'not-connected'
  const entry = (hostId: string, name: string, machine: WatcherMachine | null, thisComputer: boolean, connected: boolean): MachineEntry => {
    const count = working.get(thisComputer ? THIS_COMPUTER : hostId) ?? 0
    const facts = connected && readAs(machine) ? machine : null
    return { hostId, name, thisComputer, connected, working: count, starting: connected ? facts?.placedNotStarted ?? 0 : 0,
      problems: connected ? machineProblems(facts, count) : ['not-connected'], isDefault: hostId === defaultId, machine: connected ? facts : null }
  }
  const others = (machines ?? []).filter(machine => !machine.thisComputer)
  const remotes = saved === undefined ? others.map(machine => entry(machine.hostId, machine.name, machine, false, readAs(machine)))
    : [...saved.map(host => entry(host.hostId, host.name, others.find(machine => machine.hostId === host.hostId) ?? null, false, host.connected)),
      ...others.filter(machine => !saved.some(host => host.hostId === machine.hostId)).map(machine => entry(machine.hostId, machine.name, machine, false, readAs(machine)))]
  return [entry(local?.hostId ?? THIS_COMPUTER, 'This computer', local ?? null, true, true), ...remotes]
}

/**
 * The line in a narrow room or on a phone (Zach, October 23, 2026): no "starting" counts, and only the machines with a
 * problem, then a count of the rest. With nothing wrong anywhere no machine is named, and how many there are and how much
 * works on them stands for them all ("3 machines, 5 working", approved by Zach on October 23); This computer alone is
 * named, since there is nothing else to count. All of them, when they are few enough to fit anyway, is the wide line's
 * business, not this one's.
 */
export function shortLine(entries: readonly MachineEntry[]): { readonly shown: readonly MachineEntry[]; readonly more: number } {
  const troubled = entries.filter(entry => entry.problems.length > 0)
  const shown = troubled.length > 0 || entries.length > 1 ? troubled : entries
  return { shown, more: entries.length - shown.length }
}

/** The system a machine runs, as the panel and Settings name it: "Windows 11", "Omarchy (Linux)", "macOS 15.3". */
export function systemWords(machine: WatcherMachine): string | null {
  const os = machine.facts?.os
  if (!os) return null
  const name = os.name ?? (os.family === 'windows' ? 'Windows' : os.family === 'macos' ? 'macOS' : os.family === 'linux' ? 'Linux' : null)
  if (name === null) return null
  if (os.family === 'linux' && !/linux/iu.test(name)) return `${name} (Linux)`
  if (os.family === 'macos' && os.version && name === 'macOS') return `macOS ${os.version}`
  return name
}

/** Why a machine's load, or half of it, reads unknown: what its panel explains. */
export type UnknownReason =
  | { readonly kind: 'older-host' }
  | { readonly kind: 'unread' }
  | { readonly kind: 'stale'; readonly ageMs: number }
  | { readonly kind: 'cpu-unreported' }
  | { readonly kind: 'memory-unreported' }
  | { readonly kind: 'memory-changed' }

/**
 * Why a machine's load reads unknown, or null when it is known. A machine never reads idle for want of a reading:
 * Watcher treats it as unknown.
 */
export function unknownReason(entry: MachineEntry, now: number): UnknownReason | null {
  const machine = entry.machine
  if (machine === null || !entry.connected || !partlyUnknown(machine)) return null
  if (machine.factsState === 'unknown') return machine.note === MACHINE_FACTS_OLDER ? { kind: 'older-host' } : { kind: 'unread' }
  const load = machine.load ?? null
  if (load === null) return { kind: 'older-host' }
  const age = now - Date.parse(load.observedAt)
  if (Number.isFinite(age) && Math.abs(age) > MACHINE_LOAD_THRESHOLDS.staleAfterMs) return { kind: 'stale', ageMs: Math.abs(age) }
  if (load.cpuBusyPercent === null) return { kind: 'cpu-unreported' }
  if (load.availableMemoryBytes === null) return { kind: 'memory-unreported' }
  return { kind: 'memory-changed' }
}

/** "6 s ago", "3 min ago": the host's English for the phone. */
function englishAgo(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds} s ago`
  const minutes = Math.round(seconds / 60)
  return minutes < 60 ? `${minutes} min ago` : `${Math.round(minutes / 60)} h ago`
}

/**
 * Why a machine's load reads unknown, in the sentence the iPhone's panel shows, or null when it is known. In the host's
 * English: the iPhone shows text a host sends as it was sent (ADR-0123). The window says it in its own language.
 */
export function unknownWhy(entry: MachineEntry, now: number): string | null {
  const reason = unknownReason(entry, now)
  if (reason === null) return null
  const name = entry.thisComputer ? 'This computer' : entry.name
  const whose = entry.thisComputer ? 'this computer’s' : `${entry.name}’s`
  switch (reason.kind) {
    case 'older-host': return `${name} runs an older Sotto host that does not report its load. Watcher treats it as unknown, never idle. Update it in Settings, under Hosts & phones.`
    case 'unread': return `Sotto could not read ${whose} load just now. Watcher treats it as unknown, never idle. It reads again when you open this.`
    case 'stale': return `The last reading is ${englishAgo(reason.ageMs)}, older than a minute, so Watcher treats ${whose} load as unknown, not idle.`
    case 'cpu-unreported': return `${name} does not report how busy its processors are, so Watcher treats its load as unknown, not idle.`
    case 'memory-unreported': return `${name} does not report the memory a new process could have, so Watcher treats its memory as unknown, not plentiful.`
    case 'memory-changed': return `${name}’s memory changed during the reading, so Watcher treats it as unknown until the next one.`
  }
}
