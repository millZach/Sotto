// @vitest-environment node
import { afterEach, expect, it } from 'vitest'
import { claudeFixture } from '../fixtures/claudeFixture'
import { codexFixture } from '../fixtures/codexFixture'
import { threadSettingsStack } from '../fixtures/threadSettingsStack'

/**
 * A thread settings chip press through the whole host stack, on the fake Claude and Codex clients (#318). Counts
 * only: the times are the benchmark's (`tests/perf/threadSettings.perf.test.ts`).
 */
const impatient = { reaperSweepMs: 20, sessionIdleMs: 150 }
let cleanup: (() => Promise<void>) | undefined
afterEach(async () => { await cleanup?.(); cleanup = undefined })

it('starts a reaped Claude thread\'s CLI at most once for a settings change, and reads it only after the change', async () => {
  const stack = await threadSettingsStack('claude', await claudeFixture(undefined, undefined, undefined, impatient))
  cleanup = stack.cleanup
  await stack.reap()
  const press = await stack.press('full-access')
  expect(press.error).toBeNull()
  expect(press.runtimeMode).toBe('full-access')
  expect(press.starts).toBeLessThanOrEqual(1)
  // Reading a Claude thread opens it. Nothing reads it before the adapter has the change, and once the adapter
  // hands back its own snapshot (#317) nothing reads it after either.
  expect(press.order.slice(0, press.order.indexOf('configure-thread'))).not.toContain('read')
  expect(press.reads).toBeLessThanOrEqual(1)
})

it('changes a Codex thread\'s settings without reading its transcript, running or reaped', async () => {
  const stack = await threadSettingsStack('codex', await codexFixture(undefined, false, undefined, impatient))
  cleanup = stack.cleanup
  const running = await stack.press('full-access')
  expect(running.error).toBeNull()
  expect(running.runtimeMode).toBe('full-access')
  expect(running).toMatchObject({ reads: 0, starts: 0 })
  expect(running.methods).toEqual(['thread/settings/update'])
  // The outbox entry is written before the change goes out; its removal waits for the next write.
  expect(running.coordinatorWrites).toBe(1)

  await stack.reap()
  const reaped = await stack.press('auto-accept-edits')
  expect(reaped.error).toBeNull()
  expect(reaped.runtimeMode).toBe('auto-accept-edits')
  expect(reaped).toMatchObject({ reads: 0, starts: 1 })
  expect(reaped.methods).not.toContain('thread/read')
})
