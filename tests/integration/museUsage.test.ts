// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { UsageTokenObservation } from '../../src/shared/usageDashboard'
import { museFixture } from '../fixtures/museFixture'

// Usage counts Muse work in Sotto threads and reads Muse's subscription window through MSP's `usage/read` (ADR-0083,
// October 21, 2026). The fake client answers the way Muse Code 1.4.9 did when checked live: `{}` until the host has seen a
// model call, then the window it saw; one `session/tokenUsage` per completion, named by the records it was folded from.
async function started(options: { usage?: boolean; script?: Record<string, unknown> } = {}) {
  const f = await museFixture(undefined, 2000, {}, { usageEnabled: options.usage !== false })
  const id = randomUUID()
  if (options.script) await f.script(options.script)
  await f.host.connect()
  await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Project', path: f.root })
  await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f.projectId, modelId: f.modelId, title: 'Muse thread' })
  return { f, id }
}

describe('Muse in Usage', () => {
  it('publishes each model call once under its thread and reads the window the host saw after the turn', async () => {
    const { f, id } = await started({ script: { reportUsage: true } })
    const records: UsageTokenObservation[] = []
    const off = f.host.subscribeUsage!(record => records.push(record))
    try {
      // No turn has run, so no host has seen the window yet: nothing is read and nothing is invented.
      expect(await f.host.readProviderQuota!('muse', false)).toMatchObject({ providerId: 'muse', status: 'unavailable', reason: 'not-reported', windows: [] })
      await f.host.execute({ type: 'send', commandId: randomUUID(), messageId: 'opening-message', threadId: id, text: 'Synthetic prompt' })
      await f.action(id, { type: 'complete', text: 'Synthetic reply' })
      await expect.poll(() => records.length).toBe(1)
      expect(records[0]).toMatchObject({ providerId: 'muse', threadId: id, modelId: f.modelId, phase: 'live', partial: false,
        tokens: { input: 100, output: 7, cached: 40, cacheWrite: 5 } })
      expect(records[0]!.recordKey).toMatch(/^[a-f\d]{64}$/u)
      expect(records[0]!.groupKey).toMatch(/^[a-f\d]{64}$/u)
      expect(records[0]!.groupStartedAt).toEqual(expect.any(String))
      expect(JSON.stringify(records)).not.toContain('Synthetic')
      // The thread's own readout is unchanged by Usage.
      await expect.poll(async () => (await f.host.snapshot()).threads.find(thread => thread.id === id)?.usage?.latest?.output).toBe(7)
      await expect.poll(async () => (await f.host.readProviderQuota!('muse', false)).status).toBe('available')
      const quota = await f.host.readProviderQuota!('muse', false)
      expect(quota.windows).toMatchObject([
        { id: 'muse-window', kind: 'primary', label: '5 hours', usedPercent: 12, durationMinutes: 300 },
        { id: 'muse-weekly', kind: 'weekly', label: 'Week', usedPercent: 47, durationMinutes: 10_080 },
      ])
      expect(JSON.stringify(quota)).not.toContain('fixture-tier')
      // Read again asks the running host, and its answer is the same window.
      expect(await f.host.readProviderQuota!('muse', true)).toMatchObject({ status: 'available', refreshable: true, windows: quota.windows })
      // A second call in another turn is another row.
      await f.host.execute({ type: 'send', commandId: randomUUID(), messageId: 'second-message', threadId: id, text: 'Synthetic second prompt' })
      await f.action(id, { type: 'complete', text: 'Synthetic second reply' })
      await expect.poll(() => records.length).toBe(2)
      expect(records[1]!.recordKey).not.toBe(records[0]!.recordKey)
      expect(records[1]!.groupKey).not.toBe(records[0]!.groupKey)
    } finally { off(); await f.cleanup() }
  })

  it('takes usage/changed when a host sends it', async () => {
    const window = { observedAtMs: Date.parse('2026-10-21T12:00:00Z'), tier: 'fixture-tier',
      window: { resetsAtMs: Date.now() + 3_600_000, usedPercent: 105, windowDurationMins: 300 }, weekly: { resetsAtMs: Date.now() + 86_400_000, usedPercent: 3 } }
    const { f, id } = await started({ script: { reportUsage: window, usageChanged: true, noUsageRead: true } })
    try {
      await f.host.execute({ type: 'send', commandId: randomUUID(), messageId: 'opening-message', threadId: id, text: 'Synthetic prompt' })
      await f.action(id, { type: 'complete', text: 'Synthetic reply' })
      await expect.poll(async () => (await f.host.readProviderQuota!('muse', false)).status).toBe('available')
      expect((await f.host.readProviderQuota!('muse', false))).toMatchObject({ observedAt: '2026-10-21T12:00:00.000Z',
        windows: [{ kind: 'primary', usedPercent: 105 }, { kind: 'weekly', usedPercent: 3 }] })
    } finally { await f.cleanup() }
  })

  it('says a client without usage/read is unsupported rather than failing', async () => {
    const { f, id } = await started({ script: { noUsageRead: true } })
    try {
      await f.host.execute({ type: 'send', commandId: randomUUID(), messageId: 'opening-message', threadId: id, text: 'Synthetic prompt' })
      expect(await f.host.readProviderQuota!('muse', true)).toMatchObject({ providerId: 'muse', status: 'unavailable', reason: 'unsupported' })
    } finally { await f.cleanup() }
  })

  it('has no Usage seam where Usage is off', async () => {
    const { f, id } = await started({ usage: false, script: { reportUsage: true } })
    try {
      expect(f.host.subscribeUsage).toBeUndefined()
      expect(f.host.readProviderQuota).toBeUndefined()
      await f.host.execute({ type: 'send', commandId: randomUUID(), messageId: 'opening-message', threadId: id, text: 'Synthetic prompt' })
      await f.action(id, { type: 'complete', text: 'Synthetic reply' })
      await expect.poll(async () => (await f.host.snapshot()).threads.find(thread => thread.id === id)?.usage?.latest?.output).toBe(7)
      expect((await f.driver.requests()).some(record => record.method === 'usage/read')).toBe(false)
    } finally { await f.cleanup() }
  })
})
