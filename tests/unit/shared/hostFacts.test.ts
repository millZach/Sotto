import { describe, expect, it } from 'vitest'
import { hostFactsSchema, hostMachineReportSchema } from '../../../src/shared/hostFacts'

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
