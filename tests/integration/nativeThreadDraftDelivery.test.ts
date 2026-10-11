// @vitest-environment node
import { createAgentControl } from '../fixtures/agentControlFixture'
import { testCredentials } from '../fixtures/testCredentials'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'

import { codexFixture } from '../fixtures/codexFixture'
import { immediatePublishScheduler } from '../fixtures/publishScheduler'

it('restores drafts and reconciles a lost native acknowledgement under the original Sotto binding without a duplicate turn', async () => {
  const f = await codexFixture(undefined, true)
  const threadId = randomUUID(); const draftId = randomUUID(); const newerId = randomUUID()
  const credentials = await testCredentials(join(f.root, 'vault'), { mode: 'unavailable' })
  const create = () => createAgentControl({ schedule: immediatePublishScheduler, directory: f.root, host: f.host, credentials,
    reasoner: {},
  })
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
    // Lazy provider sessions: the thread is read once it is on screen again.
    await control.command({ type: 'observe-threads', threadIds: [threadId] })
    await expect.poll(async () => {
      await control.command({ type: 'refresh' })
      return control.get().deliveries?.find(item => item.draftId === draftId)?.status
    }).toBe('accepted')
    // Opening the thread resumes its provider session and reads its history.
    await expect.poll(async () => {
      await control.command({ type: 'refresh' })
      return control.get().host.threads.find(thread => thread.id === threadId)?.messages.filter(message => message.role === 'user').length
    }).toBe(1)
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
