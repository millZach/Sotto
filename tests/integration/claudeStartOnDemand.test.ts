// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentControl } from '../../src/main/agents/control'
import { ConfiguredProviderHost } from '../../src/main/agents/providerSwitch'
import { SottoThreadHost, ThreadRegistry } from '../../src/main/agents/threads'
import { WorkspaceHost } from '../../src/main/agents/workspace'
import { e2eAgentReasoner } from '../../src/main/e2e/agentEffects'
import { EMPTY_AGENT_HOST } from '../../src/shared/agents'
import { createAgentControl } from '../fixtures/agentControlFixture'
import { claudeFixture, savedClaudeThreads } from '../fixtures/claudeFixture'
import { FakeProviderHost } from '../fixtures/fakeProviderHost'
import { testCredentials } from '../fixtures/testCredentials'

// Putting a Claude thread on screen started its Claude Code CLI, and the reaper never stopped a CLI behind a pane, so
// browsing ten saved threads held ten CLIs of 104-308 MB each (#992). A thread on screen is now read from its
// transcript only. Its CLI starts when the user types, sends or acts on it; the threads Sotto sends to unasked or waits
// on (Watcher's, a delegation's, a queued follow-up's, an outbox entry's) are the live-session set, which keeps one
// (ADR-0016 and ADR-0038, November 1, 2026 amendments). Counts, not timings: these run in the default suite.
type Fixture = Awaited<ReturnType<typeof claudeFixture>>
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

const entry = (session: string, text: string): string => JSON.stringify({ type: 'user', uuid: randomUUID(), sessionId: session, timestamp: new Date().toISOString(), message: { role: 'user', content: text } })

/** `count` saved Claude threads, as an earlier run left them, each with one message in its transcript. */
async function saved(count: number, session: Parameters<typeof claudeFixture>[3] = {}): Promise<{ f: Fixture; ids: string[] }> {
  const root = await mkdtemp(join(tmpdir(), 'sotto-claude-start-'))
  const { sessions } = await savedClaudeThreads(root, count, (native, index) => `${entry(native, `Saved ${index}`)}\n`)
  const f = await claudeFixture(root, 15_000, undefined, session)
  cleanups.push(() => f.cleanup())
  return { f, ids: [...sessions.keys()] }
}
/** Every Claude Code CLI the fake client saw start for a thread, whichever thread; the account's own metadata call is not one. */
const launches = async (f: Fixture): Promise<number> => (await f.driver.requests()).filter(record => (record.method === 'launch' || record.method === 'resume')
  && !(record.params?.frame as { args?: string[] } | undefined)?.args?.includes('--no-session-persistence')).length
/** The adapter's threads whose CLI is running, as it publishes them. */
const open = async (f: Fixture): Promise<string[]> => (await f.adapter.snapshot()).threads.filter(thread => thread.providerSessionOpen).map(thread => thread.id).sort()
const sorted = (ids: readonly string[]): string[] => [...ids].sort()

