// @vitest-environment node
/**
 * A thread's summary says when its running turn began (`runningTurnStartedAt`), and stops saying it in the same update that
 * ends the turn (#2697). On a host that keeps history from events, a provider's update kept the summary its history last
 * gave; the referee harness caught a turn whose activity record ended in an update after the reply's last event still running
 * in the summary, until the thread next changed, and a turn whose activity record opened after the prompt's event never
 * running in it. Codex can also say its thread is idle before the turn's activity record ends.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ThreadHostEvent } from '../../../src/main/agents/host'
import { WorkspaceHost } from '../../../src/main/agents/workspace'
import type { AgentActivity } from '../../../src/shared/agentActivity'
import type { AgentMessage, AgentThread } from '../../../src/shared/agents'
import { FakeProviderHost } from '../../fixtures/fakeProviderHost'

/** A provider that says what its history did event by event, as the native adapters do, so the workspace keeps history from events. */
class EventProvider extends FakeProviderHost {
  private readonly events = new Set<(event: ThreadHostEvent) => void>()
  subscribeEvents(listener: (event: ThreadHostEvent) => void): () => void {
    this.events.add(listener)
    return () => this.events.delete(listener)
  }
  said(message: AgentMessage): void {
    for (const listener of this.events) listener({ threadId: SESSION, event: { kind: 'message-added', at: message.createdAt, message } })
  }
  /** Changes the thread as the provider holds it and publishes the provider's state. */
  update(edit: (thread: AgentThread) => void): void {
    edit(this.state.threads.find(thread => thread.id === SESSION)!)
    this.emit()
  }
}

const SESSION = 'session-workshop'
const STARTED = '2026-11-19T10:00:00.000Z'
const ENDED = '2026-11-19T10:00:05.000Z'
const turn = (status: AgentActivity['status']): AgentActivity => ({ id: 'fake-turn-prompt', turnId: 'prompt', sequence: 1, kind: 'turn', status,
  title: status === 'running' ? 'Working' : 'Turn completed', startedAt: STARTED, timingSource: 'observed', afterMessageId: 'prompt',
  ...(status === 'running' ? {} : { completedAt: ENDED }) })
const prompt: AgentMessage = { id: 'prompt', role: 'user', text: 'Prompt', createdAt: STARTED }
const reply: AgentMessage = { id: 'reply', role: 'assistant', text: 'Reply', createdAt: ENDED }

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

async function fixture(watched: boolean) {
  const directory = await mkdtemp(join(tmpdir(), 'sotto-running-turn-'))
  cleanup.push(async () => {
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !directory.includes('sotto-running-turn-')) throw new Error('Unexpected test directory')
    await rm(directory, { recursive: true, force: true })
  })
  const provider = new EventProvider()
  const host = new WorkspaceHost(provider, directory, { historyEnabled: () => true, watcherEnabled: false })
  cleanup.push(() => { host.disconnect(); host.dispose() })
  await host.initialize()
  await host.connect()
  // A workspace counts every thread in view until a window says what it shows (ADR-0016), so the unwatched case says none.
  host.observeThreads(watched ? [SESSION] : [])
  const held = (): AgentThread => host.workspaceSnapshot().threads.find(thread => thread.id === SESSION)!
  return { provider, held }
}

describe.each([['a thread a pane is watching', true], ['a thread no pane is watching', false]])('the running turn in %s\'s summary', (_name, watched) => {
  it('goes in the update that ends the turn, when the reply\'s last event came before it (#2697)', async () => {
    const { provider, held } = await fixture(watched)
    provider.update(thread => { thread.status = 'running'; thread.activities = [turn('running')] })
    provider.said(prompt)
    provider.said(reply)
    expect(held().summary?.runningTurnStartedAt).toBe(STARTED)

    // The turn ends in the provider's next update, with no event: nothing about the thread's history changes.
    provider.update(thread => { thread.status = 'idle'; thread.activities = [turn('completed')] })
    const ended = held()
    expect(ended.status).toBe('idle')
    expect(ended.summary?.runningTurnStartedAt).toBeUndefined()
    expect(ended.summary).toMatchObject({ messageCount: 2, lastAssistant: { id: 'reply' } })
    // A watched thread holds its window; one nobody watches holds its summary alone.
    expect(ended.messages.map(message => message.id)).toEqual(watched ? ['prompt', 'reply'] : [])
  })

  it('goes in the update that says the thread is idle, when the turn\'s activity record ends after it', async () => {
    const { provider, held } = await fixture(watched)
    provider.update(thread => { thread.status = 'running'; thread.activities = [turn('running')] })
    provider.said(prompt)
    expect(held().summary?.runningTurnStartedAt).toBe(STARTED)

    provider.update(thread => { thread.status = 'idle' })
    expect(held().summary?.runningTurnStartedAt).toBeUndefined()
    // A message event that makes the summary again while the record still says running does not bring the turn back.
    provider.said(reply)
    expect(held().summary).toMatchObject({ messageCount: 2 })
    expect(held().summary?.runningTurnStartedAt).toBeUndefined()
  })

  it('comes in the update that opens the turn\'s activity record, when the prompt\'s event came before it', async () => {
    const { provider, held } = await fixture(watched)
    provider.said(prompt)
    expect(held().summary?.runningTurnStartedAt).toBeUndefined()

    provider.update(thread => { thread.status = 'running'; thread.activities = [turn('running')] })
    expect(held().summary).toMatchObject({ messageCount: 1, runningTurnStartedAt: STARTED })
  })
})
