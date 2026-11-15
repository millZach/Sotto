// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { everyMonthStart, HeardSpending, monthOf } from '../../../../src/main/plugins/meshy/spending'
import { MeshySpendingSync, type SpendingTarget } from '../../../../src/main/plugins/meshy/spendingSync'
import type { SpendingReport } from '../../../../src/shared/pluginAccountCopies'
import type { PluginAccount } from '../../../../src/shared/plugins'

/** Shared spending for a Meshy account (ADR-0205), on the desktop's side. Every account here is made up. */
let directory: string
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'sotto-meshy-spending-')) })
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

const STUDIO: PluginAccount = { id: '44444444-4444-4444-8444-000000000001', plugin: 'meshy', name: 'Studio', savedAt: '2026-11-15T08:00:00.000Z', signedInAs: null, on: true, projects: null, spending: { askBefore: true, monthlyLimit: 1_000 } }
const NOVEMBER = new Date(2026, 10, 15, 12)
const MONTH = monthOf(NOVEMBER)

/**
 * A connected host that keeps what it is told and answers with its own count, each report the next of its run;
 * `push` stands for what it pushes. `beforeReply` runs once its answer is counted and before it is sent.
 */
function remote(hostId: string, own: number, supports = true) {
  const told: SpendingReport[][] = []
  const listeners = new Set<(reports?: readonly SpendingReport[]) => void>()
  const host = { own, revision: 0, beforeReply: undefined as (() => void) | undefined }
  const session = '66666666-6666-4666-8666-' + String(hostId.length).padStart(12, '0')
  const report = (credits: number): SpendingReport => ({ accountId: STUDIO.id, month: MONTH, credits, session, revision: ++host.revision })
  const target: SpendingTarget = { hostId, kind: 'remote', service: {
    supportsPluginMeshySpending: supports,
    sharePluginMeshySpending: async reports => {
      told.push([...reports])
      const answer = [report(host.own)]
      host.beforeReply?.()
      return answer
    },
    subscribePluginMeshySpending: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
  } }
  const push = (credits: number): void => { host.own = credits; const pushed = [report(credits)]; for (const listener of listeners) listener(pushed) }
  return { target, told, push, listeners, host }
}

function sync(connected: SpendingTarget[], own: { credits: number }) {
  const spending = new MeshySpendingSync(directory, {
    own: async () => new Map([[STUDIO.id, own.credits]]), accounts: async () => [STUDIO], connections: () => connected, now: () => NOVEMBER,
  })
  return spending
}

