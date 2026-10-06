// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { claudeFixture } from '../fixtures/claudeFixture'
import { devinFixture } from '../fixtures/devinFixture'
import { grokFixture } from '../fixtures/fakeGrokThreadFixture'
import type { AgentHostSnapshot } from '../../src/shared/agents'

// Thinking reaches the thread through each adapter over its scripted client: a Thinking row before the reply, live,
// and the same row again when the thread is read back from the provider's own history. The words are invented.
type Host = { snapshot(): Promise<AgentHostSnapshot> }
const thread = async (host: Host) => (await host.snapshot()).threads[0]
const thoughts = async (host: Host) => (await thread(host))?.activities?.filter(row => row.kind === 'reasoning') ?? []
const replies = async (host: Host) => (await thread(host))?.messages.filter(message => message.role === 'assistant' && message.text) ?? []
// A replay restores the provider's record, not Sotto's watching: the order number and a start Sotto timed itself go.
const settled = (rows: Awaited<ReturnType<typeof thoughts>>) => rows.map(row => {
  const kept = { ...row }
  for (const key of ['sequence', 'startedAt', 'completedAt', 'timingSource', 'durationMs'] as const) delete kept[key]
  return kept
})

it('Claude shows a thinking block before its reply, and reads the same row back from its transcript', async () => {
  let f = await claudeFixture(); const id = randomUUID()
  try {
    await f.host.connect()
    await f.host.execute({ type: 'create-project', commandId: 'p', projectId: 'p', title: 'P', path: f.root })
    await f.host.execute({ type: 'create-thread', commandId: 't', threadId: id, projectId: 'p', modelId: f.modelId, title: 'T' })
    await f.host.execute({ type: 'send', commandId: 'send', messageId: 'user', threadId: id, text: 'Think first' })
    await f.action(id, { type: 'complete', text: 'Reply after thinking.', thinking: 'Weigh the two options first.', holdAfterThinking: 'release-reply' })
    await expect.poll(async () => (await thoughts(f.host))[0]?.text).toBe('Weigh the two options first.')
    // Only the thinking has arrived: the row is there and the reply is not.
    expect(await thoughts(f.host)).toEqual([expect.objectContaining({ title: 'Thinking', status: 'completed', turnId: 'user', afterMessageId: 'user' })])
    expect(await replies(f.host)).toEqual([])
    expect(JSON.stringify(await f.host.snapshot())).not.toContain('c2lnbmF0dXJl')
    await writeFile(join(f.root, 'release-reply'), '')
    await expect.poll(async () => (await replies(f.host)).map(message => message.text)).toEqual(['Reply after thinking.'])
    const shown = await thoughts(f.host)
    expect(shown).toHaveLength(1)

    f.host.disconnect(); await f.adapter.closed(); f = await claudeFixture(f.root); await f.host.connect()
    await expect.poll(async () => settled(await thoughts(f.host))).toEqual(settled(shown))
    expect((await thoughts(f.host))[0]!.timingSource).toBe('provider')
  } finally { await f.cleanup() }
})

it('Claude shows a redacted thinking block as the row without text', async () => {
  const f = await claudeFixture(); const id = randomUUID()
  try {
    await f.host.connect()
    await f.host.execute({ type: 'create-project', commandId: 'p', projectId: 'p', title: 'P', path: f.root })
    await f.host.execute({ type: 'create-thread', commandId: 't', threadId: id, projectId: 'p', modelId: f.modelId, title: 'T' })
    await f.host.execute({ type: 'send', commandId: 'send', messageId: 'user', threadId: id, text: 'Think quietly' })
    await f.action(id, { type: 'complete', text: 'Done.', redacted: true })
    await expect.poll(async () => (await replies(f.host)).length).toBe(1)
    const rows = await thoughts(f.host)
    expect(rows).toEqual([expect.objectContaining({ title: 'Thinking', status: 'completed' })])
    expect(rows[0]!.text).toBeUndefined()
    expect(JSON.stringify(await f.host.snapshot())).not.toContain('cmVkYWN0ZWQ=')
  } finally { await f.cleanup() }
})

it('Grok shows its thought chunks before its reply, and reads the same row back from its history', async () => {
  let f = await grokFixture(); const id = randomUUID()
  try {
    await f.host.connect()
    await f.host.execute({ type: 'create-project', commandId: 'p', projectId: 'p', title: 'P', path: f.root })
    await f.host.execute({ type: 'create-thread', commandId: 't', threadId: id, projectId: 'p', modelId: f.modelId, title: 'T' })
    await f.host.execute({ type: 'send', commandId: 'send', messageId: 'user', threadId: id, text: 'Think first' })
    await f.action(id, { type: 'complete', text: 'Answer.', thought: 'Consider the input.' })
    await expect.poll(async () => (await replies(f.host)).map(message => message.text)).toEqual(['Answer.'])
    const shown = await thoughts(f.host)
    expect(shown).toEqual([expect.objectContaining({ title: 'Thinking', status: 'completed', text: 'Consider the input.', afterMessageId: 'user' })])
    const reply = (await replies(f.host))[0]!.id

    f = await f.driver.restart(); f.host.observeThreads?.([id]); await f.host.connect()
    await expect.poll(async () => settled(await thoughts(f.host))).toEqual(settled(shown))
    // Showing thoughts does not change the identity the reply had.
    expect((await replies(f.host)).map(message => message.id)).toEqual([reply])
  } finally { await f.cleanup() }
})

it('Devin shows its thought chunks before its reply', async () => {
  const f = await devinFixture(); const id = randomUUID()
  try {
    await f.host.connect()
    await f.host.execute({ type: 'create-project', commandId: 'p', projectId: 'p', title: 'P', path: f.root })
    await f.host.execute({ type: 'create-thread', commandId: 't', threadId: id, projectId: 'p', modelId: f.modelId, title: 'T' })
    await f.host.execute({ type: 'send', commandId: 'send', messageId: 'user', threadId: id, text: 'Think first' })
    await f.action(id, { type: 'complete', text: 'Answer.', thought: 'Consider the input.' })
    await expect.poll(async () => (await thread(f.host))?.status).toBe('idle')
    expect(await thoughts(f.host)).toEqual([expect.objectContaining({ title: 'Thinking', status: 'completed', text: 'Consider the input.', turnId: 'user', afterMessageId: 'user' })])
    expect((await replies(f.host)).map(message => message.text)).toEqual(['Answer.'])
  } finally { await f.cleanup() }
})
