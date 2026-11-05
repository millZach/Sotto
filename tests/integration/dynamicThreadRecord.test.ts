// @vitest-environment node
// ADR-0191: Dynamic is a mark Sotto keeps on a thread at rest. Setting it asks no provider, and a provider's own updates and
// a restart keep it. With the Owl feature off, nothing sets it and a saved mark stays whole.
import { createHash, randomUUID } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { WorkerRoles } from '../../src/main/agents/subagentRoles'
import { OVERSEER_NOTE_OFF, overseerInstructions, overseerNoteChanged, overseerNoteOn } from '../../src/shared/dynamicThreads'
import { workspaceFixture } from '../fixtures/workspaceFixture'
import { agentControlFixture } from '../fixtures/agentControlFixture'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function fixture(enabled = true) {
  const workspace = await workspaceFixture(undefined, { history: true, watcherEnabled: false })
  cleanups.push(workspace.remove)
  // Your note, as Settings would hand it over each time it is read.
  const note: { text?: string } = {}
  if (enabled) workspace.host.allowDynamicThreads(() => note.text)
  const f = await agentControlFixture({ directory: workspace.root, host: workspace.host, credentialOptions: { mode: 'unavailable' },
    control: { historyEnabled: () => true, watcherEnabled: false, dynamicThreadsEnabled: enabled } })
  cleanups.push(async () => { f.control.dispose(); await f.control.closed(); await workspace.stop() })
  await f.control.start()
  for (const provider of ['claude', 'codex', 'grok'] as const) await f.control.commandShell({ type: 'connect', provider })
  const thread = async (provider: 'claude' | 'codex' | 'grok') => {
    const shell = f.control.shell().host, threadId = randomUUID()
    const project = shell.projects.find(item => item.providerId === provider)!, model = shell.models.find(item => item.providerId === provider)!
    expect((await f.control.commandShell({ type: 'create-thread', threadId, projectId: project.id, title: 'Synthetic thread', modelId: model.id })).error).toBeNull()
    return threadId
  }
  const set = (threadId: string, dynamic: boolean) => f.control.commandShell({ type: 'set-thread-dynamic', threadId, dynamic })
  const mark = (threadId: string) => f.control.shell().host.threads.find(item => item.id === threadId)?.dynamic
  return { ...f, workspace, thread, set, mark, note }
}
const digest = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16)

it('sets and clears the mark on a thread at rest, asking the provider nothing', async () => {
  const f = await fixture(), id = await f.thread('claude')
  const before = f.workspace.adapters.claude.commands.length
  expect((await f.set(id, true)).error).toBeNull()
  expect(f.mark(id)).toBe(true)
  expect(f.workspace.adapters.claude.commands).toHaveLength(before)
  // A provider's own update keeps Sotto's record.
  f.workspace.adapters.claude.emit()
  await f.control.commandShell({ type: 'refresh', provider: 'claude' })
  expect(f.mark(id)).toBe(true)
  expect((await f.set(id, false)).error).toBeNull()
  expect(f.mark(id)).toBeUndefined()
})

it('sends no note with a first message, since the session starts on the overseer\'s instructions, and one note after a change', async () => {
  const f = await fixture(), id = await f.thread('claude')
  const sends = () => f.workspace.adapters.claude.commands.filter(command => command.type === 'send').map(command => (command as { overseerNote?: string }).overseerNote)
  const send = async () => {
    expect((await f.control.commandShell({ type: 'manual-send', threadId: id, draftId: randomUUID(), text: 'Synthetic request' })).error).toBeNull()
    const binding = f.workspace.registry.byThread(id)!
    const held = f.workspace.adapters.claude.state.threads.find(thread => thread.id === binding.sessionId)!
    held.status = 'idle'; f.workspace.adapters.claude.emit()
    await f.control.commandShell({ type: 'refresh', provider: 'claude' })
  }
  expect((await f.set(id, true)).error).toBeNull()
  await send()
  expect(sends()).toEqual([undefined])
  expect(f.control.shell().host.threads.find(item => item.id === id)?.dynamicSession).toEqual({ created: true, told: true })
  await send()
  expect(sends()).toEqual([undefined, undefined])
  // Turned off: the next message says so, once.
  expect((await f.set(id, false)).error).toBeNull()
  await send()
  expect(sends().at(-1)).toBe(OVERSEER_NOTE_OFF)
  expect(f.control.shell().host.threads.find(item => item.id === id)?.dynamicSession).toEqual({ created: true, told: false })
  await send()
  expect(sends().at(-1)).toBeUndefined()
  // On and off again before a message goes: it knows where it stands, so nothing is owed.
  expect((await f.set(id, true)).error).toBeNull()
  expect((await f.set(id, false)).error).toBeNull()
  await send()
  expect(sends().at(-1)).toBeUndefined()
  // On again: the note carries the instructions.
  expect((await f.set(id, true)).error).toBeNull()
  await send()
  expect(sends().at(-1)).toBe(overseerNoteOn())
})

