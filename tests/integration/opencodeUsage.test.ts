// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { UsageTokenObservation } from '../../src/shared/usageDashboard'
import { opencodeFixture } from '../fixtures/fakeOpenCodeFixture'

// Usage counts OpenCode work in Sotto threads, one row per finished step, and reads no account limits for it (ADR-0083,
// ADR-0087, October 21, 2026). The fake server reports each step as OpenCode 2 does: input apart from cache reads and
// writes, reasoning apart from output, and a session total after it that is never added on top.
describe('OpenCode in Usage', () => {
  it('counts each finished step once, live and when its session is read back, and offers no limits', async () => {
    let f = await opencodeFixture(undefined, 3000, {}, { usageEnabled: true })
    const id = randomUUID()
    const records: UsageTokenObservation[] = []
    let off = f.host.subscribeUsage!(record => records.push(record))
    try {
      expect((f.host as { readProviderQuota?: unknown }).readProviderQuota).toBeUndefined()
      await f.host.connect()
      await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Project', path: f.root })
      await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f.projectId, modelId: f.modelId, title: 'OpenCode thread' })
      await f.host.execute({ type: 'send', commandId: randomUUID(), messageId: 'opening-message', threadId: id, text: 'Synthetic prompt' })
      await f.driver.completeTurn(id, 'Synthetic reply')
      await expect.poll(() => records.length).toBe(1)
      const live = records[0]!
      expect(live).toMatchObject({ providerId: 'opencode', threadId: id, modelId: f.modelId, phase: 'live', partial: false,
        tokens: { input: 14, output: 2, cached: 4, cacheWrite: 0 } })
      expect(live.groupStartedAt).toEqual(expect.any(String))
      expect(JSON.stringify(records)).not.toContain('Synthetic')

      // Read back after a restart, the same step is the same row; the session's running total adds nothing.
      off(); f = await f.driver.restart()
      const replayed: UsageTokenObservation[] = []
      off = f.host.subscribeUsage!(record => replayed.push(record))
      await f.host.connect()
      await f.host.refreshThread(id)
      await expect.poll(() => replayed.length).toBeGreaterThan(0)
      expect(replayed).toHaveLength(1)
      expect(replayed[0]).toMatchObject({ phase: 'replay', recordKey: live.recordKey, groupKey: live.groupKey, tokens: live.tokens, modelId: f.modelId })
    } finally { off(); await f.cleanup() }
  })

  it('has no Usage seam where Usage is off', async () => {
    const f = await opencodeFixture()
    try { expect(f.host.subscribeUsage).toBeUndefined() } finally { await f.cleanup() }
  })
})
