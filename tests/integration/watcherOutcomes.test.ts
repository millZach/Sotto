// @vitest-environment node
// A Watcher brief's outcome, read from the thread its real provider adapter reports over the fake Codex and Claude
// Code processes (ADR-0073, October 14, 2026: outcomes). The brief's own message ties it to the turn that answers it.
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentHost } from '../../src/main/agents/host'
import { watcherTurnOutcome } from '../../src/main/agents/watcherOutcomes'
import type { WatcherOperation } from '../../src/shared/watcher'
import { claudeFixture } from '../fixtures/claudeFixture'
import { codexFixture } from '../fixtures/codexFixture'

interface Fixture { host: AgentHost; projectId: string; modelId: string; root: string; cleanup(): Promise<void>
  driver: { completeTurn(id: string, text: string): Promise<unknown> }; action(id: string, value: Record<string, unknown>): Promise<unknown> }
const fixtures: Fixture[] = []
afterEach(async () => { for (const f of fixtures.splice(0).reverse()) await f.cleanup() })

const providers = {
  claude: async (script: Record<string, unknown> = { steering: true }) => {
    const f = await claudeFixture(undefined, 15_000)
    await writeFile(join(f.root, 'script.json'), JSON.stringify(script))
    return f
  },
  codex: async () => codexFixture(undefined, false, 15_000),
}

async function worker(provider: keyof typeof providers, script?: Record<string, unknown>) {
  const f = await providers[provider](script) as unknown as Fixture
  fixtures.push(f)
  await f.host.connect()
  const id = randomUUID()
  await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Outcomes', path: f.root })
  await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f.projectId, modelId: f.modelId, title: 'Worker' })
  await f.host.refreshThread?.(id)
  // The messages Watcher sent; any other user message is the user's own.
  const watcherMessages = new Set<string>()
  const thread = async () => (await f.host.snapshot()).threads.find(item => item.id === id)!
  const brief = async (delivery: 'now' | 'queue' | 'steer', text: string, user = false): Promise<Pick<WatcherOperation, 'messageId' | 'delivery'>> => {
    const messageId = randomUUID()
    if (!user) watcherMessages.add(messageId)
    const result = delivery === 'steer' ? await f.host.execute({ type: 'steer', commandId: randomUUID(), messageId, threadId: id, text })
      : await f.host.execute({ type: 'send', commandId: randomUUID(), messageId, threadId: id, text })
    expect(result).toEqual({ accepted: true })
    await expect.poll(async () => (await thread()).messages.some(message => message.role === 'user' && message.id === messageId)).toBe(true)
    return { messageId, delivery }
  }
  const outcome = async (operation: Pick<WatcherOperation, 'messageId' | 'delivery'>) => watcherTurnOutcome(operation, await thread(), messageId => watcherMessages.has(messageId))
  const replyText = async (messageId: string | undefined) => (await thread()).messages.find(message => message.id === messageId)?.text
  const idle = async () => { await expect.poll(async () => (await thread()).status).toBe('idle') }
  return { f, id, thread, brief, outcome, replyText, idle }
}

describe.each(['claude', 'codex'] as const)('%s', provider => {
  it('goes working, then answered with the exact reply of the turn its start began', async () => {
    const w = await worker(provider)
    const start = await w.brief('now', 'Synthetic first brief')
    expect(await w.outcome(start)).toMatchObject({ outcome: 'working', turnMessageId: start.messageId })
    await w.f.driver.completeTurn(w.id, 'Synthetic worker reply')
    await w.idle()
    await expect.poll(() => w.outcome(start)).toMatchObject({ outcome: 'answered', turnMessageId: start.messageId, replyMessageId: expect.any(String) })
    expect(await w.replyText((await w.outcome(start))?.replyMessageId)).toBe('Synthetic worker reply')
  })

  it('folds a steer into the turn it was read into, sharing that turn\'s answer', async () => {
    // Claude Code here reads a steer into the running turn, as Codex does, rather than cutting the turn for it.
    const w = await worker(provider, { steering: 'queue' })
    const first = await w.brief('now', 'Synthetic brief')
    const steer = await w.brief('steer', 'Synthetic steer')
    expect(await w.outcome(steer)).toMatchObject({ outcome: 'working', turnMessageId: first.messageId })
    // The turn takes a model step, where Claude Code reads the steer in.
    if (provider === 'claude') {
      await w.f.action(w.id, { type: 'say', text: 'Synthetic step' })
      await expect.poll(async () => (await w.thread()).messages.some(message => message.text === 'Synthetic step')).toBe(true)
    }
    await w.f.driver.completeTurn(w.id, 'Synthetic answer to both')
    await w.idle()
    await expect.poll(() => w.outcome(first)).toMatchObject({ outcome: 'answered' })
    const answered = await w.outcome(first)
    expect(await w.outcome(steer)).toEqual(answered)
    expect(await w.replyText(answered?.replyMessageId)).toBe('Synthetic answer to both')
  })

  it('gives a queued send its own turn and answer', async () => {
    const w = await worker(provider)
    const first = await w.brief('now', 'Synthetic brief')
    await w.f.driver.completeTurn(w.id, 'Synthetic first answer')
    await w.idle()
    // A queued send is delivered once the turn before it has ended, as its own prompt.
    const queued = await w.brief('queue', 'Synthetic queued brief')
    await w.f.driver.completeTurn(w.id, 'Synthetic second answer')
    await w.idle()
    await expect.poll(() => w.outcome(queued)).toMatchObject({ outcome: 'answered', turnMessageId: queued.messageId })
    const own = await w.outcome(queued), earlier = await w.outcome(first)
    expect(earlier).toMatchObject({ outcome: 'answered', turnMessageId: first.messageId })
    expect(own?.replyMessageId).not.toBe(earlier?.replyMessageId)
    expect(await w.replyText(own?.replyMessageId)).toBe('Synthetic second answer')
    expect(await w.replyText(earlier?.replyMessageId)).toBe('Synthetic first answer')
  })

  it('pauses a brief whose turn the user\'s own message took over, and stops one that was only stopped', async () => {
    const w = await worker(provider)
    const stopped = await w.brief('now', 'Synthetic brief to stop')
    expect(await w.f.host.execute({ type: 'interrupt', commandId: randomUUID(), threadId: w.id })).toEqual({ accepted: true })
    await w.idle()
    await expect.poll(() => w.outcome(stopped)).toMatchObject({ outcome: 'stopped', turnMessageId: stopped.messageId })
    const held = await w.brief('now', 'Synthetic brief the user takes over')
    expect(await w.f.host.execute({ type: 'interrupt', commandId: randomUUID(), threadId: w.id })).toEqual({ accepted: true })
    await w.idle()
    await w.brief('now', 'Synthetic message of the user\'s own', true)
    await expect.poll(() => w.outcome(held)).toMatchObject({ outcome: 'paused', turnMessageId: held.messageId })
    expect(await w.outcome(stopped)).toMatchObject({ outcome: 'stopped' })
  })
})

