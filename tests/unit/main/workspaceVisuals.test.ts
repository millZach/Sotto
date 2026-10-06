// @vitest-environment node
/**
 * A visual an agent draws, through the workspace (ADR-0055): kept with the thread, anchored to the newest message when
 * the call arrives, published live into the open window, and gone or kept with history the way the thread's words are.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentHostSnapshot, AgentMessage } from '../../../src/shared/agents'
import type { AgentHostResult, ThreadHostEvent } from '../../../src/main/agents/host'
import type { ThreadEvent } from '../../../src/shared/threadEvents'
import { WorkspaceHost } from '../../../src/main/agents/workspace'
import { VISUAL_FALLBACK_NOTE, type VisualInput } from '../../../src/shared/visuals'
import { FakeProviderHost } from '../../fixtures/fakeProviderHost'

/** A provider that says what changed, and confirms a rewind by resetting its history to the turns it kept. */
class EventProviderHost extends FakeProviderHost {
  private readonly eventListeners = new Set<(event: ThreadHostEvent) => void>()
  history: AgentMessage[] = []
  rewound: { removed: number; expected: readonly string[] }[] = []
  rewindResult: AgentHostResult = { accepted: true }
  subscribeEvents(listener: (event: ThreadHostEvent) => void): () => void {
    this.eventListeners.add(listener)
    return () => { this.eventListeners.delete(listener) }
  }
  publish(threadId: string, event: ThreadEvent): void {
    for (const listener of this.eventListeners) listener({ threadId, event })
  }
  say(message: AgentMessage): void {
    this.history.push(message)
    this.publish(THREAD, { kind: 'message-added', at: message.createdAt, message })
  }
  /** The provider rebuilds its history from its own record: a reset, then every message again under the same IDs. */
  resetFromHistory(epoch: string): void {
    this.publish(THREAD, { kind: 'messages-reset', at: at(90), historyEpoch: epoch })
    for (const message of this.history) this.publish(THREAD, { kind: 'message-added', at: message.createdAt, message })
  }
  async rollbackThread(_threadId: string, removed: number, expected: readonly string[]): Promise<AgentHostResult> {
    this.rewound.push({ removed, expected: [...expected] })
    if (!this.rewindResult.accepted || this.rewindResult.uncertain) return this.rewindResult
    const firstRemoved = this.history.findIndex(message => message.id === expected[expected.length - removed])
    this.history = this.history.slice(0, firstRemoved)
    this.resetFromHistory(`rewound-${this.rewound.length}`)
    return this.rewindResult
  }
}

const THREAD = 'session-workshop'
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

async function root(): Promise<string> {
  const created = await mkdtemp(join(tmpdir(), 'sotto-workspace-visuals-'))
  cleanup.push(async () => {
    if (dirname(resolve(created)) !== resolve(tmpdir()) || !created.includes('sotto-workspace-visuals-')) throw new Error('Unexpected test directory')
    await rm(created, { recursive: true, force: true })
  })
  return created
}

async function opened(directory: string, adapter = new EventProviderHost(), history: () => boolean = () => true) {
  const host = new WorkspaceHost(adapter, directory, history)
  let closed = false
  const close = async (): Promise<void> => { if (closed) return; closed = true; host.disconnect(); await host.privacyChanged().catch(() => undefined); host.dispose() }
  cleanup.push(close)
  await host.initialize()
  await host.connect()
  host.observeThreads([THREAD])
  return { host, adapter, close }
}

const at = (index: number): string => new Date(Date.UTC(2026, 9, 6, 10, 0, index)).toISOString()
const user = (id: string, index: number): AgentMessage => ({ id, role: 'user', text: `Prompt ${id}`, createdAt: at(index) })
const reply = (id: string, index: number, text = `Reply ${id}`): AgentMessage => ({ id, role: 'assistant', text, createdAt: at(index) })
const input = (title = 'How a send moves'): VisualInput => ({ title, kind: 'diagram', source: 'flowchart LR\n  A[Draft] --> B[Sent]', intro: 'The short way.', steps: [{ text: 'A draft is sent.', highlight: ['A->B'] }] })
const window = (host: WorkspaceHost): string[] => host.workspaceSnapshot().threads.find(thread => thread.id === THREAD)!.messages.map(message => message.id)

