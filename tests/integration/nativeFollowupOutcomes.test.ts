// @vitest-environment node
import { createAgentControl } from '../fixtures/agentControlFixture'
import { testCredentials } from '../fixtures/testCredentials'
import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'

import { e2eAgentReasoner } from '../../src/main/e2e/agentEffects'
import { claudeFixture } from '../fixtures/claudeFixture'
import { grokFixture } from '../fixtures/fakeGrokThreadFixture'
import { immediatePublishScheduler } from '../fixtures/publishScheduler'

it.each([{ name: 'Claude', create: () => claudeFixture() }, { name: 'Grok', create: () => grokFixture() }])('$name dispatches a queued follow-up only after native completion and refuses native steering', async ({ create }) => {
  const f = await create(); const threadId = randomUUID()
  const credentials = await testCredentials(f.root, { mode: 'unavailable' });
  const control = createAgentControl({ schedule: immediatePublishScheduler, directory: f.root, host: f.host, credentials, reasoner: e2eAgentReasoner,
  })
  try {
    await f.host.connect()
    await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, path: f.root, title: 'Fixture' })
    await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId, projectId: f.projectId, title: 'Queue', modelId: f.modelId })
    await f.host.execute({ type: 'send', commandId: randomUUID(), threadId, messageId: 'first-message', text: 'First' })
    await control.start()
    // start subscribes without disrupting the already connected native turn.
    await control.command({ type: 'refresh' })
    const queued = await control.command({ type: 'manual-send', threadId, draftId: randomUUID(), text: 'Second' })
    expect(queued.followups).toHaveLength(1)
    await expect(f.host.execute({ type: 'steer', commandId: randomUUID(), threadId, messageId: randomUUID(), text: 'Must not cancel' })).rejects.toThrow(/does not support native steering/)
    await f.driver.completeTurn(threadId, 'Finished first')
    await expect.poll(() => control.get().followups?.length).toBe(0)
    expect(control.get().host.threads[0]?.messages.filter(m => m.role === 'user').map(m => m.text)).toEqual(['First', 'Second'])
  } finally { control.dispose(); await control.privacyChanged(); await f.cleanup() }
})
