// @vitest-environment node
import { createAgentControl } from '../fixtures/agentControlFixture'
import { testCredentials } from '../fixtures/testCredentials'
import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'

import { claudeFixture } from '../fixtures/claudeFixture'
import { grokFixture } from '../fixtures/fakeGrokThreadFixture'
import { immediatePublishScheduler } from '../fixtures/publishScheduler'

// Claude Code steers (claudeSteering.test.ts); Grok has no native way in, and says so rather than cancelling the turn.
it.each([{ name: 'Claude', create: () => claudeFixture(), steers: true }, { name: 'Grok', create: () => grokFixture(), steers: false }])('$name dispatches a queued follow-up only after native completion', async ({ create, steers }) => {
  const f = await create(); const threadId = randomUUID()
  const credentials = await testCredentials(f.root, { mode: 'unavailable' });
  const control = createAgentControl({ schedule: immediatePublishScheduler, directory: f.root, host: f.host, credentials,
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
    if (!steers) await expect(f.host.execute({ type: 'steer', commandId: randomUUID(), threadId, messageId: randomUUID(), text: 'Must not cancel' })).rejects.toThrow(/does not support native steering/)
    await f.driver.completeTurn(threadId, 'Finished first')
    await expect.poll(() => control.get().followups?.length).toBe(0)
    expect(control.get().host.threads[0]?.messages.filter(m => m.role === 'user').map(m => m.text)).toEqual(['First', 'Second'])
  } finally { control.dispose(); await control.privacyChanged(); await f.cleanup() }
})
