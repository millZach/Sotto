import { MACHINE_LOAD_THRESHOLDS } from '../../../shared/hostFacts'
import { MACHINE_FACTS_OLDER } from '../../../shared/watcher'
import type { NewWorkersStart } from '../../../shared/workerMachine'
import type { WatcherMachine } from '../../../shared/watcherRoom'
import { THIS_COMPUTER, WORKING_THREADS_CAUTION, WORKING_THREADS_QUIET_MAX } from '../../../shared/workingThreads'

/**
 * The machines line under Watcher's header (#1032, Zach's pick D "Names" on October 23, 2026): "This computer 2 working ·
 * forge 3 working". Each machine's name opens its panel. A problem only adds words after that machine's count, in the
 * order the prototype set: more than ten working, busy, short on memory, load unknown; a machine not connected says
 * only that. Names and counts never change colour. No pills, chips or meters (ADR-0110).
 */
export interface MachineEntry {
  /** The machine's host ID; This computer's own. */
  readonly hostId: string
  /** "This computer", or the name the user saved for the machine. */
  readonly name: string
  readonly thisComputer: boolean
  readonly connected: boolean
  /** Working threads there, counted from the window's own thread list (`workingThreadsByMachine`). */
  readonly working: number
  /** Work placed but not started there, as its host counts it (#1311); 0 when it does not say. */
  readonly starting: number
  /** The words a problem adds after the count, in order; empty when nothing is wrong. */
  readonly words: readonly string[]
  /** Whether new workers start here: the default machine Settings names. */
  readonly isDefault: boolean
  readonly machine: WatcherMachine | null
}

export const MACHINE_WORDS = {
  notConnected: 'not connected',
  over: 'may slow down',
  busy: 'busy',
  short: 'short on memory',
  unknown: 'load unknown',
} as const

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

/** The words a machine's problems add after its count, empty when nothing is wrong. */
export function machineWords(machine: WatcherMachine | null, working: number): readonly string[] {
  if (machine !== null && (!machine.connected || machine.factsState === 'not-connected')) return [MACHINE_WORDS.notConnected]
  const words: string[] = []
  if (working > WORKING_THREADS_QUIET_MAX) words.push(MACHINE_WORDS.over)
  if (machine === null) return words
  if (machine.cpuState === 'busy') words.push(MACHINE_WORDS.busy)
  if (machine.memoryState === 'short') words.push(MACHINE_WORDS.short)
  if (loadUnknown(machine)) words.push(MACHINE_WORDS.unknown)
  return words
}

/** The machine new workers start on, by host ID, or null when Watcher chooses or nothing has been read. */
export function defaultMachineId(start: NewWorkersStart | undefined, thisComputerId: string | undefined): string | null {
  if (start === undefined || start.choice === 'watcher') return null
  if (start.choice === 'this-computer') return thisComputerId ?? null
  return start.hostId ?? null
}

/**
 * The line's machines, This computer first and then the others in the order main lists them. Before the first read, or
 * when it fails, This computer stands alone with its count, so the line is never empty.
 */
export function machineEntries(machines: readonly WatcherMachine[] | null, working: ReadonlyMap<string, number>, start?: NewWorkersStart): readonly MachineEntry[] {
  const local = machines?.find(machine => machine.thisComputer)
  const defaultId = defaultMachineId(start, local?.hostId)
  const entry = (machine: WatcherMachine | null, thisComputer: boolean): MachineEntry => {
    const count = working.get(thisComputer ? THIS_COMPUTER : machine!.hostId) ?? 0
    const connected = thisComputer || (machine?.connected === true && machine.factsState !== 'not-connected')
    return { hostId: machine?.hostId ?? THIS_COMPUTER, name: thisComputer ? 'This computer' : machine!.name, thisComputer, connected,
      working: count, starting: connected ? machine?.placedNotStarted ?? 0 : 0, words: machineWords(machine, count),
      isDefault: machine !== null && machine.hostId === defaultId, machine }
  }
  return [entry(local ?? null, true), ...(machines ?? []).filter(machine => !machine.thisComputer).map(machine => entry(machine, false))]
}

/** "3 working", or "3 working, 1 starting" while work placed there has not begun; nothing for a machine not connected. */
export function countWords(entry: MachineEntry, withStarting = true): string {
  if (!entry.connected) return ''
  return `${entry.working} working${withStarting && entry.starting > 0 ? `, ${entry.starting} starting` : ''}`
}

