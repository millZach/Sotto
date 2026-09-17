// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { AgentControl } from '../../src/main/agents/control'
import { AgentCredentials } from '../../src/main/agents/credentials'
import { codexFixture } from '../fixtures/codexFixture'
import { immediatePublishScheduler } from '../fixtures/publishScheduler'

it('restores drafts and reconciles a lost native acknowledgement under the original Sotto binding without a duplicate turn', async () => {
  const f = await codexFixture(undefined, true, 200)
  const threadId = randomUUID(); const draftId = randomUUID(); const newerId = randomUUID()
  const credentials = new AgentCredentials(join(f.root, 'vault'), { isEncryptionAvailable: () => false, encryptString: value => Buffer.from(value), decryptString: value => value.toString() })
  await credentials.load()
  const create = () => new AgentControl({ schedule: immediatePublishScheduler, directory: f.root, host: f.host, credentials,
    reasoner: { intent: async () => ({ type: 'clarify', text: 'Choose a thread' }), decide: async () => ({ decision: 'human', text: 'Review' }) },
    membership: { status: async () => ({ status: 'beta', label: 'Fixture', expiresAt: null }), action: async () => ({ status: 'beta', label: 'Fixture', expiresAt: null }) } })
  let control = create()
  try {
    await f.host.connect()
    await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Project', path: f.root })
    await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId, projectId: f.projectId, title: 'Native draft', modelId: f.modelId })
    const binding = structuredClone(f.registry.byThread(threadId))
    expect(binding?.sessionId).not.toBe(threadId)
    await control.start(); await control.command({ type: 'connect' })
    await control.command({ type: 'save-thread-draft', threadId, draftId, text: 'Original native prompt' })
    await f.driver.delayNextAck('turn/start')
    const command = { type: 'manual-send' as const, threadId, draftId, text: 'Original native prompt' }
    const uncertain = await control.command(command)
    expect(uncertain.deliveries).toContainEqual(expect.objectContaining({ threadId, draftId, status: 'uncertain' }))
    expect(uncertain.threadDrafts).toContainEqual(expect.objectContaining({ threadId, draftId }))
    await control.command({ type: 'save-thread-draft', threadId, draftId: newerId, text: 'Next draft remains here' })
    control.dispose(); await control.privacyChanged()
    control = create(); await control.start(); await control.command({ type: 'connect' })
    await expect.poll(async () => {
      await control.command({ type: 'refresh' })
      return control.get().deliveries?.find(item => item.draftId === draftId)?.status
    }).toBe('accepted')
    await control.command(command)
    expect(control.get().threadDrafts).toEqual([expect.objectContaining({ threadId, draftId: newerId, text: 'Next draft remains here' })])
    expect(control.get().host.threads.find(thread => thread.id === threadId)?.messages.filter(message => message.role === 'user')).toHaveLength(1)
    expect((await f.driver.requests()).filter(request => request.method === 'turn/start')).toHaveLength(1)
    expect(f.registry.byThread(threadId)).toEqual(binding)
    const saved = await readFile(join(f.root, 'agents.json'), 'utf8')
    expect(saved).not.toContain(binding!.sessionId)
    expect(saved).not.toContain(await f.realId(threadId))
  } finally { control.dispose(); await control.privacyChanged(); await f.cleanup() }
})
