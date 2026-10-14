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
