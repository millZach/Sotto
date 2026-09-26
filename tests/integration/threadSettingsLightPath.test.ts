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

it('changes a running Claude thread\'s settings in place, and starts a reaped one\'s CLI once, reading neither', async () => {
  const stack = await threadSettingsStack('claude', await claudeFixture(undefined, undefined, undefined, impatient))
  cleanup = stack.cleanup
  // The running CLI takes the change over its control channel (#317) and the adapter hands back the snapshot
  // it produced, which crosses Sotto's thread identities and the workspace to the coordinator (#318): no CLI
  // starts, and nothing reads the thread before or after.
  const running = await stack.press('auto-accept-edits')
  expect(running.error).toBeNull()
  expect(running.runtimeMode).toBe('auto-accept-edits')
  expect(running).toMatchObject({ reads: 0, starts: 0 })
  expect(running.methods).toEqual(['set_permission_mode'])
  expect(running.coordinatorWrites).toBe(1)

  // Reading a Claude thread opens it, so a reaped thread's change starts its CLI once, with the new settings,
  // and the snapshot of that start is the reconciliation.
  await stack.reap()
  const reaped = await stack.press('full-access')
  expect(reaped.error).toBeNull()
  expect(reaped.runtimeMode).toBe('full-access')
  expect(reaped).toMatchObject({ reads: 0, starts: 1 })
  expect(reaped.methods.filter(method => ['set_model', 'apply_flag_settings', 'set_permission_mode'].includes(method))).toEqual([])
  expect(reaped.order).toEqual(['configure-thread'])
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
