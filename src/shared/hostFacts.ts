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
 * What the optional `host-facts` feature answers (#1031): the machine's facts and how many of the host's threads are
 * running a turn now. Read leniently, as the facts are, so a later host's additions still read on an older desktop.
 */
export const hostMachineReportSchema = z.object({
  facts: hostFactsSchema,
  runningThreads: z.number().int().nonnegative().max(HOST_RUNNING_THREADS_MAX).nullable().catch(null),
})
export type HostMachineReport = z.infer<typeof hostMachineReportSchema>