describe('claude', () => {
  it('follows a turn Claude Code cut for Watcher\'s own steer into the turn the steer runs as', async () => {
    const w = await worker('claude')
    const first = await w.brief('now', 'Synthetic brief')
    const steer = await w.brief('steer', 'Synthetic steer that cuts the turn')
    await w.f.driver.completeTurn(w.id, 'Synthetic answer after the cut')
    await w.idle()
    await expect.poll(() => w.outcome(first)).toMatchObject({ outcome: 'answered', turnMessageId: steer.messageId })
    expect(await w.outcome(steer)).toEqual(await w.outcome(first))
    expect(await w.replyText((await w.outcome(first))?.replyMessageId)).toBe('Synthetic answer after the cut')
  })

  it('gives a steer the turn ended before reading its own turn and answer', async () => {
    const w = await worker('claude', { steering: 'queue' })
    const first = await w.brief('now', 'Synthetic brief')
    const steer = await w.brief('steer', 'Synthetic steer read too late')
    await w.f.driver.completeTurn(w.id, 'Synthetic first answer')
    await expect.poll(() => w.outcome(first)).toMatchObject({ outcome: 'answered', turnMessageId: first.messageId })
    await expect.poll(() => w.outcome(steer)).toMatchObject({ outcome: 'working', turnMessageId: steer.messageId })
    await w.f.driver.completeTurn(w.id, 'Synthetic second answer')
    await w.idle()
    await expect.poll(() => w.outcome(steer)).toMatchObject({ outcome: 'answered', turnMessageId: steer.messageId })
    expect(await w.replyText((await w.outcome(steer))?.replyMessageId)).toBe('Synthetic second answer')
    expect(await w.replyText((await w.outcome(first))?.replyMessageId)).toBe('Synthetic first answer')
  })

  it('pauses a brief whose turn the user cut with a steer of their own', async () => {
    const w = await worker('claude')
    const brief = await w.brief('now', 'Synthetic brief')
    await w.brief('steer', 'Synthetic steer of the user\'s own', true)
    await w.f.driver.completeTurn(w.id, 'Synthetic answer to the user')
    await w.idle()
    await expect.poll(() => w.outcome(brief)).toMatchObject({ outcome: 'paused', turnMessageId: brief.messageId })
  })

  it('reads a turn that left background work running as background, then answered once the work ends', async () => {
    const f = await claudeFixture(undefined, 15_000)
    fixtures.push(f as unknown as Fixture)
    await f.host.connect()
    const id = randomUUID(), messageId = randomUUID()
    await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Outcomes', path: f.root })
    await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f.projectId, modelId: f.modelId, title: 'Worker' })
    expect(await f.host.execute({ type: 'send', commandId: randomUUID(), messageId, threadId: id, text: 'Synthetic brief' })).toEqual({ accepted: true })
    const thread = async () => (await f.host.snapshot()).threads.find(item => item.id === id)!
    const outcome = async () => watcherTurnOutcome({ messageId, delivery: 'now' }, await thread(), candidate => candidate === messageId)
    await f.driver.backgroundWork!.completeLeaving(id, 'Synthetic answer, agent still running', 'Synthetic background agent')
    await expect.poll(async () => (await thread()).backgroundWork?.length ?? 0).toBe(1)
    await expect.poll(outcome).toMatchObject({ outcome: 'background', turnMessageId: messageId })
    await f.driver.backgroundWork!.end(id)
    await expect.poll(outcome).toMatchObject({ outcome: 'answered', turnMessageId: messageId, replyMessageId: expect.any(String) })
    const replyId = (await outcome())?.replyMessageId
    expect((await thread()).messages.find(message => message.id === replyId)?.text).toBe('Synthetic answer, agent still running')
  })
})
