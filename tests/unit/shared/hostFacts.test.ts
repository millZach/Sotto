import { describe, expect, it } from 'vitest'
import { HOST_RUNNING_THREADS_MAX, hostFactsSchema, hostMachineReportSchema, machineLoadStates, MACHINE_LOAD_THRESHOLDS, placedNotStartedWith } from '../../../src/shared/hostFacts'

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
    expect(hostMachineReportSchema.parse({ facts, runningThreads: 2, queued: 4 })).toEqual({ facts, runningThreads: 2 })
    expect(hostMachineReportSchema.parse({ facts, runningThreads: -1 })).toEqual({ facts, runningThreads: null })
    expect(hostMachineReportSchema.parse({ facts })).toEqual({ facts, runningThreads: null })
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
  it('keeps a report without load and placed work without them, as an older host or one with Work across machines off sends it', () => {
    expect(hostMachineReportSchema.parse({ facts, runningThreads: 1 })).toEqual({ facts, runningThreads: 1 })
  })

  it('reads a load it cannot make sense of as unknown and keeps the rest', () => {
    expect(hostMachineReportSchema.parse({ facts, runningThreads: 1, load: { ...load, cpuBusyPercent: 140 }, placedNotStarted: 2 }))
      .toEqual({ facts, runningThreads: 1, load: null, placedNotStarted: 2 })
    expect(hostMachineReportSchema.parse({ facts, runningThreads: 1, load: { ...load, observedAt: 'soon' } }).load).toBeNull()
    expect(hostMachineReportSchema.parse({ facts, runningThreads: 1, load, placedNotStarted: -2 }).placedNotStarted).toBeNull()
  })

  it('reads the placed thread IDs leniently: ones it cannot read are left out, and the count stands', () => {
    expect(hostMachineReportSchema.parse({ facts, runningThreads: 0, placedNotStarted: 1, placedThreadIds: ['a'] }).placedThreadIds).toEqual(['a'])
    const unreadable = hostMachineReportSchema.parse({ facts, runningThreads: 0, placedNotStarted: 1, placedThreadIds: [''] })
    expect(unreadable.placedThreadIds).toBeUndefined()
    expect(unreadable.placedNotStarted).toBe(1)
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

  it('calls a machine short on memory only on two short readings, under the smaller of 2 GiB and a tenth of its memory', () => {
    const memory = (end: number | null, start: number | null, of: number | null = total) =>
      machineLoadStates({ ...load, availableMemoryBytes: end, windowStartAvailableMemoryBytes: start }, of, at).memory
    expect(memory(1.5 * GIB, 1.9 * GIB)).toBe('short')
    expect(memory(1.5 * GIB, 6 * GIB)).toBe('enough')
    expect(memory(1.5 * GIB, null)).toBe('unknown')
    expect(memory(null, 1 * GIB)).toBe('unknown')
    // A tenth of 32 GiB is 3.2 GiB, more than 2 GiB, so 2 GiB holds: 3 GiB on both readings is enough there.
    expect(memory(3 * GIB, 3 * GIB)).toBe('enough')
    expect(memory(1.99 * GIB, 1.99 * GIB)).toBe('short')
    // On 64 GiB a tenth would be 6.4 GiB; 2 GiB still holds, so 4 GiB free is not short.
    expect(memory(4 * GIB, 4 * GIB, 64 * GIB)).toBe('enough')
    // On 8 GiB a tenth, 0.8 GiB, is the smaller: 1.5 GiB is enough there and 0.7 GiB is short.
    expect(memory(1.5 * GIB, 1.5 * GIB, 8 * GIB)).toBe('enough')
    expect(memory(0.7 * GIB, 0.7 * GIB, 8 * GIB)).toBe('short')
    // Without a total the line cannot be drawn, so short is never guessed: under 2 GiB reads unknown however low it is.
    expect(memory(1.5 * GIB, 1.5 * GIB, null)).toBe('unknown')
    expect(memory(0.1 * GIB, 0.1 * GIB, null)).toBe('unknown')
    expect(memory(null, null, null)).toBe('unknown')
    // The line is never above 2 GiB on any total, so 2 GiB or more at the window's end is enough without one.
    expect(memory(3 * GIB, 0.5 * GIB, null)).toBe('enough')
    expect(memory(2 * GIB, null, null)).toBe('enough')
  })
})

describe('a paired machine’s work placed but not started as the desktop reads it (#1311)', () => {
  const idle = () => false

  it('adds a start this desktop admitted there before the host can count it', () => {
    expect(placedNotStartedWith({ placedNotStarted: 0, placedThreadIds: [] }, ['started'], idle)).toBe(1)
    expect(placedNotStartedWith({ placedNotStarted: 2, placedThreadIds: ['a', 'b'] }, ['started', 'next'], idle)).toBe(4)
  })

  it('counts a start once the host counts it, by its Sotto thread ID', () => {
    expect(placedNotStartedWith({ placedNotStarted: 1, placedThreadIds: ['started'] }, ['started'], idle)).toBe(1)
    expect(placedNotStartedWith({ placedNotStarted: 2, placedThreadIds: ['started', 'other'] }, ['started', 'started'], idle)).toBe(2)
  })

  it('does not count a start the desktop already sees running there: its work has begun', () => {
    expect(placedNotStartedWith({ placedNotStarted: 0, placedThreadIds: [] }, ['started'], threadId => threadId === 'started')).toBe(0)
  })

  it('keeps an unknown count unknown, and takes an answer without IDs at its count', () => {
    expect(placedNotStartedWith({ placedNotStarted: null }, ['started'], idle)).toBeNull()
    expect(placedNotStartedWith({}, ['started'], idle)).toBeNull()
    expect(placedNotStartedWith({ placedNotStarted: 1 }, ['started'], idle)).toBe(1)
    expect(placedNotStartedWith({ placedNotStarted: 3, placedThreadIds: [] }, [], idle)).toBe(3)
  })

  it('reads unknown above the most threads any machine holds', () => {
    expect(placedNotStartedWith({ placedNotStarted: HOST_RUNNING_THREADS_MAX, placedThreadIds: [] }, ['started'], idle)).toBeNull()
  })
})
