import { z } from 'zod'

/**
 * Host facts: what kind of machine a host is, read at one observation time (#1031). Numbers and the
 * operating system's own name only, never a user name, path or network address. A fact the machine
 * could not give is null, never guessed.
 *
 * Unknown keys are dropped rather than refused, and an operating system family this build does not
 * know reads as null, so a later host that reports more still reads on an older desktop.
 */
export const HOST_FACTS_TEXT_MAX = 200
export const HOST_FACTS_CPU_COUNT_MAX = 65_536

const text = z.string().min(1).max(HOST_FACTS_TEXT_MAX)
const bytes = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)

export const HOST_OS_FAMILIES = ['windows', 'macos', 'linux'] as const
export const hostOsFamilySchema = z.enum(HOST_OS_FAMILIES)
export type HostOsFamily = z.infer<typeof hostOsFamilySchema>

export const hostOsSchema = z.object({
  family: hostOsFamilySchema.nullable().catch(null),
  /** The system's own name: "Windows 11", "macOS", or a Linux distribution's PRETTY_NAME as it gives it. */
  name: text.nullable(),
  /** Windows' kernel release ("10.0.26200"), macOS's marketing version ("15.3"), a distribution's VERSION_ID. */
  version: text.nullable(),
})
export type HostOs = z.infer<typeof hostOsSchema>

export const hostFactsSchema = z.object({
  observedAt: z.string().datetime(),
  os: hostOsSchema,
  /** The machine's architecture in Node's words ("x64", "arm64"), else as the system names it. */
  architecture: z.string().min(1).max(32).nullable(),
  totalMemoryBytes: bytes.nullable(),
  freeMemoryBytes: bytes.nullable(),
  logicalCpuCount: z.number().int().positive().max(HOST_FACTS_CPU_COUNT_MAX).nullable(),
})
export type HostFacts = z.infer<typeof hostFactsSchema>

/**
 * How often a host reads its memory again when facts are asked for. Asking more often answers the last reading, so a
 * busy reader costs nothing; nothing reads on a timer.
 */
export const HOST_FACTS_REFRESH_MS = 5_000
/** More running threads than any machine holds reads unknown rather than refusing the whole report. */
export const HOST_RUNNING_THREADS_MAX = 100_000

/**
 * Live load (#1311): how busy a machine is now, as numbers over one window ending at one observation time. A host reads
 * it when facts are asked for, from two samples at least `HOST_LOAD_SAMPLE_MS` apart, and keeps the last reading; nothing
 * reads on a timer. A number the machine cannot give honestly is null, never guessed:
 * - `cpuBusyPercent`: the share of all CPU time over the window not spent idle, from the CPUs' own counters.
 * - `loadAverage`: the one-minute load average. Windows has none.
 * - `availableMemoryBytes`: memory a new process could have now, the cache and standby the system gives back counted in.
 *   On macOS the counters Node reads count only free pages and understate it, so it reads unknown there.
 * - `windowStartAvailableMemoryBytes`: the same at the window's start, so "short on two readings" needs no history.
 * - `memoryPressurePercent`: Linux's own memory pressure, the share of the last ten seconds some task waited on memory.
 */
export const HOST_LOAD_SAMPLE_MS = 2_000
/** A starting sample older than this is too old to say how busy the machine is now; the host samples twice instead. */
export const HOST_LOAD_WINDOW_MAX_MS = 60_000
const percent = z.number().min(0).max(100)

export const hostLoadSchema = z.object({
  observedAt: z.string().datetime(),
  windowMs: z.number().int().positive().max(24 * 60 * 60_000),
  cpuBusyPercent: percent.nullable(),
  loadAverage: z.number().nonnegative().max(HOST_FACTS_CPU_COUNT_MAX * 1_000).nullable(),
  availableMemoryBytes: bytes.nullable(),
  windowStartAvailableMemoryBytes: bytes.nullable(),
  memoryPressurePercent: percent.nullable(),
})
export type HostLoad = z.infer<typeof hostLoadSchema>

/**
 * Where a machine's live load starts to count against placing work there (#1311), in one place so they can be tuned on
 * the laptop and forge. Short on memory: available memory under the smaller of `shortMemoryBytes` and `shortMemoryShare`
 * of the total (Zach, October 23, 2026), on both readings of the window, so a large machine is not short with gigabytes
 * free and a small one is not short at a tenth of very little. Without a total, `shortMemoryBytes` alone. Busy: CPU busy
 * above `busyCpuPercent` over the window. A reading older than `staleAfterMs` is unknown, not idle.
 */
export const MACHINE_LOAD_THRESHOLDS = {
  shortMemoryBytes: 2 * 1024 ** 3,
  shortMemoryShare: 0.1,
  busyCpuPercent: 85,
  staleAfterMs: 60_000,
} as const

export type MachineMemoryState = 'short' | 'enough' | 'unknown'
export type MachineCpuState = 'busy' | 'not-busy' | 'unknown'

/**
 * What a machine's live load says for placing work, at `now`. An absent or stale reading is unknown on both counts. A
 * reading from more than `staleAfterMs` ahead of `now` is unknown too, since the two clocks cannot both be right.
 */
export function machineLoadStates(load: HostLoad | null, totalMemoryBytes: number | null, now: number, thresholds = MACHINE_LOAD_THRESHOLDS): { memory: MachineMemoryState; cpu: MachineCpuState } {
  const observed = load ? Date.parse(load.observedAt) : Number.NaN
  if (!load || !Number.isFinite(observed) || Math.abs(now - observed) > thresholds.staleAfterMs) return { memory: 'unknown', cpu: 'unknown' }
  const floor = totalMemoryBytes === null ? thresholds.shortMemoryBytes : Math.min(thresholds.shortMemoryBytes, totalMemoryBytes * thresholds.shortMemoryShare)
  const short = (bytes: number) => bytes < floor
  const end = load.availableMemoryBytes, start = load.windowStartAvailableMemoryBytes
  // One short reading is not enough to call a machine short, and a missing reading cannot second it.
  const memory: MachineMemoryState = end === null ? 'unknown' : !short(end) ? 'enough' : start === null ? 'unknown' : short(start) ? 'short' : 'enough'
  const cpu: MachineCpuState = load.cpuBusyPercent === null ? 'unknown' : load.cpuBusyPercent > thresholds.busyCpuPercent ? 'busy' : 'not-busy'
  return { memory, cpu }
}

const threadCount = z.number().int().nonnegative().max(HOST_RUNNING_THREADS_MAX).nullable().catch(null)

/**
 * What the optional `host-facts` feature answers (#1031): the machine's facts, how many of the host's threads are running a
 * turn now, its live load and its work placed but not started (#1311): threads sent work on this host whose turn has not
 * begun, so two starts seconds apart do not both count the same free memory. Read leniently, as the facts are, so a later
 * host's additions still read on an older desktop; an older host sends no load and no placed work, and both read unknown.
 */
export const hostMachineReportSchema = z.object({
  facts: hostFactsSchema,
  runningThreads: threadCount,
  load: hostLoadSchema.nullable().catch(null),
  placedNotStarted: threadCount,
})
export type HostMachineReport = z.infer<typeof hostMachineReportSchema>
