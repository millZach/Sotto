/**
 * The workspace over a thread-store writer that confirms later, and the seeded run that compares it with the writer on
 * main (#1457). `tests/unit/main/workspaceStoreWriter.test.ts` runs it over a writer the test releases by hand, and
 * `tests/integration/workspaceStoreWorker.test.ts` over the store worker as the build compiles it.
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, vi } from 'vitest'
import type { ThreadHostEvent } from '../../src/main/agents/host'
import { ThreadStore } from '../../src/main/agents/threadStore'
import type { ThreadStoreWriter } from '../../src/main/agents/threadStoreWriter'
import { WorkspaceHost } from '../../src/main/agents/workspace'
import type { AgentActivity } from '../../src/shared/agentActivity'
import type { AgentMessage, AgentThreadSummary } from '../../src/shared/agents'
import type { AnswerGivenEvent, ThreadEvent } from '../../src/shared/threadEvents'
import type { VisualInput } from '../../src/shared/visuals'
import { DeferredStoreWriter } from './deferredStoreWriter'
import { FakeProviderHost } from './fakeProviderHost'

/** A provider that says what changed, event by event, as the native adapters do. */
export class EventProvider extends FakeProviderHost {
  private readonly events = new Set<(event: ThreadHostEvent) => void>()
  subscribeEvents(listener: (event: ThreadHostEvent) => void): () => void {
    this.events.add(listener)
    return () => this.events.delete(listener)
  }
  publish(event: ThreadEvent, threadId = WORKSHOP): void {
    for (const listener of this.events) listener({ threadId, event })
  }
}

export const WORKSHOP = 'session-workshop'
export const DOCS = 'session-docs'
export const at = '2026-10-26T00:00:00.000Z'
export const message = (id: string, role: AgentMessage['role'], text: string): AgentMessage => ({ id, role, text, createdAt: at })
export const added = (id: string, text: string, role: AgentMessage['role'] = 'assistant'): ThreadEvent => ({ kind: 'message-added', at, message: message(id, role, text) })
export const appended = (messageId: string, appendText: string): ThreadEvent => ({ kind: 'message-text-appended', at, messageId, appendText })
export const replaced = (id: string, text: string, role: AgentMessage['role'] = 'assistant'): ThreadEvent => ({ kind: 'message-replaced', at, message: message(id, role, text) })
export const reset = (): ThreadEvent => ({ kind: 'messages-reset', at })
export const aliased = (messageId: string, canonicalId: string): ThreadEvent => ({ kind: 'message-aliased', at, messageId, canonicalId })
export const answer = (requestId: string): AnswerGivenEvent => ({ kind: 'answer-given', at, requestId, attribution: { clientId: 'test-client', transport: 'ipc' } })
export const visual = (title: string): VisualInput => ({ title, kind: 'diagram', source: 'flowchart LR\n  A[Draft] --> B[Sent]', intro: 'The short way.', steps: [{ text: 'A draft is sent.', highlight: ['A->B'] }] })
export const record = (id: string, sequence: number, status: AgentActivity['status'] = 'completed'): AgentActivity =>
  ({ id, turnId: 'turn', sequence, kind: 'tool', status, title: `Tool ${id}`, output: `Output ${id}` })

/** What `cleanUp` runs after each test, newest first. */
export const cleanup: Array<() => Promise<void>> = []
/** Closes every workspace the fixtures made and removes its folder; each test file calls it after each test. */
export async function cleanUp(): Promise<void> {
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const close of cleanup.splice(0).reverse()) await close()
}

export interface Fixture { directory: string; adapter: EventProvider | FakeProviderHost; host: WorkspaceHost; writer: DeferredStoreWriter | undefined }

/**
 * A workspace with one provider. `deferred` runs it over the holding writer, which confirms nothing until released; the
 * start commits at once, as nothing reads the store before it, and the writer holds from then on.
 */
