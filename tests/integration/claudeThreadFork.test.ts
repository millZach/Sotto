// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { claudeFixture } from '../fixtures/claudeFixture'

// Fork from here on a Claude Code thread (#1028, E5b): Claude Code's own session fork, the one rewind uses, copies the
// conversation up to a reply into a new session, and the new Sotto thread is bound to it when it is made (ADR-0002).
// The source thread is left as it was. It runs the official SDK's history helper over the fake CLI's transcripts.

type Fixture = Awaited<ReturnType<typeof claudeFixture>>
const fixtures: Fixture[] = []
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.cleanup() })

async function twoTurns(): Promise<Fixture> {
  const f = await claudeFixture(); fixtures.push(f)
  await f.host.connect()
  await f.host.execute({ type: 'create-project', commandId: 'p', projectId: 'p', path: f.root, title: 'Synthetic' })
  await f.host.execute({ type: 'create-thread', commandId: 't', projectId: 'p', threadId: 'source', title: 'WAV preview stall', modelId: f.modelId })
  for (const id of ['first', 'second']) {
    await f.host.execute({ type: 'send', commandId: id, threadId: 'source', messageId: id, text: id })
    await f.driver.completeTurn('source', `${id} answer`)
    await expect.poll(async () => (await f.host.snapshot()).threads.find(thread => thread.id === 'source')!.status).toBe('idle')
  }
  return f
}

describe('forking a Claude Code thread at a reply', () => {
  it('copies the conversation up to the reply into a session bound to the new thread, keeping the first message’s own ID', async () => {
    const f = await twoTurns()
    const source = (await f.host.snapshot()).threads.find(thread => thread.id === 'source')!
    const reply = source.messages.find(message => message.text === 'first answer')!
    expect(await f.adapter.forkThread({ commandId: 'fork', threadId: 'fork', title: 'Fork of WAV preview stall', modelId: f.modelId, source: { threadId: 'source', messageId: reply.id } }))
      .toEqual({ accepted: true })
    const aliases = JSON.parse(await readFile(join(f.root, 'claude-threads.json'), 'utf8')) as Record<string, { sessionId: string }>
    expect(aliases.fork!.sessionId).not.toBe(aliases.source!.sessionId)
    const fork = (await f.host.snapshot()).threads.find(thread => thread.id === 'fork')!
    expect(fork.messages.map(message => message.text)).toEqual(['first', 'first answer'])
    expect(fork.messages[0]).toMatchObject({ id: 'first' })
    // The source thread is as it was.
    expect((await f.host.snapshot()).threads.find(thread => thread.id === 'source')!.messages.map(message => message.text)).toEqual(['first', 'first answer', 'second', 'second answer'])
    // The fork carries on as its own thread, and keeps its binding through a restart.
    expect(await f.host.execute({ type: 'send', commandId: 'third', threadId: 'fork', messageId: 'third', text: 'A different continuation' })).toEqual({ accepted: true })
    await f.driver.completeTurn('fork', 'third answer')
    await expect.poll(async () => (await f.host.snapshot()).threads.find(thread => thread.id === 'fork')!.messages.map(message => message.text))
      .toEqual(['first', 'first answer', 'A different continuation', 'third answer'])
    const restarted = await f.driver.restart() as Fixture
    try {
      await restarted.host.connect()
      const after = (await restarted.host.snapshot()).threads.find(thread => thread.id === 'fork')!
      expect(after.messages.map(message => message.text)).toEqual(['first', 'first answer', 'A different continuation', 'third answer'])
      expect(await restarted.realId('fork')).toBe(aliases.fork!.sessionId)
    } finally { restarted.host.disconnect(); await restarted.adapter.closed() }
  }, 30_000)

  it('refuses a reply the thread no longer has, an agent, and a thread that is working, and makes nothing', async () => {
    const f = await twoTurns()
    await expect(f.adapter.forkThread({ commandId: 'a', threadId: 'a', title: 'x', modelId: f.modelId, source: { threadId: 'source', messageId: 'not-a-reply' } }))
      .rejects.toThrow('Claude Code doesn’t have that reply in this thread any more')
    await expect(f.adapter.forkThread({ commandId: 'b', threadId: 'b', title: 'x', modelId: f.modelId, source: { threadId: 'source', agentId: 'claude-agent-1' } }))
      .rejects.toThrow('can’t be forked')
    await f.host.execute({ type: 'send', commandId: 'running', threadId: 'source', messageId: 'running', text: 'Keep going' })
    await expect.poll(async () => (await f.host.snapshot()).threads.find(thread => thread.id === 'source')!.status).toBe('running')
    const reply = (await f.host.snapshot()).threads.find(thread => thread.id === 'source')!.messages.find(message => message.text === 'first answer')!
    await expect(f.adapter.forkThread({ commandId: 'c', threadId: 'c', title: 'x', modelId: f.modelId, source: { threadId: 'source', messageId: reply.id } }))
      .rejects.toThrow('Wait for this turn to finish')
    const aliases = JSON.parse(await readFile(join(f.root, 'claude-threads.json'), 'utf8')) as Record<string, unknown>
    expect(Object.keys(aliases).sort()).toEqual(['source'])
  }, 30_000)
})