/** One machine as the line reads it, in words: "forge 3 working, busy", "forge not connected". */
export function lineText(entry: MachineEntry, withStarting = true): string {
  const count = countWords(entry, withStarting)
  const words = entry.words.join(', ')
  if (!count) return words ? `${entry.name} ${words}` : entry.name
  return words ? `${entry.name} ${count}, ${words}` : `${entry.name} ${count}`
}

/** What a press on a machine's name does, with what the line shows of it first, for its accessible name. */
export function machineLabel(entry: MachineEntry, withStarting = true): string {
  const parts = [entry.name, countWords(entry, withStarting), ...entry.words].filter(Boolean)
  const whose = entry.thisComputer ? 'this computer’s' : `${entry.name}’s`
  return `${parts.join(', ')}. Show ${whose} load and what runs there.`
}

/**
 * The line in a narrow room (Zach, October 23, 2026): no "starting" counts, and only the machines with a problem, then a
 * count of the rest. With nothing wrong anywhere, This computer stands for the rest. All of them, when they are few
 * enough to fit anyway, is the wide line's business, not this one's.
 */
export function shortLine(entries: readonly MachineEntry[]): { readonly shown: readonly MachineEntry[]; readonly more: number } {
  const troubled = entries.filter(entry => entry.words.length > 0)
  const shown = troubled.length > 0 ? troubled : entries.slice(0, 1)
  return { shown, more: entries.length - shown.length }
}

const GIB = 1024 ** 3
/** Memory as the panel and Settings say it: "41 GB", "1.6 GB". */
export function memoryWords(bytes: number): string {
  const gb = bytes / GIB
  return `${gb >= 10 ? Math.round(gb) : Math.round(gb * 10) / 10} GB`
}

/** How long ago a reading was taken: "6 s ago", "3 min ago". */
export function agoWords(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds} s ago`
  const minutes = Math.round(seconds / 60)
  return minutes < 60 ? `${minutes} min ago` : `${Math.round(minutes / 60)} h ago`
}

/** The span a CPU reading covers: "the last 2 seconds", "the last minute". */
export function windowWords(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000))
  if (seconds < 60) return `the last ${seconds} second${seconds === 1 ? '' : 's'}`
  const minutes = Math.round(seconds / 60)
  return minutes === 1 ? 'the last minute' : `the last ${minutes} minutes`
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

/**
 * Why a machine's load reads unknown, in a sentence for its panel, or null when it is known. A machine never reads idle
 * for want of a reading: Watcher treats it as unknown.
 */
export function unknownWhy(entry: MachineEntry, now: number): string | null {
  const machine = entry.machine
  if (machine === null || !entry.connected || !partlyUnknown(machine)) return null
  const name = entry.thisComputer ? 'This computer' : entry.name
  const whose = entry.thisComputer ? 'this computer’s' : `${entry.name}’s`
  if (machine.factsState === 'unknown') {
    return machine.note === MACHINE_FACTS_OLDER
      ? `${name} runs an older Sotto host that does not report its load. Watcher treats it as unknown, never idle. Update it in Settings, under Hosts & phones.`
      : `Sotto could not read ${whose} load just now. Watcher treats it as unknown, never idle. It reads again when you open this.`
  }
  const load = machine.load ?? null
  if (load === null) return `${name} runs an older Sotto host that does not report its load. Watcher treats it as unknown, never idle. Update it in Settings, under Hosts & phones.`
  const age = now - Date.parse(load.observedAt)
  if (Number.isFinite(age) && Math.abs(age) > MACHINE_LOAD_THRESHOLDS.staleAfterMs) {
    return `The last reading is ${agoWords(Math.abs(age))}, older than a minute, so Watcher treats ${whose} load as unknown, not idle.`
  }
  if (load.cpuBusyPercent === null) return `${name} does not report how busy its processors are, so Watcher treats its load as unknown, not idle.`
  if (load.availableMemoryBytes === null) return `${name} does not report the memory a new process could have, so Watcher treats its memory as unknown, not plentiful.`
  return `${name}’s memory changed during the reading, so Watcher treats it as unknown until the next one.`
}

/** The warning above ten, in the panel: this computer's own sentence, or another machine's. */
export function overWords(entry: MachineEntry): string | null {
  if (entry.working <= WORKING_THREADS_QUIET_MAX) return null
  return entry.thisComputer ? `More than ten threads are working on this computer. ${WORKING_THREADS_CAUTION} Nothing is stopped or held back.`
    : `More than ten threads are working on ${entry.name}. It may slow down. Nothing is stopped or held back.`
}