it('tells an overseer your note as it starts, once more after it changes or is cleared, and again after a compaction', async () => {
  const f = await fixture(), id = await f.thread('claude')
  f.note.text = '  Sol for reviews.  '
  const sends = () => f.workspace.adapters.claude.commands.filter(command => command.type === 'send').map(command => (command as { overseerNote?: string }).overseerNote)
  const session = () => f.control.shell().host.threads.find(item => item.id === id)?.dynamicSession
  const held = () => f.workspace.adapters.claude.state.threads.find(thread => thread.id === f.workspace.registry.byThread(id)!.sessionId)!
  const settle = async () => { held().status = 'idle'; f.workspace.adapters.claude.emit(); await f.control.commandShell({ type: 'refresh', provider: 'claude' }) }
  const compact = async (commandId: string) => {
    held().compaction = { commandId, status: 'running' }; f.workspace.adapters.claude.emit()
    await f.control.commandShell({ type: 'refresh', provider: 'claude' })
    held().compaction = { commandId, status: 'completed' }; f.workspace.adapters.claude.emit()
    await f.control.commandShell({ type: 'refresh', provider: 'claude' })
  }
  const send = async () => {
    expect((await f.control.commandShell({ type: 'manual-send', threadId: id, draftId: randomUUID(), text: 'Synthetic request' })).error).toBeNull()
    await settle()
  }
  expect((await f.set(id, true)).error).toBeNull()
  await send()
  // The first message starts the session on instructions that carry the note, so no note goes with it.
  expect(sends()).toEqual([undefined])
  expect(session()).toEqual({ created: true, told: true, createdNote: digest('Sol for reviews.'), toldNote: digest('Sol for reviews.') })
  await send()
  expect(sends().at(-1)).toBeUndefined()
  // Changed: the next message carries it, once. The record keeps a digest, never the words.
  f.note.text = 'Opus for debugging.'
  await send()
  expect(sends().at(-1)).toBe(overseerNoteChanged('Opus for debugging.'))
  expect(session()).toEqual({ created: true, told: true, createdNote: digest('Sol for reviews.'), toldNote: digest('Opus for debugging.'), noteHeard: true })
  expect(JSON.stringify(f.control.shell().host.threads)).not.toContain('Opus for debugging.')
  await send()
  expect(sends().at(-1)).toBeUndefined()
  // A compaction can lose a note, so the session goes back to what it was created with and hears the change again.
  await compact('compact')
  expect(session()).toEqual({ created: true, told: true, createdNote: digest('Sol for reviews.'), toldNote: digest('Sol for reviews.'), noteHeard: true, noteOwed: true })
  await send()
  expect(sends().at(-1)).toBe(overseerNoteChanged('Opus for debugging.'))
  // Cleared: the overseer is told to set it aside, once.
  f.note.text = ' '
  await send()
  expect(sends().at(-1)).toBe(overseerNoteChanged(undefined))
  expect(session()).toEqual({ created: true, told: true, createdNote: digest('Sol for reviews.'), noteHeard: true })
  await send()
  expect(sends().at(-1)).toBeUndefined()
  // A compaction can lose the clearing too, so it goes again.
  await compact('compact-again')
  await send()
  expect(sends().at(-1)).toBe(overseerNoteChanged(undefined))
  await send()
  expect(sends().at(-1)).toBeUndefined()
  // Turned off, then on: the note that turns it on carries the note in its instructions, and sets aside the ones heard before.
  f.note.text = 'Sol for reviews.'
  expect((await f.set(id, false)).error).toBeNull()
  await send()
  expect(sends().at(-1)).toBe(OVERSEER_NOTE_OFF)
  expect((await f.set(id, true)).error).toBeNull()
  await send()
  expect(sends().at(-1)).toBe(overseerNoteOn('Sol for reviews.', true))
  expect(session()?.toldNote).toBe(digest('Sol for reviews.'))
})

it('tells a thread that began ordinary by a note when it turns Dynamic later', async () => {
  const f = await fixture(), id = await f.thread('codex')
  const sends = () => f.workspace.adapters.codex.commands.filter(command => command.type === 'send').map(command => (command as { overseerNote?: string }).overseerNote)
  expect((await f.control.commandShell({ type: 'manual-send', threadId: id, draftId: randomUUID(), text: 'Synthetic request' })).error).toBeNull()
  expect(sends()).toEqual([undefined])
  expect(f.control.shell().host.threads.find(item => item.id === id)?.dynamicSession).toBeUndefined()
  const binding = f.workspace.registry.byThread(id)!
  f.workspace.adapters.codex.state.threads.find(thread => thread.id === binding.sessionId)!.status = 'idle'; f.workspace.adapters.codex.emit()
  await f.control.commandShell({ type: 'refresh', provider: 'codex' })
  expect((await f.set(id, true)).error).toBeNull()
  expect((await f.control.commandShell({ type: 'manual-send', threadId: id, draftId: randomUUID(), text: 'Synthetic request' })).error).toBeNull()
  expect(sends().at(-1)).toBe(overseerNoteOn())
  expect(f.control.shell().host.threads.find(item => item.id === id)?.dynamicSession).toEqual({ created: false, told: true })
})