describe('Claude Code starts on demand', () => {
  it('starts no CLI for ten threads on screen, one for each delegated thread, and one when typing starts', async () => {
    const { f, ids } = await saved(10)
    // The coordinator, the workspace, the provider switch and the Sotto thread host over the adapter, as main wires them.
    const registry = new ThreadRegistry(join(f.root, 'identity'))
    await registry.load()
    const sottoIds: string[] = ids.map(id => { const sottoId = randomUUID(); registry.reserve(sottoId, 'claude', id, f.projectId); return sottoId })
    await registry.flush()
    const native = new ConfiguredProviderHost({ directory: join(f.root, 'switch'), provider: () => 'claude', enabledProviders: () => ['claude'], threadProvider: id => registry.byThread(id)?.provider,
      hosts: { claude: new SottoThreadHost('claude', f.adapter, registry), codex: new FakeProviderHost(), grok: new FakeProviderHost(), devin: new FakeProviderHost(),
        muse: new FakeProviderHost(structuredClone(EMPTY_AGENT_HOST)), opencode: new FakeProviderHost(structuredClone(EMPTY_AGENT_HOST)), cursor: new FakeProviderHost(structuredClone(EMPTY_AGENT_HOST)), deepseek: new FakeProviderHost(structuredClone(EMPTY_AGENT_HOST)) } })
    const workspace = new WorkspaceHost(native, join(f.root, 'workspace'))
    const credentials = await testCredentials(f.root, { mode: 'unavailable' })
    const control: AgentControl = createAgentControl({ directory: join(f.root, 'control'), host: workspace, credentials, reasoner: e2eAgentReasoner })
    cleanups.push(async () => { control.dispose(); await control.privacyChanged(); workspace.dispose(); await registry.flush() })
    await control.start()
    await control.command({ type: 'connect' })
    await expect.poll(() => control.get().host.threads.filter(thread => sottoIds.includes(thread.id)).length).toBe(10)
    expect(await launches(f)).toBe(0)

    // Ten panes, as browsing ten saved threads leaves them. Before: ten CLIs asked for here, one per pane.
    const starts = vi.spyOn(f.adapter as unknown as { start(id: string): Promise<unknown> }, 'start')
    await control.command({ type: 'observe-threads', threadIds: sottoIds })
    expect(starts).not.toHaveBeenCalled()
    // Each pane's transcript is still read, and its messages held for the window.
    await expect.poll(async () => (await f.adapter.snapshot()).threads.filter(thread => ids.includes(thread.id) && thread.messages.length > 0).length).toBe(10)
    expect(await launches(f)).toBe(0)
    expect(await open(f)).toEqual([])

    // Two of them become a delegation's: the coordinator keeps their sessions live, and only theirs start.
    let delegated: string[] = [sottoIds[0]!, sottoIds[1]!]
    control.useDelegation({ userCommand: () => undefined, observe: () => undefined, observedThreadIds: () => delegated, messageIdFor: () => undefined, guardFor: () => undefined })
    await expect.poll(() => open(f)).toEqual(sorted([ids[0]!, ids[1]!]))
    expect(await launches(f)).toBe(2)

    // Typing in a third starts its CLI (ADR-0057), and nothing else.
    await control.command({ type: 'start-thread-session', threadId: sottoIds[2]! })
    await expect.poll(() => open(f)).toEqual(sorted([ids[0]!, ids[1]!, ids[2]!]))
    expect(await launches(f)).toBe(3)

    // A delegation that ends lets its threads go back to being only on screen: their CLIs stay until the reaper finds
    // them idle, and none starts again.
    delegated = []
    control.refreshDelegationObservation()
    expect(await open(f)).toEqual(sorted([ids[0]!, ids[1]!, ids[2]!]))
    expect(await launches(f)).toBe(3)
  })

  it('connects with ten threads on screen and starts only the threads kept live', async () => {
    const { f, ids } = await saved(10)
    // As the coordinator names them: the live-session set first, then what it observes.
    f.adapter.keepSessionsLive([ids[3]!, ids[7]!])
    f.adapter.observeThreads(ids)
    // Connect waits for the starts it makes, so the count is exact as it returns.
    await f.host.connect()
    expect(await launches(f)).toBe(2)
    expect(await open(f)).toEqual(sorted([ids[3]!, ids[7]!]))
    // Every observed thread's transcript was read all the same.
    expect((await f.adapter.snapshot()).threads.filter(thread => thread.messages.length > 0)).toHaveLength(10)
  })

  it('starts a thread on screen when it is sent to', async () => {
    const { f, ids } = await saved(2)
    await f.host.connect()
    f.adapter.keepSessionsLive([])
    f.adapter.observeThreads(ids)
    expect(await launches(f)).toBe(0)
    expect(await f.host.execute({ type: 'send', threadId: ids[0]!, commandId: randomUUID(), messageId: randomUUID(), text: 'Plan the trip' })).toMatchObject({ accepted: true })
    // The saved transcript's message was typed outside Sotto, so the send may resume the session again to take it over:
    // the count that matters is which threads have a CLI.
    expect(await open(f)).toEqual([ids[0]!])
    expect(await f.sessions!.starts(ids[1]!)).toBe(0)
  })

  it('lets the reaper stop an idle CLI behind a pane, and never one kept live', async () => {
    // Short enough to watch a sweep happen; the assertion is the stop itself, so the deadline is generous.
    const { f, ids } = await saved(2, { reaperSweepMs: 20, sessionIdleMs: 150 })
    const [pane, kept] = ids as [string, string]
    await f.host.connect()
    f.adapter.keepSessionsLive([kept])
    f.adapter.observeThreads([pane, kept])
    await f.adapter.startThreadSession(pane)
    await expect.poll(() => open(f)).toEqual(sorted([pane, kept]))
    await expect.poll(() => f.sessions!.stopped(pane), { timeout: 12_000 }).toBe(true)
    expect(await f.sessions!.stopped(kept)).toBe(false)
    expect(await open(f)).toEqual([kept])
    // Still on screen, the stopped thread keeps its messages and starts nothing until the user acts on it again.
    f.adapter.keepSessionsLive([kept])
    f.adapter.observeThreads([pane, kept])
    expect((await f.adapter.snapshot()).threads.find(thread => thread.id === pane)!.messages.map(message => message.text)).toEqual(['Saved 0'])
    expect(await f.sessions!.starts(pane)).toBe(1)
  })

  it('still starts every observed thread for a caller that never names a live-session set', async () => {
    const { f, ids } = await saved(2)
    await f.host.connect()
    f.adapter.observeThreads(ids)
    await expect.poll(() => open(f)).toEqual(sorted(ids))
    expect(await launches(f)).toBe(2)
  })
})