export async function fixture(options: { deferred?: boolean; worker?: string; streamingPublishCost?: boolean; providerId?: 'claude'; watcher?: boolean; wholeHistories?: boolean; history?: () => boolean } = {}): Promise<Fixture & { adapter: EventProvider }> {
  const directory = await mkdtemp(join(tmpdir(), 'sotto-store-writer-'))
  cleanup.push(async () => {
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !directory.includes('sotto-store-writer-')) throw new Error('Unexpected test directory')
    await rm(directory, { recursive: true, force: true })
  })
  // A provider that publishes whole histories is the one whose snapshots the workspace compares (`record`).
  const adapter = (options.wholeHistories ? new FakeProviderHost() : new EventProvider()) as EventProvider
  if (options.providerId) for (const thread of adapter.state.threads) thread.providerId = options.providerId
  // A send looks at its project's folder, so the project is a folder that is there.
  const project = join(directory, 'project')
  await mkdir(project)
  adapter.state.projects[0]!.path = project
  let writer: DeferredStoreWriter | undefined
  const host = options.deferred === false
    ? new WorkspaceHost(adapter, directory, options.history ?? (() => true), undefined, options.watcher ?? false, false, options.streamingPublishCost ?? true, undefined, options.worker ?? null)
    : new WorkspaceHost(adapter, directory, options.history ?? (() => true), undefined, options.watcher ?? false, false, options.streamingPublishCost ?? true,
      store => { writer = new DeferredStoreWriter(store); writer.holding = false; return writer })
  cleanup.push(async () => { host.disconnect(); if (writer) { writer.holding = false; writer.release() } await host.close().catch(() => undefined) })
  await host.initialize()
  await host.connect()
  host.observeThreads([WORKSHOP])
  if (writer) writer.holding = true
  return { directory, adapter, host, writer }
}

/** What the file itself holds, read through a connection of its own: nothing a commit has not reached. */
export function storedMessages(directory: string, threadId = WORKSHOP): AgentMessage[] {
  const disk = new ThreadStore(join(directory, 'threads.sqlite'), undefined, null)
  disk.open()
  try { return disk.readMessages(threadId).messages } finally { disk.close() }
}
export const shown = (host: WorkspaceHost, threadId = WORKSHOP) => host.workspaceSnapshot().threads.find(thread => thread.id === threadId)!

/** Releases every write, and every write a confirmation let go behind it, until nothing is posted. */
export function settle(f: Fixture): void {
  for (;;) {
    f.host.workspaceSnapshot()
    if (!f.writer?.waiting) return
    f.writer.release()
  }
}

/** Whether a promise has settled, read after the tasks queued ahead of this check have run. */
export async function isSettled(promise: Promise<unknown>): Promise<boolean> {
  let settled = false
  void promise.then(() => { settled = true }, () => { settled = true })
  await new Promise(resolve => setImmediate(resolve))
  return settled
}

/** Releases what is posted until a write of this kind has been posted, and leaves that one and what follows it held. */
export async function releaseUntilPosted(writer: DeferredStoreWriter, kind: string): Promise<void> {
  for (let tries = 0; !writer.log.some(write => write.kind === kind); tries++) {
    if (tries > 1_000) throw new Error(`No ${kind} write was posted`)
    writer.release()
    await new Promise(resolve => setImmediate(resolve))
  }
}

/** Runs `work` to the end while releasing what it posts, the way the store worker confirms without being asked. */
export async function pumped<T>(f: Fixture, work: Promise<T>): Promise<T> {
  let done = false
  const result = work.finally(() => { done = true })
  // Handled at once, so a rejection while the writer is pumped reaches the caller rather than reading as unhandled.
  result.catch(() => undefined)
  while (!done) {
    f.writer?.release()
    await new Promise(resolve => setImmediate(resolve))
  }
  return result
}


/** A small seeded generator, so a failing run can be read again exactly (mulberry32). */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6D2B79F5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296
  }
}

/**
 * What the file holds, in a form both writers must agree on. Event boundaries are folded, since the write window may
 * cut a streamed reply's appends differently, and sequences are left out for the same reason; a reset an activity save
 * followed is named by its place among its thread's resets.
 */