describe('a visual through the workspace', () => {
  it('lands live between the words before the call and the words after it, and is there after a restart', async () => {
    const directory = await root()
    const { host, adapter, close } = await opened(directory)
    const published: AgentHostSnapshot[] = []
    host.subscribe(snapshot => published.push(snapshot))
    adapter.say(user('u1', 0))
    adapter.say(reply('a1', 1, 'Here is how a send moves:'))
    // The provider's words before the call are still waiting to be written when the call arrives.
    const added = await host.addVisual(THREAD, input())
    expect(added).toMatchObject({ added: true, anchor: 'assistant', visual: { title: 'How a send moves', kind: 'diagram' } })
    // The open window was given it without being asked again, within one publish window.
    const visualId = `visual:${added.added ? added.visual.id : ''}`
    const lastPublished = (): AgentMessage[] => published.at(-1)!.threads.find(thread => thread.id === THREAD)!.messages
    await vi.waitFor(() => expect(lastPublished().map(message => message.id)).toEqual(['u1', 'a1', visualId]))
    const live = lastPublished()
    expect(live.at(-1)).toMatchObject({ role: 'assistant', visual: { title: 'How a send moves', steps: [{ text: 'A draft is sent.', highlight: ['A->B'] }] } })
    expect(live.at(-1)!.text).toBe(`**How a send moves**\n\nThe short way.\n\n1. A draft is sent.\n\n${VISUAL_FALLBACK_NOTE}`)
    adapter.say(reply('a2', 3, 'That is the whole path.'))
    expect(window(host)).toEqual(['u1', 'a1', visualId, 'a2'])
    // Sidebar facts keep the agent's words.
    expect(host.workspaceSnapshot().threads.find(thread => thread.id === THREAD)!.summary).toMatchObject({ messageCount: 3, lastAssistant: { text: 'That is the whole path.' } })
    await close()

    const restarted = await opened(directory, new EventProviderHost())
    expect(window(restarted.host)).toEqual(['u1', 'a1', visualId, 'a2'])
  })

  it('stays where it was when the provider rebuilds its history by itself, as Grok does', async () => {
    const { host, adapter } = await opened(await root())
    adapter.say(user('u1', 0))
    adapter.say(reply('a1', 1))
    const added = await host.addVisual(THREAD, input())
    adapter.say(reply('a2', 3))
    adapter.resetFromHistory('coalesced')
    expect(window(host)).toEqual(['u1', 'a1', `visual:${added.added ? added.visual.id : ''}`, 'a2'])
  })

  it('goes with a confirmed rewind of its turn, and stays after a rewind of a later turn', async () => {
    const { host, adapter } = await opened(await root())
    adapter.say(user('u1', 0)); adapter.say(reply('a1', 1))
    const early = await host.addVisual(THREAD, input('Early'))
    adapter.say(user('u2', 2)); adapter.say(reply('a2', 3))
    await host.addVisual(THREAD, input('Late'))
    adapter.say(user('u3', 4)); adapter.say(reply('a3', 5))
    const earlyId = `visual:${early.added ? early.visual.id : ''}`

    // Rewinding the third turn takes nothing drawn in it, so both visuals stay.
    await host.rollbackThread(THREAD, 1, ['u1', 'u2', 'u3'])
    expect(window(host)).toEqual(['u1', 'a1', earlyId, 'u2', 'a2', expect.stringMatching(/^visual:/u)])
    // Rewinding the second takes its visual with it; the first turn's stays.
    await host.rollbackThread(THREAD, 1, ['u1', 'u2'])
    expect(window(host)).toEqual(['u1', 'a1', earlyId])
    expect(adapter.rewound.map(item => item.removed)).toEqual([1, 1])
  })

  it('keeps a visual when a rewind is refused or unconfirmed', async () => {
    const { host, adapter } = await opened(await root())
    adapter.say(user('u1', 0)); adapter.say(reply('a1', 1))
    await host.addVisual(THREAD, input())
    adapter.rewindResult = { accepted: false, uncertain: true }
    await host.rollbackThread(THREAD, 1, ['u1'])
    expect(window(host)).toHaveLength(3)
  })

  it('is gone once Keep local history turns off, and one drawn while it is off lasts this run only', async () => {
    const directory = await root()
    let keep = true
    const { host, adapter, close } = await opened(directory, new EventProviderHost(), () => keep)
    adapter.say(user('u1', 0)); adapter.say(reply('a1', 1))
    await host.addVisual(THREAD, input())
    expect(window(host)).toHaveLength(3)
    keep = false
    await host.privacyChanged()
    expect(window(host).some(id => id.startsWith('visual:'))).toBe(false)
    adapter.say(user('u2', 2))
    expect(await host.addVisual(THREAD, input('Private'))).toMatchObject({ added: true, anchor: 'user' })
    expect(window(host).filter(id => id.startsWith('visual:'))).toHaveLength(1)
    await close()
    const restarted = await opened(directory, new EventProviderHost(), () => false)
    expect(window(restarted.host).some(id => id.startsWith('visual:'))).toBe(false)
  })

  it('refuses a thread it does not hold, a seventh visual in one turn and a hundred and first in a thread', async () => {
    const { host, adapter } = await opened(await root())
    expect(await host.addVisual('no-such-thread', input())).toEqual({ added: false, reason: 'unknown-thread' })
    adapter.say(user('u0', 0))
    for (let count = 0; count < 6; count++) expect((await host.addVisual(THREAD, input())).added).toBe(true)
    expect(await host.addVisual(THREAD, input())).toEqual({ added: false, reason: 'turn-limit' })
    for (let turn = 1; turn <= 16; turn++) {
      adapter.say(user(`u${turn}`, turn))
      for (let count = 0; count < (turn === 16 ? 4 : 6); count++) expect((await host.addVisual(THREAD, input())).added).toBe(true)
    }
    adapter.say(user('u17', 17))
    expect(await host.addVisual(THREAD, input())).toEqual({ added: false, reason: 'thread-limit' })
  })
})