it('reaches the adapter by its session, whichever ID each side keeps, for its instructions, its note and letting go of its process', async () => {
  const workspace = await workspaceFixture(undefined, { history: true, watcherEnabled: false })
  cleanups.push(workspace.remove)
  workspace.host.allowDynamicThreads(() => 'Sol for reviews.')
  let source: { overseer?(id: string): string | undefined; overseerNote?(id: string): string | undefined } | undefined
  ;(workspace.adapters.claude as unknown as { useWorkerRoles(roles: typeof source): void }).useWorkerRoles = roles => { source = roles }
  const released: string[] = []
  ;(workspace.adapters.claude as unknown as { threadInstructionsChanged(id: string): Promise<void> }).threadInstructionsChanged = async id => { released.push(id) }
  workspace.host.useWorkerRoles(new WorkerRoles(() => []))
  const f = await agentControlFixture({ directory: workspace.root, host: workspace.host, credentialOptions: { mode: 'unavailable' },
    control: { historyEnabled: () => true, watcherEnabled: false, dynamicThreadsEnabled: true } })
  cleanups.push(async () => { f.control.dispose(); await f.control.closed(); await workspace.stop() })
  await f.control.start()
  await f.control.commandShell({ type: 'connect', provider: 'claude' })
  const shell = f.control.shell().host, id = randomUUID()
  const project = shell.projects.find(item => item.providerId === 'claude')!, model = shell.models.find(item => item.providerId === 'claude')!
  expect((await f.control.commandShell({ type: 'create-thread', threadId: id, projectId: project.id, title: 'Synthetic thread', modelId: model.id })).error).toBeNull()
  expect((await f.control.commandShell({ type: 'manual-send', threadId: id, draftId: randomUUID(), text: 'Synthetic request' })).error).toBeNull()
  const sessionId = workspace.registry.byThread(id)!.sessionId
  expect(sessionId).not.toBe(id)
  const held = workspace.adapters.claude.state.threads.find(thread => thread.id === sessionId)!
  held.status = 'idle'; workspace.adapters.claude.emit()
  await f.control.commandShell({ type: 'refresh', provider: 'claude' })
  expect(source!.overseer!(sessionId)).toBeUndefined()
  expect((await f.control.commandShell({ type: 'set-thread-dynamic', threadId: id, dynamic: true })).error).toBeNull()
  expect(source!.overseer!(sessionId)).toBe(overseerInstructions('Sol for reviews.'))
  expect(source!.overseerNote!(sessionId)).toBe(overseerNoteOn('Sol for reviews.'))
  expect(released).toEqual([sessionId])
})

it('refuses a provider that cannot oversee yet, in plain words, and sets nothing', async () => {
  const f = await fixture(), id = await f.thread('grok')
  const answer = await f.set(id, true)
  expect(answer.error).toContain('Only a Claude Code or Codex thread can be Dynamic for now.')
  expect(f.mark(id)).toBeUndefined()
})

it('refuses a change while a turn runs', async () => {
  const f = await fixture(), id = await f.thread('codex')
  expect((await f.control.commandShell({ type: 'manual-send', threadId: id, draftId: randomUUID(), text: 'Synthetic request' })).error).toBeNull()
  const answer = await f.set(id, true)
  expect(answer.error).toContain('Wait for this thread to finish')
  expect(f.mark(id)).toBeUndefined()
})

it('sets nothing with the Owl feature off', async () => {
  const f = await fixture(false), id = await f.thread('claude')
  expect((await f.set(id, true)).error).toContain('Dynamic threads are available in Sotto Owl.')
  expect(f.mark(id)).toBeUndefined()
})

it('keeps the mark through a restart', async () => {
  const f = await fixture(), id = await f.thread('claude')
  expect((await f.set(id, true)).error).toBeNull()
  f.control.dispose(); await f.control.closed(); await f.workspace.stop()
  const workspace = await workspaceFixture(f.workspace.root, { history: true, watcherEnabled: false, adapters: f.workspace.adapters })
  const again = await agentControlFixture({ directory: workspace.root, host: workspace.host, credentialOptions: { mode: 'unavailable' },
    control: { historyEnabled: () => true, watcherEnabled: false, dynamicThreadsEnabled: true } })
  cleanups.push(async () => { again.control.dispose(); await again.control.closed(); await workspace.stop() })
  await again.control.start()
  await again.control.commandShell({ type: 'connect', provider: 'claude' })
  expect(again.control.shell().host.threads.find(item => item.id === id)?.dynamic).toBe(true)
})
