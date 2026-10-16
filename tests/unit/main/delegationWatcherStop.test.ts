// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { AgentControl } from '../../../src/main/agents/control'
import { E2EAgentHost, e2eAgentReasoner } from '../../../src/main/e2e/agentEffects'
import type { AgentCommand } from '../../../src/shared/agents'
import { immediatePublishScheduler } from '../../fixtures/publishScheduler'
import { testCredentials } from '../../fixtures/testCredentials'
import { createAgentControl } from '../../fixtures/agentControlFixture'

/**
 * Stop on a delegating thread stops every working thread below it (ADR-0081), whoever presses it: the user, or Watcher
 * stopping that thread. Watcher's sends are not the user's, so they pause no delegated sends, and delegation's own
 * stops are not handed back to it.
 */
const roots: string[] = []; const controls: AgentControl[] = []
afterEach(async () => {
  for (const c of controls.splice(0)) { c.dispose(); await c.privacyChanged() }
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-delegation-stop-')) throw new Error('Unexpected fixture path')
    await rm(root, { recursive: true, force: true })
  }
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'sotto-delegation-stop-')); roots.push(root)
  const credentials = await testCredentials(root, { mode: 'unavailable' })
  const control = createAgentControl({ schedule: immediatePublishScheduler, directory: root, host: new E2EAgentHost(), credentials, reasoner: e2eAgentReasoner }); controls.push(control)
  await control.start(); await control.command({ type: 'connect' })
  control.useWatcher({ userCommand: () => undefined, beforeDispatch: command => command, observe: () => undefined,
    guardOperation: () => undefined, preserveUserQueue: () => false })
  const told: { type: AgentCommand['type']; threadId: string | undefined }[] = []
  control.useDelegation({ userCommand: (command, threadId) => { told.push({ type: command.type, threadId }) }, observe: () => undefined,
    observedThreadIds: () => [], messageIdFor: () => undefined, guardFor: () => undefined })
  return { control, told }
}

it('hands Watcher\'s Stop of a delegating thread to delegation, as the user\'s', async () => {
  const f = await fixture()
  await f.control.commandFromWatcher({ type: 'interrupt', threadId: 'workshop' }, { guard: () => undefined })
  expect(f.told).toEqual([{ type: 'interrupt', threadId: 'workshop' }])
})

it('hands delegation neither Watcher\'s sends nor its own stops', async () => {
  const f = await fixture()
  await f.control.commandFromWatcher({ type: 'manual-send', threadId: 'workshop', draftId: randomUUID(), text: 'Synthetic Watcher brief' }, { guard: () => undefined })
  await f.control.commandFromDelegation({ type: 'interrupt', threadId: 'workshop' }, () => undefined)
  expect(f.told).toEqual([])
})
