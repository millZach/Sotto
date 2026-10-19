// @vitest-environment node
import { createAgentControl } from '../fixtures/agentControlFixture'
import { testCredentials } from '../fixtures/testCredentials'
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'

import { claudeFixture } from '../fixtures/claudeFixture'
import { immediatePublishScheduler } from '../fixtures/publishScheduler'

// Claude Code 2.1.303 reports a /compact in this order: a status with its result, the boundary, then a result naming the
// /compact prompt. A follow-up queued while it runs goes after that result. After a restart Sotto has read no turn of
// the thread, so a thread shown idle before the result had no finished turn and the queue paused.
it('sends a follow-up queued during a Claude compaction once Claude Code answers the compaction, even after a restart', async () => {
  const f = await claudeFixture(); const threadId = randomUUID()
  await writeFile(join(f.root, 'skills.json'), JSON.stringify([{ name: 'compact', description: 'Native compaction' }]))
  const credentials = await testCredentials(f.root, { mode: 'unavailable' })
  const control = createAgentControl({ schedule: immediatePublishScheduler, directory: f.root, host: f.host, credentials })
  const prompts = async (): Promise<{ uuid: string; content: unknown }[]> => (await f.driver.requests())
    .filter(row => row.method === 'user').map(row => row.params?.frame as { uuid: string; message: { content: unknown } }).map(frame => ({ uuid: frame.uuid, content: frame.message.content }))
  const thread = () => control.get().host.threads.find(item => item.id === threadId)
  try {
    await f.host.connect()
    await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, path: f.root, title: 'Fixture' })
    await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId, projectId: f.projectId, title: 'Compact', modelId: f.modelId })
    await f.host.execute({ type: 'send', commandId: randomUUID(), threadId, messageId: 'first-message', text: 'First' })
    await f.driver.completeTurn(threadId, 'Finished first')
    await expect.poll(async () => (await f.host.snapshot()).threads[0]?.status).toBe('idle')
    // A restart: the thread comes back from its transcript, with no turn Sotto has read.
    f.host.disconnect(); await f.adapter.closed(); await f.host.connect()
    expect((await f.host.snapshot()).threads[0]?.lastTurn).toBeUndefined()
    await control.start(); await control.command({ type: 'refresh' })

    expect((await control.command({ type: 'compact-thread', threadId })).error).toBeNull()
    await expect.poll(async () => (await prompts()).at(-1)?.content).toBe('/compact')
    const compact = (await prompts()).at(-1)!.uuid
    const queued = await control.command({ type: 'manual-send', threadId, draftId: randomUUID(), text: 'Second' })
    expect(queued.followups).toEqual([expect.objectContaining({ text: 'Second', status: 'queued' })])

    await f.action(threadId, { type: 'raw', frame: { type: 'system', subtype: 'status', status: null, compact_result: 'success' } })
    await f.action(threadId, { type: 'raw', frame: { type: 'system', subtype: 'compact_boundary', compact_metadata: { pre_tokens: 120000, post_tokens: 30000 } } })
    await expect.poll(() => thread()?.compaction?.status).toBe('completed')
    // Claude Code has not answered the /compact yet, so the thread is still at work and the follow-up waits.
    expect(thread()?.status).toBe('running')
    expect(control.get().followups).toEqual([expect.objectContaining({ text: 'Second', status: 'queued' })])

    await f.action(threadId, { type: 'raw', frame: { type: 'result', subtype: 'success', is_error: false, num_turns: 0, result: '', user_message_uuid: compact, user_message_uuids: [compact] } })
    await expect.poll(async () => (await prompts()).map(prompt => prompt.content)).toEqual(['First', '/compact', 'Second'])
    expect(control.get().followups?.every(item => item.status !== 'paused')).toBe(true)
    await f.driver.completeTurn(threadId, 'Finished second')
    await expect.poll(() => control.get().followups?.length).toBe(0)
  } finally { control.dispose(); await control.privacyChanged(); await f.cleanup() }
})