function rows(directory: string, unwrittenThreads: ReadonlySet<string> = new Set()) {
  const db = new DatabaseSync(join(directory, 'threads.sqlite'), { readOnly: true })
  try {
    const events: Record<string, unknown[]> = {}
    const resets: Record<string, number[]> = {}
    for (const row of db.prepare('SELECT seq, thread_id, payload FROM events ORDER BY seq').all()) {
      const threadId = String(row.thread_id)
      const { at: _at, ...event } = JSON.parse(String(row.payload)) as ThreadEvent & { appendText?: string; messageId?: string }
      void _at
      // Words that moved to memory when history went off, or were dropped with a thread cleared while they were held,
      // never reached this file, where the reference wrote them and took them out, keeping a record of each event it was
      // given. Those threads' logs are left out; their projection, records, visuals and wake-ups below are not.
      if (unwrittenThreads.has(threadId)) continue
      const list = events[threadId] ??= []
      const last = list.at(-1) as { kind?: string; messageId?: string; appendText?: string } | undefined
      if (event.kind === 'message-text-appended' && last?.kind === 'message-text-appended' && last.messageId === event.messageId) last.appendText += event.appendText!
      else list.push(event)
      if (event.kind === 'messages-reset') (resets[threadId] ??= []).push(Number(row.seq))
    }
    return {
      events,
      messages: db.prepare('SELECT thread_id, position, message_id, role, text, created_at, command_id, attachments, turn_message_id FROM messages ORDER BY thread_id, position').all(),
      activities: db.prepare('SELECT thread_id, activity_id, payload FROM activities ORDER BY thread_id, position').all(),
      epochs: db.prepare('SELECT thread_id, epoch, message_reset_seq FROM activity_epochs ORDER BY thread_id').all()
        .map(row => ({ ...row, message_reset_seq: row.message_reset_seq === null || unwrittenThreads.has(String(row.thread_id)) ? null : (resets[String(row.thread_id)] ?? []).filter(seq => seq <= Number(row.message_reset_seq)).length })),
      visuals: db.prepare('SELECT thread_id, anchor_message_id, anchor_user_message_id, json_extract(payload, \'$.title\') AS title FROM visuals ORDER BY seq').all(),
      wakeUps: db.prepare('SELECT thread_id, message_id FROM wake_ups ORDER BY thread_id, message_id').all(),
    }
  } finally { db.close() }
}

/** A visual's identity is drawn at random; each is named by its title instead, so two runs compare. */
function namedVisuals(messages: readonly AgentMessage[]): AgentMessage[] {
  return messages.map(item => item.visual ? { ...item, id: `visual:${item.visual.title}`, visual: { ...item.visual, id: item.visual.title } } : item)
}

/** The events a workspace lays over the store for a thread, read for the comparison below and nowhere else. */
function heldEvents(host: WorkspaceHost, threadId: string): readonly ThreadEvent[] {
  return (host as unknown as { heldEvents(threadId: string, withWaitingAppends: boolean): readonly ThreadEvent[] }).heldEvents(threadId, true)
}

/** Whether a workspace still holds events for a thread that it has not posted, read for the comparison below alone. */
function waitingIn(host: WorkspaceHost, threadId: string): boolean {
  return (host as unknown as { pendingEvents: ReadonlyMap<string, unknown> }).pendingEvents.has(threadId)
}

/**
 * What each thread shows, as the publish gives it: its window, its summary and its activity records. Left out, each for
 * a reason the plan names (docs/plans/store-worker.md, step 1):
 * - the summary's record count and running turn, which are taken from the records when the summary is read again, and
 *   a confirmation that comes later reads it again sooner; the records themselves are compared;
 * - while an alias is held for a thread, its summary's count and excerpts, which show the alias once it is confirmed;
 * - while writes are held, the window's messages before the reference's first: a window asked for in turns keeps every
 *   message the events add until it is read again, and then the reference must have earlier messages too;
 * - a thread in `switched`: Keep local history changed the store it is read from, and the screen keeps what it showed
 *   until the thread is read again (ADR-0016). When that is depends on when its commits were confirmed, so it is
 *   compared again once it has had an event since the switch, which reads it again on both.
 * The driver also leaves out, while history stays off, a thread with a write in flight or words held when it went off: turning it off
 * moves what still waits to this run's memory store (ADR-0016, September 27), and words waiting behind a batch in flight
 * wait longer than the writer on main holds them, so they move to memory where the reference committed them to the file
 * and took them out. Turning history back on drops the memory store on both, and the file is compared at the end.
 */
