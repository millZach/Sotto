// @vitest-environment node
import { AgentControl } from '../../src/main/agents/control'
import { testCredentials } from '../fixtures/testCredentials'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { WorkspaceHost } from '../../src/main/agents/workspace'
import { ThreadStore } from '../../src/main/agents/threadStore'
import { SubagentStore } from '../../src/main/agents/subagentStore'

import { e2eAgentReasoner } from '../../src/main/e2e/agentEffects'
import type { ThreadHostEvent } from '../../src/main/agents/host'
import { threadEventSchema, type ThreadEvent } from '../../src/shared/threadEvents'
import { FakeProviderHost } from '../fixtures/fakeProviderHost'

vi.mock('electron', async () => (await import('../fixtures/preloadElectron')).preloadElectron())
import { createSottoBridge } from '../../src/preload'

class EventProvider extends FakeProviderHost {
  private readonly events = new Set<(event: ThreadHostEvent) => void>()
  subscribeEvents(listener: (event: ThreadHostEvent) => void): () => void {
    this.events.add(listener)
    return () => this.events.delete(listener)
  }
  publish(event: ThreadEvent, threadId = 'session-workshop'): void {
    for (const listener of this.events) listener({ threadId, event })
  }
}
const at = '2026-09-27T00:00:00.000Z'
const added = (id = 'reply', text = 'First chunk'): ThreadEvent => ({ kind: 'message-added', at, message: { id, role: 'assistant', text, createdAt: at } })
const appended = (appendText = ' continued'): ThreadEvent => ({ kind: 'message-text-appended', at, messageId: 'reply', appendText })
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  for (const close of cleanup.splice(0).reverse()) await close()
})
async function fixture(history: () => boolean = () => true, initialize = true) {
  const directory = await mkdtemp(join(tmpdir(), 'sotto-history-retry-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const adapter = new EventProvider()
  const host = new WorkspaceHost(adapter, directory, history)
  cleanup.push(async () => { await host.close().catch(() => undefined) })
  if (initialize) {
    await host.initialize()
    await host.connect()
    host.observeThreads(['session-workshop'])
  }
  return { directory, adapter, host }
}
function failWrites() {
  return vi.spyOn(ThreadStore.prototype, 'appendMany').mockImplementation(() => { throw new Error('Synthetic unavailable storage') })
}

it('withholds identity repair evidence while newer words are waiting to be saved', async () => {
  const { adapter, host } = await fixture()
  adapter.publish(added())
  expect(host.message('session-workshop', 'reply')?.text).toBe('First chunk')
  const append = failWrites()
  adapter.publish(appended())
  expect(host.message('session-workshop', 'reply')).toBeUndefined()
  append.mockRestore()
  await expect.poll(() => host.message('session-workshop', 'reply')?.text).toBe('First chunk continued')
})

it('retains failed events in order through incoming text, an organization save, retry and restart', async () => {
  const { directory, adapter, host } = await fixture()
  const append = failWrites()
  adapter.publish(added())
  expect(host.workspaceSnapshot().error).toContain('Thread messages could not be saved')
  adapter.publish(appended())
  await host.renameThread('session-workshop', 'Saved name')
  expect(JSON.parse(await readFile(join(directory, 'workspace.json'), 'utf8')).snapshot.threads[0].title).toBe('Saved name')
  expect(host.workspaceSnapshot().error).toContain('Thread messages could not be saved')
  append.mockRestore()
  await expect.poll(() => host.workspaceSnapshot().error).toBeUndefined()
  expect(host.threadMessages('session-workshop')).toMatchObject([{ id: 'reply', text: 'First chunk continued' }])
  expect(host.eventsAfter(0).map(row => row.event.kind)).toEqual(['message-added', 'message-text-appended'])
  await host.close()
  const reopened = new WorkspaceHost(new EventProvider(), directory)
  cleanup.push(async () => { await reopened.close() })
  await reopened.initialize()
  reopened.observeThreads(['session-workshop'])
  expect(reopened.workspaceSnapshot().threads[0]?.messages).toMatchObject([{ id: 'reply', text: 'First chunk continued' }])
})

it('retries an outstanding batch during shutdown without waiting for its retry timer', async () => {
  const { directory, adapter, host } = await fixture()
  const append = failWrites()
  adapter.publish(added())
  expect(host.workspaceSnapshot().error).toContain('Thread messages could not be saved')
  adapter.publish(appended())
  append.mockRestore()
  await host.close()
  const reopened = new ThreadStore(join(directory, 'threads.sqlite'))
  reopened.open()
  try { expect(reopened.readMessages('session-workshop').messages).toMatchObject([{ text: 'First chunk continued' }]) }
  finally { reopened.close() }
})

it('paces persistent failures and reports that shutdown could not save the remaining history', async () => {
  const { adapter, host } = await fixture()
  vi.useFakeTimers()
  const append = failWrites()
  adapter.publish(added())
  host.workspaceSnapshot()
  for (let i = 0; i < 600; i++) { adapter.publish(appended('x')); host.workspaceSnapshot() }
  expect(append).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1_000)
  expect(append).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(2_000)
  expect(append).toHaveBeenCalledTimes(3)
  expect(host.workspaceSnapshot().error).toContain('Thread messages could not be saved')
  await expect(host.close()).rejects.toThrow('Thread messages could not be saved')
  expect(vi.getTimerCount()).toBe(0)
})

it('never writes retained failures to disk after history is turned off or back on', async () => {
  let history = true
  const { directory, adapter, host } = await fixture(() => history)
  const append = failWrites()
  adapter.publish(added('reply', 'PRIVATE FAILED TEXT'))
  host.workspaceSnapshot()
  history = false
  append.mockRestore()
  await host.privacyChanged()
  expect(host.threadMessages('session-workshop')).toMatchObject([{ text: 'PRIVATE FAILED TEXT' }])
  const offFailure = failWrites()
  adapter.publish(added('off', 'PRIVATE OFF TEXT'))
  host.workspaceSnapshot()
  history = true
  await host.privacyChanged()
  offFailure.mockRestore()
  adapter.publish(added('new', 'New retained reply'))
  await host.close()
  const disk = (await Promise.all((await readdir(directory)).map(file => readFile(join(directory, file), 'latin1').catch(() => '')))).join(' ')
  expect(disk).not.toContain('PRIVATE FAILED TEXT')
  expect(disk).not.toContain('PRIVATE OFF TEXT')
  const reopened = new ThreadStore(join(directory, 'threads.sqlite'))
  reopened.open()
  try { expect(reopened.readMessages('session-workshop').messages).toMatchObject([{ id: 'new', text: 'New retained reply' }]) }
  finally { reopened.close() }
})

it('keeps normal streaming coalesced and commits each event exactly once', async () => {
  const { adapter, host } = await fixture()
  vi.useFakeTimers()
  const append = vi.spyOn(ThreadStore.prototype, 'appendMany')
  const unsubscribe = host.subscribe(() => undefined)
  adapter.publish(added())
  for (let i = 0; i < 600; i++) adapter.publish(appended('x'))
  await vi.advanceTimersByTimeAsync(16)
  expect(append.mock.calls.length).toBeLessThanOrEqual(2)
  expect(host.eventsAfter(0, undefined, 1_000)).toHaveLength(601)
  expect(host.threadMessages('session-workshop')[0]?.text).toBe('First chunk' + 'x'.repeat(600))
  unsubscribe()
})

it('keeps a failed thread warning while another thread commits, then restores reset order', async () => {
  const { adapter, host } = await fixture()
  vi.useFakeTimers()
  const original = ThreadStore.prototype.appendMany
  const append = vi.spyOn(ThreadStore.prototype, 'appendMany').mockImplementation(function (this: ThreadStore, threadId, events) {
    if (threadId === 'session-workshop') throw new Error('Synthetic failure for one thread')
    return original.call(this, threadId, events)
  })
  adapter.publish(added())
  host.workspaceSnapshot()
  adapter.publish(added('other', 'Healthy thread'), 'other-thread')
  adapter.publish({ kind: 'messages-reset', at, historyEpoch: 'reset' })
  adapter.publish(added('replacement', 'After reset'))
  expect(host.eventsAfter(0).map(row => row.threadId)).toEqual(['other-thread'])
  expect(host.workspaceSnapshot().error).toContain('Thread messages could not be saved')
  append.mockRestore()
  await vi.advanceTimersByTimeAsync(1_000)
  expect(host.workspaceSnapshot().error).toBeUndefined()
  expect(host.threadMessages('session-workshop')).toMatchObject([{ id: 'replacement', text: 'After reset' }])
  expect(host.eventsAfter(0, 'session-workshop').map(row => row.event.kind)).toEqual(['message-added', 'messages-reset', 'message-added'])
})

it('retries a failed thread-store privacy switch and removes the retained words without restarting', async () => {
  let history = true
  const { directory, adapter, host } = await fixture(() => history)
  adapter.publish(added('reply', 'PRIVATE FAILED REDACTION'))
  host.workspaceSnapshot()
  const credentials = await testCredentials(directory, { mode: 'unavailable' })
  const control = new AgentControl({ directory, host, credentials, reasoner: e2eAgentReasoner, historyEnabled: () => history })
  vi.useFakeTimers()
  await control.start()
  cleanup.push(async () => { control.dispose(); await control.closed() })
  const transition = vi.spyOn(ThreadStore.prototype, 'becomeEphemeral').mockImplementationOnce(() => { throw new Error('Synthetic failed redaction') })
  history = false
  await expect(control.privacyChanged()).rejects.toThrow('Thread messages could not be removed')
  const disk = new ThreadStore(join(directory, 'threads.sqlite'))
  disk.open()
  try { expect(disk.readMessages('session-workshop').messages).toMatchObject([{ text: 'PRIVATE FAILED REDACTION' }]) }
  finally { disk.close() }
  await vi.advanceTimersByTimeAsync(30_000)
  expect(transition).toHaveBeenCalledTimes(2)
  disk.open()
  try { expect(disk.readMessages('session-workshop').messages).toEqual([]) }
  finally { disk.close() }
})

it('starts with history off and unavailable storage, then retries cleanup when storage returns', async () => {
  let history = false
  const { directory, adapter, host } = await fixture(() => history, false)
  const retained = new ThreadStore(join(directory, 'threads.sqlite'))
  retained.open()
  retained.replaceThreadMessages('session-workshop', [{ id: 'old-startup', role: 'user', text: 'OLD_STARTUP_MESSAGE', createdAt: at }])
  retained.close()
  const open = vi.spyOn(ThreadStore.prototype, 'open').mockImplementation(() => { throw new Error('Synthetic unavailable startup storage') })
  const credentials = await testCredentials(directory, { mode: 'unavailable' })
  const control = new AgentControl({ directory, host, credentials, reasoner: e2eAgentReasoner, historyEnabled: () => history })
  cleanup.push(async () => { control.dispose(); await control.closed() })
  vi.useFakeTimers()
  await expect(control.start()).resolves.toBeUndefined()
  expect(control.get().host.error).toContain('Thread messages could not be opened')
  await expect(host.connect()).resolves.toMatchObject({ connected: true })
  adapter.state.threads[0]!.activities = [{ id: 'private-startup', turnId: 'turn', sequence: 0, kind: 'tool', status: 'completed', title: 'Tool', output: 'PRIVATE_STARTUP_ACTIVITY' }]
  adapter.publish(added('private-startup', 'PRIVATE_STARTUP_MESSAGE'))
  await host.snapshot()
  await vi.advanceTimersByTimeAsync(30_000)
  await vi.waitFor(() => expect(control.get().error).toContain('Could not finish applying history privacy'))
  open.mockRestore()
  await vi.advanceTimersByTimeAsync(30_000)
  await vi.waitFor(() => expect(control.get().error).toBeNull())
  history = true
  await control.privacyChanged()
  adapter.state.threads[0]!.activities!.push({ id: 'fresh-startup', turnId: 'turn', sequence: 1, kind: 'tool', status: 'completed', title: 'Tool', output: 'Fresh startup activity' })
  adapter.publish(added('fresh-startup', 'Fresh startup message'))
  await host.snapshot()
  const disk = new ThreadStore(join(directory, 'threads.sqlite'))
  disk.open()
  try {
    expect(disk.readMessages('session-workshop').messages.map(message => message.text)).toEqual(['Fresh startup message'])
    expect(disk.readActivities('session-workshop').map(record => record.output)).toEqual(['Fresh startup activity'])
  } finally { disk.close() }
})

it('keeps the restart warning and coordinator retry pending while durable history is unavailable', async () => {
  let history = true
  const { directory, adapter, host } = await fixture(() => history)
  const credentials = await testCredentials(directory, { mode: 'unavailable' })
  const control = new AgentControl({ directory, host, credentials, reasoner: e2eAgentReasoner, historyEnabled: () => history })
  cleanup.push(async () => { control.dispose(); await control.closed() })
  vi.useFakeTimers()
  await control.start()
  history = false
  await control.privacyChanged()
  vi.spyOn(ThreadStore.prototype, 'open').mockImplementationOnce(() => { throw new Error('Synthetic failed durable open') })
  history = true
  await expect(control.privacyChanged()).rejects.toThrow('Thread messages could not be opened')
  const sync = vi.spyOn(ThreadStore.prototype, 'syncActivities')
  adapter.state.threads[0]!.activities = [{ id: 'unsaved', turnId: 'turn', sequence: 0, kind: 'tool', status: 'completed', title: 'Tool', output: 'UNSAVED_DURABLE_ACTIVITY' }]
  await expect(host.snapshot()).resolves.toMatchObject({ error: expect.stringContaining('restart Sotto') })
  await expect(host.refreshThread('session-workshop')).resolves.toMatchObject({ error: expect.stringContaining('restart Sotto') })
  expect(sync).not.toHaveBeenCalled()
  const privacy = vi.spyOn(host, 'privacyChanged')
  for (let tick = 1; tick <= 2; tick++) {
    await vi.advanceTimersByTimeAsync(30_000)
    await vi.waitFor(() => expect(privacy).toHaveBeenCalledTimes(tick))
    expect(control.get().error).toContain('Could not finish applying history privacy')
    expect((await host.snapshot()).error).toContain('restart Sotto')
    expect(sync).not.toHaveBeenCalled()
  }
})

it('does not retry into the durable connection if another privacy store fails before it switches', async () => {
  let history = true
  const { directory, adapter, host } = await fixture(() => history)
  vi.useFakeTimers()
  const append = failWrites()
  adapter.publish(added('reply', 'PRIVATE BLOCKED SWITCH'))
  expect(host.workspaceSnapshot().error).toContain('Thread messages could not be saved')
  append.mockRestore()
  const privacy = vi.spyOn(SubagentStore.prototype, 'privacyChanged').mockImplementation(() => { throw new Error('Synthetic failed redaction') })
  history = false
  await expect(host.privacyChanged()).rejects.toThrow('Saved agent history could not be removed')
  await vi.advanceTimersByTimeAsync(1_000)
  const disk = new ThreadStore(join(directory, 'threads.sqlite'))
  disk.open()
  try { expect(disk.readMessages('session-workshop').messages).toEqual([]) }
  finally { disk.close() }
  privacy.mockRestore()
  await host.privacyChanged()
  expect(host.threadMessages('session-workshop')).toMatchObject([{ text: 'PRIVATE BLOCKED SWITCH' }])
  await host.close()
})

it('discards private pending events if retention resumes after an interrupted privacy switch', async () => {
  let history = true
  const { directory, adapter, host } = await fixture(() => history)
  const append = failWrites()
  adapter.publish(added('reply', 'PRIVATE BEFORE SWITCH'))
  host.workspaceSnapshot()
  const privacy = vi.spyOn(SubagentStore.prototype, 'privacyChanged').mockImplementation(() => { throw new Error('Synthetic failed redaction') })
  history = false
  await expect(host.privacyChanged()).rejects.toThrow('Saved agent history could not be removed')
  adapter.publish(added('off', 'PRIVATE DURING SWITCH'))
  append.mockRestore()
  privacy.mockRestore()
  history = true
  await host.privacyChanged()
  adapter.publish(added('new', 'New retained reply'))
  await host.close()
  const disk = new ThreadStore(join(directory, 'threads.sqlite'))
  disk.open()
  try { expect(disk.readMessages('session-workshop').messages).toMatchObject([{ id: 'new', text: 'New retained reply' }]) }
  finally { disk.close() }
})

it('saves oversized additions, appends and replacements in full across replay', async () => {
  const { directory, adapter, host } = await fixture()
  const bridge = createSottoBridge({ invoke: vi.fn(async () => ({ threadId: 'session-workshop', revision: 1, messages: host.threadMessages('session-workshop') })), on: vi.fn(), removeListener: vi.fn() }, 'win32')
  const first = 'a'.repeat(99_999) + '🙂' + 'a'.repeat(100_001)
  expect(threadEventSchema.safeParse(added('reply', first)).success).toBe(false)
  adapter.publish(added('reply', first))
  expect(host.threadMessages('session-workshop')[0]?.text).toBe(first)
  expect((await bridge.agents!.threadDetail!('session-workshop'))?.messages[0]?.text).toBe(first)
  const suffix = 'b'.repeat(100_001)
  adapter.publish(appended(suffix))
  expect(host.threadMessages('session-workshop')[0]?.text).toBe(first + suffix)
  const replacement = 'c'.repeat(300_001)
  adapter.publish({ kind: 'message-replaced', at, message: { id: 'reply', role: 'assistant', text: replacement, createdAt: at } })
  expect(host.threadMessages('session-workshop')[0]?.text).toBe(replacement)
  expect((await bridge.agents!.threadDetail!('session-workshop'))?.messages[0]?.text).toBe(replacement)
  const events = host.eventsAfter(0)
  expect(events.every(({ event }) => event.kind !== 'message-text-appended' || event.appendText.length <= 100_000)).toBe(true)
  await host.close()
  const reopened = new WorkspaceHost(new EventProvider(), directory)
  cleanup.push(() => reopened.close())
  await reopened.initialize()
  reopened.observeThreads(['session-workshop'])
  const replay = new ThreadStore(join(directory, 'threads.sqlite'))
  replay.open()
  replay.rebuild()
  expect(replay.readMessages('session-workshop').messages[0]?.text).toBe(replacement)
  replay.close()
  expect(reopened.threadMessages('session-workshop')[0]?.text).toBe(replacement)
  expect(reopened.eventsAfter(0)).toEqual(events)
})

it('sets aside an invalid event while saving the rest of its batch in order', async () => {
  const { adapter, host } = await fixture()
  const log = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  adapter.publish(added())
  adapter.publish({ kind: 'message-text-appended', at: '', messageId: 'reply', appendText: 'invalid private words' })
  adapter.publish(appended())
  expect(host.threadMessages('session-workshop')[0]?.text).toBe('First chunk continued')
  expect(host.eventsAfter(0).map(row => row.event.kind)).toEqual(['message-added', 'message-text-appended'])
  expect(host.workspaceSnapshot().threads.find(thread => thread.id === 'session-workshop')?.historySaveNotice).toContain('Part of this thread’s history could not be saved')
  expect(host.workspaceSnapshot().error).toBeUndefined()
  expect(log).toHaveBeenCalledExactlyOnceWith('thread-history-event-invalid')
  await expect(host.close()).resolves.toBeUndefined()
})
