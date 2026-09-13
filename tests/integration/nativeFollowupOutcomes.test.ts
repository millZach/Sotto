// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { AgentControl } from '../../src/main/agents/control'
import { AgentCredentials } from '../../src/main/agents/credentials'
import { e2eAgentReasoner } from '../../src/main/e2e/agentEffects'
import { claudeFixture } from '../fixtures/claudeFixture'
import { grokFixture } from '../fixtures/fakeGrokThreadFixture'

it.each([{ name: 'Claude', create: () => claudeFixture(undefined, 1000) }, { name: 'Grok', create: () => grokFixture() }])('$name dispatches a queued follow-up only after native completion and refuses native steering', async ({ create }) => {
  const f = await create(); const threadId = randomUUID()
  const credentials = new AgentCredentials(f.root, { isEncryptionAvailable: () => false, encryptString: t => Buffer.from(t), decryptString: t => t.toString() }); await credentials.load()
  const control = new AgentControl({ directory: f.root, host: f.host, credentials, reasoner: e2eAgentReasoner,
    membership: { status: async () => ({ status: 'beta', label: 'Test', expiresAt: null }), action: async () => ({ status: 'beta', label: 'Test', expiresAt: null }) } })
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
