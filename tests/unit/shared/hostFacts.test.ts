import { describe, expect, it } from 'vitest'
import { hostFactsSchema, hostMachineReportSchema, machineLoadStates, MACHINE_LOAD_THRESHOLDS } from '../../../src/shared/hostFacts'

const facts = {
  observedAt: '2026-10-14T12:00:00.000Z',
  os: { family: 'linux', name: 'Omarchy', version: null },
  architecture: 'x64',
  totalMemoryBytes: 34_359_738_368,
  freeMemoryBytes: 20_000_000_000,
  logicalCpuCount: 16,
}

describe('hostFactsSchema', () => {
  it('accepts facts with every unknown as null', () => {
    const unknown = { observedAt: facts.observedAt, os: { family: null, name: null, version: null },
      architecture: null, totalMemoryBytes: null, freeMemoryBytes: null, logicalCpuCount: null }
    expect(hostFactsSchema.parse(unknown)).toEqual(unknown)
  })

  it('drops a fact a later host adds and reads a family it does not know as unknown', () => {
    const later = { ...facts, loadAverage: 1.5, os: { ...facts.os, family: 'freebsd', kernel: '14.1' } }
    expect(hostFactsSchema.parse(later)).toEqual({ ...facts, os: { family: null, name: 'Omarchy', version: null } })
  })

  it('refuses a missing observation time, negative memory and a zero CPU count', () => {
    expect(hostFactsSchema.safeParse({ ...facts, observedAt: undefined }).success).toBe(false)
    expect(hostFactsSchema.safeParse({ ...facts, freeMemoryBytes: -1 }).success).toBe(false)
    expect(hostFactsSchema.safeParse({ ...facts, logicalCpuCount: 0 }).success).toBe(false)
  })

  it('refuses an empty or oversized name', () => {
    expect(hostFactsSchema.safeParse({ ...facts, os: { ...facts.os, name: '' } }).success).toBe(false)
    expect(hostFactsSchema.safeParse({ ...facts, os: { ...facts.os, name: 'x'.repeat(201) } }).success).toBe(false)
  })
})

describe('hostMachineReportSchema', () => {
  it('reads a later host’s report, dropping what it adds, and an unreadable running count as unknown', () => {
    const unknownLoad = { load: null, placedNotStarted: null }
    expect(hostMachineReportSchema.parse({ facts, runningThreads: 2, queued: 4 })).toEqual({ facts, runningThreads: 2, ...unknownLoad })
    expect(hostMachineReportSchema.parse({ facts, runningThreads: -1 })).toEqual({ facts, runningThreads: null, ...unknownLoad })
    expect(hostMachineReportSchema.parse({ facts })).toEqual({ facts, runningThreads: null, ...unknownLoad })
  })

  it('refuses a report without facts', () => {
    expect(hostMachineReportSchema.safeParse({ runningThreads: 1 }).success).toBe(false)
  })
})

const load = {
  observedAt: '2026-10-14T12:00:00.000Z',
  windowMs: 2_000,
  cpuBusyPercent: 40,
  loadAverage: null,
  availableMemoryBytes: 8 * 1024 ** 3,
  windowStartAvailableMemoryBytes: 8 * 1024 ** 3,
  memoryPressurePercent: null,
}

describe('live load in the machine report (#1311)', () => {
  it('reads an older host’s report, which has no load and no placed work, as unknown', () => {
    expect(hostMachineReportSchema.parse({ facts, runningThreads: 1 })).toEqual({ facts, runningThreads: 1, load: null, placedNotStarted: null })
  })

  it('reads a load it cannot make sense of as unknown and keeps the rest', () => {
    expect(hostMachineReportSchema.parse({ facts, runningThreads: 1, load: { ...load, cpuBusyPercent: 140 }, placedNotStarted: 2 }))
      .toEqual({ facts, runningThreads: 1, load: null, placedNotStarted: 2 })
    expect(hostMachineReportSchema.parse({ facts, runningThreads: 1, load: { ...load, observedAt: 'soon' } }).load).toBeNull()
  })

  it('drops what a later host adds to its load', () => {
    expect(hostMachineReportSchema.parse({ facts, runningThreads: 0, load: { ...load, swapBytes: 1 }, placedNotStarted: 0 }).load).toEqual(load)
  })
})

describe('machineLoadStates', () => {
  const at = Date.parse(load.observedAt)
  const total = 32 * 1024 ** 3
  const GIB = 1024 ** 3

  it('reads a fresh, quiet machine as having enough memory and not busy', () => {
    expect(machineLoadStates(load, total, at + 1_000)).toEqual({ memory: 'enough', cpu: 'not-busy' })
  })

  it('reads a missing reading, and one over a minute old or ahead, as unknown, not idle', () => {
    expect(machineLoadStates(null, total, at)).toEqual({ memory: 'unknown', cpu: 'unknown' })
    expect(machineLoadStates(load, total, at + MACHINE_LOAD_THRESHOLDS.staleAfterMs + 1)).toEqual({ memory: 'unknown', cpu: 'unknown' })
    expect(machineLoadStates(load, total, at - MACHINE_LOAD_THRESHOLDS.staleAfterMs - 1)).toEqual({ memory: 'unknown', cpu: 'unknown' })
    expect(machineLoadStates(load, total, at + MACHINE_LOAD_THRESHOLDS.staleAfterMs)).toEqual({ memory: 'enough', cpu: 'not-busy' })
  })

  it('calls a machine busy above the CPU threshold', () => {
    expect(machineLoadStates({ ...load, cpuBusyPercent: MACHINE_LOAD_THRESHOLDS.busyCpuPercent }, total, at).cpu).toBe('not-busy')
    expect(machineLoadStates({ ...load, cpuBusyPercent: MACHINE_LOAD_THRESHOLDS.busyCpuPercent + 0.1 }, total, at).cpu).toBe('busy')
    expect(machineLoadStates({ ...load, cpuBusyPercent: null }, total, at).cpu).toBe('unknown')
  })

  it('calls a machine short on memory only on two short readings, under 2 GiB or a tenth of its memory', () => {
    const memory = (end: number | null, start: number | null, of: number | null = total) =>
      machineLoadStates({ ...load, availableMemoryBytes: end, windowStartAvailableMemoryBytes: start }, of, at).memory
    expect(memory(1.5 * GIB, 1.9 * GIB)).toBe('short')
    expect(memory(1.5 * GIB, 6 * GIB)).toBe('enough')
    expect(memory(1.5 * GIB, null)).toBe('unknown')
    expect(memory(null, 1 * GIB)).toBe('unknown')
    // A tenth of 32 GiB is 3.2 GiB: 3 GiB on both readings is short there, and enough on a 16 GiB machine.
    expect(memory(3 * GIB, 3 * GIB)).toBe('short')
    expect(memory(3 * GIB, 3 * GIB, 16 * GIB)).toBe('enough')
    // Without a total, only the fixed floor applies.
    expect(memory(3 * GIB, 3 * GIB, null)).toBe('enough')
  })
})
