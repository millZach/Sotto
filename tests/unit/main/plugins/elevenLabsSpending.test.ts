// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { monthOf } from '../../../../src/main/plugins/spending'
import { centsByAccount, centsOf, PluginSpendingSync, type SpendingTarget } from '../../../../src/main/plugins/spendingSync'
import type { SpendingReport } from '../../../../src/shared/pluginAccountCopies'
import type { PluginAccount } from '../../../../src/shared/plugins'

/**
 * Shared spending for an ElevenLabs account (the plugins plan's slice 12, part 4a), on the desktop's side: the same
 * sync as Meshy's, on its own feature and its own file, in whole cents. Every account here is made up.
 */
let directory: string
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'sotto-elevenlabs-spending-')) })
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

const VOICES: PluginAccount = { id: '55555555-5555-4555-8555-000000000001', plugin: 'elevenlabs', name: 'Voices', savedAt: '2026-11-15T08:00:00.000Z', signedInAs: null, on: true, projects: null, spending: { askBefore: true, monthlyLimit: 10 } }
const STUDIO: PluginAccount = { ...VOICES, id: '44444444-4444-4444-8444-000000000001', plugin: 'meshy', name: 'Studio', spending: { askBefore: true, monthlyLimit: 1_000 } }
const NOVEMBER = new Date(2026, 10, 15, 12)
const MONTH = monthOf(NOVEMBER)

/** A connected host that lists ElevenLabs' spending, Meshy's, or both, and answers with its own count in cents. */
function remote(hostId: string, cents: number, lists: { elevenlabs?: boolean; meshy?: boolean } = { elevenlabs: true }) {
  const told: SpendingReport[][] = []
  const toldMeshy: SpendingReport[][] = []
  const listeners = new Set<(reports?: readonly SpendingReport[]) => void>()
  let revision = 0
  const session = '77777777-7777-4777-8777-000000000001'
  const report = (count: number): SpendingReport => ({ accountId: VOICES.id, month: MONTH, credits: count, session, revision: ++revision })
  const target: SpendingTarget = { hostId, kind: 'remote', service: {
    supportsPluginElevenLabsSpending: lists.elevenlabs === true,
    sharePluginElevenLabsSpending: async reports => { told.push([...reports]); return [report(cents)] },
    subscribePluginElevenLabsSpending: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
    supportsPluginMeshySpending: lists.meshy === true,
    sharePluginMeshySpending: async reports => { toldMeshy.push([...reports]); return [] },
  } }
  const push = (count: number): void => { const pushed = [report(count)]; for (const listener of listeners) listener(pushed) }
  return { target, told, toldMeshy, push }
}

describe('whole cents', () => {
  it('rounds a sum of dollars up to the cent, without taking a hair of floating-point error for another cent', () => {
    expect(centsOf(0)).toBe(0)
    expect(centsOf(0.001)).toBe(1)
    expect(centsOf(0.1 + 0.2)).toBe(30)
    expect(centsOf(1.2)).toBe(120)
    expect(centsOf(1.201)).toBe(121)
    expect([...centsByAccount(new Map([[VOICES.id, 0.004]]))]).toEqual([[VOICES.id, 1]])
  })
})

describe('shared spending for an ElevenLabs account on the desktop', () => {
  it('tells a host in cents what was spent here, counts what it says, and keeps it in its own file', async () => {
    const forge = remote('host-forge', 250)
    const spending = new PluginSpendingSync(directory, { plugin: 'elevenlabs', own: async () => centsByAccount(new Map([[VOICES.id, 0.731]])),
      accounts: async () => [VOICES, STUDIO], connections: () => [forge.target], now: () => NOVEMBER })
    spending.connected(forge.target)
    await spending.idle()
    // ElevenLabs' accounts alone, its own rounded up: 73.1 cents is told as 74.
    expect(forge.told).toMatchObject([[{ accountId: VOICES.id, month: MONTH, credits: 74 }]])
    expect(forge.toldMeshy).toEqual([])
    await expect(spending.others(VOICES.id)).resolves.toBe(250)
    await expect(spending.monthTotal(VOICES.id)).resolves.toBe(324)
    await expect(spending.reportedBy(VOICES.id)).resolves.toEqual(['host-forge'])
    const kept = JSON.parse(await readFile(join(directory, 'plugin-elevenlabs-spending.json'), 'utf8')) as { heard: Record<string, Record<string, { credits: number }>> }
    expect(kept.heard['host-forge']?.[VOICES.id]?.credits).toBe(250)
    await expect(readFile(join(directory, 'plugin-meshy-spending.json'), 'utf8')).rejects.toThrow()
    // A push from the host counts as it comes.
    forge.push(400)
    await expect.poll(() => spending.others(VOICES.id)).toBe(400)
    spending.close()
  })

  it('tells a host that lists only Meshy’s spending nothing of ElevenLabs, and hears nothing of it', async () => {
    const older = remote('host-older', 900, { meshy: true })
    const spending = new PluginSpendingSync(directory, { plugin: 'elevenlabs', own: async () => new Map([[VOICES.id, 10]]),
      accounts: async () => [VOICES], connections: () => [older.target], now: () => NOVEMBER })
    spending.connected(older.target)
    await spending.idle()
    expect(older.told).toEqual([])
    expect(older.toldMeshy).toEqual([])
    await expect(spending.others(VOICES.id)).resolves.toBe(0)
    spending.close()
  })
})
