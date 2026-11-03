// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'

import { desktopPopupClient } from '../../../../src/main/agents/hostService'
import { fixture, registerAgentControlRecoveryCleanup } from '../../../fixtures/agentControlRecovery'

registerAgentControlRecoveryCleanup()

it('starts the popup\'s thread without opening it in the window (ADR-0181)', async () => {
  const f = await fixture()
  const shown = randomUUID()
  await f.control.command({ type: 'create-thread', projectId: 'project', title: 'Open in the window', modelId: 'claude:test', threadId: shown })
  const popupThread = randomUUID()
  const created = await f.control.command({ type: 'create-thread', projectId: 'project', title: 'New thread', modelId: 'claude:test', threadId: popupThread }, desktopPopupClient())
  expect(created.error).toBeNull()
  expect(created.host.threads.some(thread => thread.id === popupThread)).toBe(true)
  expect(created.activeThreadId).toBe(shown)
})