function compareShown(reference: WorkspaceHost, later: WorkspaceHost, switched: ReadonlySet<string>): void {
  const shownBy = (host: WorkspaceHost) => new Map(host.workspaceSnapshot().threads.map(thread => [thread.id, thread]))
  const expected = shownBy(reference), received = shownBy(later)
  expect([...received.keys()]).toEqual([...expected.keys()])
  for (const [id, mine] of received) {
    if (switched.has(id)) continue
    const theirs = expected.get(id)!
    const strip = (summary: AgentThreadSummary | undefined, aliasHeld: boolean) => {
      const { activityCount: _count, runningTurnStartedAt: _running, ...rest } = summary ?? ({} as AgentThreadSummary)
      void _count; void _running
      if (!aliasHeld) return rest
      const { messageCount: _messages, lastUser: _user, lastAssistant: _assistant, lastMessageAt: _at, ...left } = rest
      void _messages; void _user; void _assistant; void _at
      return left
    }
    const aliasHeld = heldEvents(later, id).some(event => event.kind === 'message-aliased')
    expect(strip(mine.summary, aliasHeld), id).toEqual(strip(theirs.summary, aliasHeld))
    expect(mine.activities?.map(activity => activity.id), id).toEqual(theirs.activities?.map(activity => activity.id))
    const shown = namedVisuals(mine.messages), reference = namedVisuals(theirs.messages)
    const first = reference[0] ? shown.findIndex(message => message.id === reference[0]!.id) : shown.length
    if (first > 0) {
      expect(theirs.earlierAvailable, id).toBe(true)
      expect(shown.slice(first), id).toEqual(reference)
    } else {
      expect(shown, id).toEqual(reference)
      expect(mine.earlierAvailable === true, id).toBe(theirs.earlierAvailable === true)
    }
  }
}

/** What the seeded run needs of the later writer: the holding one the test releases, or the store worker. */
interface LaterControl {
  waiting(): boolean
  unconfirmed(threadId?: string): boolean
  settle(): Promise<void>
  pumped<T>(work: Promise<T>): Promise<T>
  release(count: number): Promise<void>
}

function controlOf(later: Fixture): LaterControl {
  if (later.writer) {
    const writer = later.writer
    return { waiting: () => writer.waiting > 0, unconfirmed: threadId => writer.unconfirmed(threadId), settle: async () => { settle(later) },
      pumped: work => pumped(later, work), release: async count => { writer.release(count) } }
  }
  // The store worker confirms on its own; waiting for it is letting the tasks its answers queue run.
  const writes = (later.host as unknown as { writes: ThreadStoreWriter }).writes
  return {
    waiting: () => writes.unconfirmed(),
    unconfirmed: threadId => writes.unconfirmed(threadId),
    settle: async () => { for (;;) { later.host.workspaceSnapshot(); if (!writes.unconfirmed()) return; await writes.confirmed() } },
    pumped: work => work,
    release: async count => { for (let turn = 0; turn < count; turn++) await new Promise(resolve => setImmediate(resolve)) },
  }
}

/**
 * Runs the same seeded operations through a workspace over the writer on main and one over the later writer, comparing
 * what each thread shows while writes are held and the store's rows at the end. `mode.worker` names the built store worker.
 */