describe('shared spending on the desktop', () => {
  it('tells a host on connecting what was spent here, and counts what it says it spent', async () => {
    const forge = remote('host-forge', 90)
    const own = { credits: 30 }
    const spending = sync([forge.target], own)
    spending.connected(forge.target)
    await spending.idle()
    expect(forge.told).toMatchObject([[{ accountId: STUDIO.id, month: MONTH, credits: 30 }]])
    await expect(spending.monthCredits(STUDIO.id)).resolves.toBe(120)
    await expect(spending.reportedBy(STUDIO.id)).resolves.toEqual(['host-forge'])
    spending.close()
  })

  it('tells every host again when this computer’s count moves, and not when it stays', async () => {
    const forge = remote('host-forge', 0)
    const own = { credits: 0 }
    const spending = sync([forge.target], own)
    spending.connected(forge.target)
    await spending.idle()
    spending.ownChanged()
    await spending.idle()
    // The first look learns the count; nothing moved since the hello.
    const before = forge.told.length
    own.credits = 30
    spending.ownChanged()
    await spending.idle()
    expect(forge.told.length).toBe(before + 1)
    expect(forge.told.at(-1)).toMatchObject([{ accountId: STUDIO.id, month: MONTH, credits: 30 }])
    spending.ownChanged()
    await spending.idle()
    expect(forge.told.length).toBe(before + 1)
    spending.close()
  })

  it('tells each host what was spent everywhere but there, and tells the others when one host’s count changes', async () => {
    const forge = remote('host-forge', 40)
    const tower = remote('host-tower', 0)
    const spending = sync([forge.target, tower.target], { credits: 10 })
    spending.connected(forge.target)
    await spending.idle()
    spending.connected(tower.target)
    await spending.idle()
    // The tower hears this computer's 10 and the forge's 40.
    expect(tower.told.at(-1)).toMatchObject([{ accountId: STUDIO.id, month: MONTH, credits: 50 }])
    forge.push(70)
    await expect.poll(() => tower.told.at(-1)?.[0]?.credits).toBe(80)
    await expect(spending.monthCredits(STUDIO.id)).resolves.toBe(80)
    spending.close()
  })

  it('keeps counting what a host last said after it goes away, and after a restart', async () => {
    const forge = remote('host-forge', 200)
    const first = sync([forge.target], { credits: 0 })
    first.connected(forge.target)
    await first.idle()
    first.close()
    const again = sync([], { credits: 5 })
    await expect(again.monthCredits(STUDIO.id)).resolves.toBe(205)
    again.close()
  })

  it('keeps a host’s newer push when its older answer lands after it, and takes a newer, lower count as a refund', async () => {
    // Sol's review: a push and an answer read from the socket together, the push heard first.
    const forge = remote('host-forge', 600)
    const spending = sync([forge.target], { credits: 0 })
    forge.host.beforeReply = () => { forge.host.beforeReply = undefined; forge.push(900) }
    spending.connected(forge.target)
    await spending.idle()
    await expect(spending.monthCredits(STUDIO.id)).resolves.toBe(900)
    // Meshy gave credits back: the newer report says less, and it is the one that counts.
    forge.push(850)
    await expect.poll(() => spending.monthCredits(STUDIO.id)).toBe(850)
    spending.close()
  })

  it('tells an older host nothing and hears nothing from it', async () => {
    const older = remote('host-older', 500, false)
    const spending = sync([older.target], { credits: 0 })
    spending.connected(older.target)
    await spending.idle()
    expect(older.told).toEqual([])
    await expect(spending.monthCredits(STUDIO.id)).resolves.toBe(0)
    spending.close()
  })
})

describe('what is heard, by month', () => {
  it('counts a report only for this computer’s month', async () => {
    let now = NOVEMBER
    const heard = new HeardSpending(join(directory, 'heard.json'), () => now)
    const session = '66666666-6666-4666-8666-000000000009'
    await heard.hear('host-forge', [{ accountId: STUDIO.id, month: '2026-10', credits: 900, session, revision: 1 }, { accountId: '44444444-4444-4444-8444-000000000002', month: MONTH, credits: 20, session, revision: 1 }])
    await expect(heard.total(STUDIO.id)).resolves.toBe(0)
    await heard.hear('host-forge', [{ accountId: STUDIO.id, month: MONTH, credits: 60, session, revision: 2 }])
    await expect(heard.total(STUDIO.id)).resolves.toBe(60)
    await expect(heard.total(STUDIO.id, 'host-forge')).resolves.toBe(0)
    // December starts: November's report counts for nothing.
    now = new Date(2026, 11, 1, 0, 0, 1)
    await expect(heard.total(STUDIO.id)).resolves.toBe(0)
  })

  it('calls when a month starts by this computer’s clock', () => {
    vi.useFakeTimers()
    let now = new Date(2026, 10, 30, 23, 59, 59)
    let turned = 0
    const stop = everyMonthStart(() => { turned += 1 }, () => now)
    // Not yet: the clock has not moved.
    expect(turned).toBe(0)
    now = new Date(2026, 11, 1, 0, 0, 1)
    vi.advanceTimersByTime(1_000)
    expect(turned).toBe(1)
    stop()
    vi.useRealTimers()
  })
})