export async function runEquivalence(seed: number, mode: { readonly worker?: string } = {}): Promise<void> {
    const families = ['add-user', 'add-assistant', 'append', 'replace', 'reset', 'alias', 'answer', 'visual', 'activities', 'observe',
      'wake-up', 'clear', 'privacy', 'read-now', 'read-waiting', 'publish', 'flush', 'release', 'checkpoint'] as const
    type Family = typeof families[number]
    const random = mulberry32(seed)
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!
    let history = true
    const onMain = await fixture({ deferred: false, history: () => history })
    const later = await fixture({ deferred: mode.worker === undefined, ...(mode.worker === undefined ? {} : { worker: mode.worker }), history: () => history })
    const control = controlOf(later)
    // Timers wait for the test, so neither workspace's windows fire on their own, and both stamp the same instant.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    const both = [onMain, later]
    const ran = new Map<Family, number>(families.map(family => [family, 0]))
    /** Comparisons and reads made while the later writer held writes: the case the overlay and the wait exist for. */
    let held = 0, compared = 0
    /** The driver's own picture of each live thread, so every event it makes is one a provider could send. */
    const model = new Map<string, AgentMessage[]>([[WORKSHOP, []], [DOCS, []]])
    let serial = 0
    /** Threads not read again since Keep local history last switched, and threads whose held words moved to memory. */
    const switched = new Set<string>(), moved = new Set<string>(), unwritten = new Set<string>()
    const unlike = (): ReadonlySet<string> => moved.size ? new Set([...switched, ...moved]) : switched
    const publish = (threadId: string, event: ThreadEvent): void => {
      switched.delete(threadId)
      for (const f of both) f.adapter.publish(structuredClone(event), threadId)
    }
    const compare = async (settled: boolean): Promise<void> => {
      if (settled) await control.settle()
      compared++
      compareShown(onMain.host, later.host, unlike())
      // The publish posts what waited, then lays it over the store: held, if the writer still holds anything now.
      if (!settled && control.waiting()) held++
    }

    // The publish and the reads that cannot wait are drawn more often: they are what the overlay is for.
    const drawn: readonly Family[] = [...families, 'publish', 'publish', 'publish', 'read-now', 'read-now']
    for (let step = 0; step < 500; step++) {
      const family = pick(drawn)
      const threadId = pick([...model.keys()])
      const messages = model.get(threadId)!
      switch (family) {
        case 'add-user':
        case 'add-assistant': {
          const id = `m${++serial}`
          const role = family === 'add-user' ? 'user' : 'assistant'
          messages.push(message(id, role, `Words ${serial}`))
          publish(threadId, added(id, `Words ${serial}`, role))
          break
        }
        case 'append': {
          const last = messages.at(-1)
          if (!last) continue
          last.text += ` more ${++serial}`
          publish(threadId, appended(last.id, ` more ${serial}`))
          break
        }
        case 'replace': {
          if (!messages.length) continue
          const target = pick(messages)
          target.text = `Replaced ${++serial}`
          publish(threadId, replaced(target.id, target.text, target.role))
          break
        }
        case 'reset': {
          messages.length = 0
          publish(threadId, reset())
          const id = `m${++serial}`
          messages.push(message(id, 'user', `After reset ${serial}`))
          publish(threadId, added(id, `After reset ${serial}`, 'user'))
          break
        }
        case 'alias': {
          if (!messages.length) continue
          const canonical = pick(messages)
          const id = `copy${++serial}`
          publish(threadId, added(id, canonical.text, canonical.role))
          publish(threadId, aliased(id, canonical.id))
          break
        }
        case 'answer': {
          const event = answer(`request-${++serial}`)
          for (const f of both) f.host.recordAnswer(threadId, structuredClone(event))
          break
        }
        case 'visual': {
          if (!messages.length) continue
          const title = `Visual ${++serial}`
          const results = [await onMain.host.addVisual(threadId, visual(title)), await control.pumped(later.host.addVisual(threadId, visual(title)))]
          if (!moved.has(threadId)) expect(results[1]).toMatchObject({ added: results[0]!.added, ...(results[0]!.added ? { anchor: (results[0] as { anchor: string }).anchor } : {}) })
          break
        }
        case 'activities': {
          const records = Array.from({ length: 1 + Math.floor(random() * 4) }, (_, index) => record(`a${threadId}-${serial}-${index}`, index, random() < 0.2 ? 'running' : 'completed'))
          serial++
          for (const f of both) {
            const thread = f.adapter.state.threads.find(item => item.id === threadId)!
            thread.activities = structuredClone([...(thread.activities ?? []).slice(-6), ...records])
            f.adapter.emit()
          }
          break
        }
        case 'observe': {
          const live = [...model.keys()]
          const watched = live.filter(() => random() < 0.5)
          for (const f of both) f.host.observeThreads(watched)
          break
        }
        case 'wake-up': {
          const id = `wake${++serial}`
          // Babysitting's send: the wake-up is marked before the provider hears it, then the provider echoes the prompt.
          await onMain.host.execute({ type: 'send', commandId: `send-${serial}`, threadId, messageId: id, text: `Wake-up ${serial}`, wakeUp: true })
          await control.pumped(later.host.execute({ type: 'send', commandId: `send-${serial}`, threadId, messageId: id, text: `Wake-up ${serial}`, wakeUp: true }))
          for (const f of both) {
            const thread = f.adapter.state.threads.find(item => item.id === threadId)!
            thread.status = 'idle'
            f.adapter.emit()
          }
          messages.push(message(id, 'user', `Wake-up ${serial}`))
          publish(threadId, added(id, `Wake-up ${serial}`, 'user'))
          break
        }
        case 'clear': {
          // Words still held when the forget is posted go with the thread, never written; the reference wrote them first.
          if (control.unconfirmed(threadId) || waitingIn(later.host, threadId)) unwritten.add(threadId)
          const options = { automatic: false, hold: () => null }
          const results = [await onMain.host.deleteThreads([threadId], options), await control.pumped(later.host.deleteThreads([threadId], options))]
          expect(results[1]).toEqual(results[0])
          if (!results[0]!.deleted.length) break
          model.delete(threadId)
          // A thread the provider starts next takes its place, so the run keeps two threads to write to.
          const id = `session-t${++serial}`
          for (const f of both) {
            f.adapter.state.threads.push({ id, projectId: 'project', title: `Thread ${serial}`, modelId: 'fake:model', status: 'idle', messages: [], requests: [] })
            f.adapter.emit()
          }
          model.set(id, [])
          break
        }
        case 'privacy': {
          history = !history
          if (history) moved.clear()
          else for (const id of model.keys()) if (control.unconfirmed(id) || waitingIn(later.host, id)) { moved.add(id); unwritten.add(id) }
          await onMain.host.privacyChanged()
          await control.pumped(later.host.privacyChanged())
          for (const id of model.keys()) switched.add(id)
          break
        }
        case 'read-now': {
          if (moved.has(threadId)) continue
          if (control.unconfirmed(threadId)) held++
          expect(later.host.messageIdentities(threadId)).toEqual(onMain.host.messageIdentities(threadId))
          // A pane's loaded window answers both of these for a watched thread, and the screen keeps it across a switch
          // until the thread is read again (`compareShown`).
          if (switched.has(threadId)) break
          expect(namedVisuals(later.host.threadMessages(threadId))).toEqual(namedVisuals(onMain.host.threadMessages(threadId)))
          const user = messages.findLast(item => item.role === 'user')
          if (user) expect(later.host.hasRecordedUserMessage(threadId, user.id)).toBe(onMain.host.hasRecordedUserMessage(threadId, user.id))
          break
        }
        case 'read-waiting': {
          if (moved.has(threadId)) continue
          const user = messages.findLast(item => item.role === 'user')
          if (!user) continue
          expect(await control.pumped(later.host.threadPrompts(threadId, user.id))).toEqual(await onMain.host.threadPrompts(threadId, user.id))
          break
        }
        case 'publish':
          // The publish reads the store and lays what is held over it: compared as it is, with writes held.
          await compare(false)
          break
        case 'flush':
          await onMain.host.flush()
          await control.pumped(later.host.flush())
          break
        case 'release':
          await control.release(Math.floor(random() * 3))
          break
        case 'checkpoint':
          await compare(true)
          break
      }
      ran.set(family, ran.get(family)! + 1)
    }

    for (const family of families) expect(ran.get(family), family).toBeGreaterThan(0)
    // A good share of what was compared or read was compared or read with writes held.
    expect(held).toBeGreaterThanOrEqual(20)
    // The worker commits at its own pace, so fewer reads find it holding writes than a writer the test holds.
    expect(held / (compared + ran.get('read-now')!)).toBeGreaterThan(mode.worker === undefined ? 0.2 : 0.1)
    if (!history) {
      history = true
      moved.clear()
      await onMain.host.privacyChanged()
      await control.pumped(later.host.privacyChanged())
      for (const id of model.keys()) switched.add(id)
    }
    await compare(true)
    await onMain.host.flush()
    await control.pumped(later.host.flush())
    for (const f of both) f.host.disconnect()
    await onMain.host.close()
    await control.pumped(later.host.close())
    expect(control.waiting()).toBe(false)
    const expected = rows(onMain.directory, unwritten)
    // Clearing and history off take words out, so what is left is compared whatever it holds; it holds the log at least.
    expect(Object.keys(expected.events).length).toBeGreaterThan(0)
    expect(rows(later.directory, unwritten)).toEqual(expected)
}
