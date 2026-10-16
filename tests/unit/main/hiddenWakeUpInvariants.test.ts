// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { EMPTY_AGENT_HOST, type AgentHostSnapshot, type AgentThread } from '../../../src/shared/agents'
import type { WatcherEvent, WatcherNews } from '../../../src/shared/watcherNews'
import { FollowupStore, type QueuedFollowup, type WordWakeUp } from '../../../src/main/agents/followups'
import { hiddenEvents, hiddenWakeUpStep, type HiddenWakeUpOutcome } from '../../../src/main/agents/hiddenWakeUp'
import { isWatcherOnlyWakeUp, queuedWakeUpText } from '../../../src/main/agents/wakeUp'
import { WatcherWakeUp, WAKE_UP_TRIES } from '../../../src/main/agents/watcherWakeUp'
import { watcherNewsText } from '../../../src/main/agents/watcherNews'
import { centerTarget, centerTime, watcherRecordFixture } from '../../fixtures/watcher'

/**
 * Drives Watcher's news (WatcherWakeUp) and its hidden wake-up in the real queue (FollowupStore) through table-driven and
 * seeded random sequences, with the coordinator's own step for the item (hiddenWakeUpStep): a worker's turns, questions,
 * pull request checks and working copy; sends that land, fail or go unknown, with news arriving mid-send and late echoes;
 * failed saves; withdrawals; Watcher's own turns; restarts mid-dispatch; and queues earlier builds saved. After every step:
 * (a) at most one hidden wake-up; (b) no send without new news that needs Watcher, and automatic tries bounded; (c) a
 * thread's own facts never wake Watcher by themselves; (d) every event told at most once unless forgotten and observed
 * again, and none lost; (e) pumping with nothing new writes nothing.
 */
const directories: string[] = []
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }) })
const word: WordWakeUp = news => queuedWakeUpText(news, { tool: false })
const prUrl = 'https://github.com/synthetic/project/pull/9'
/** How the hidden wake-ups the sequences made ended, so a run that never reached a path cannot pass quietly. */
const outcomes: Record<HiddenWakeUpOutcome, number> = { told: 0, failed: 0, unknown: 0, withdrawn: 0 }
function random(seed: number): () => number {
  let state = seed >>> 0
  return () => { state = (state * 1_664_525 + 1_013_904_223) >>> 0; return state / 2 ** 32 }
}

interface World {
  directory: string; store: FollowupStore; wakes: WatcherWakeUp; clock: number; timers: Set<{ at: number; callback: () => void }>
  record: ReturnType<typeof watcherRecordFixture>; snapshot: AgentHostSnapshot; worker: AgentThread; watcher: AgentThread
  writes: number; failNextWrite: boolean; turn: number; checks: 'failed' | 'passed'
  sends: { events: WatcherEvent[]; warranted: boolean }[]; told: Set<string>; forgotten: Set<string>; uncertain: Map<string, string>; reconciling: Set<string>
  echoes: Set<string>; attentionSince: boolean; automatic: number; tolds: number
  /** Holds the next wake-up's save open until released, so news can come in the middle of it. */
  holdSave?: { entered: () => void; release: Promise<void> } | undefined
}
const watcherId = () => 'center'
const hidden = (w: World): QueuedFollowup[] => w.store.peek().items.filter(item => item.threadId === watcherId() && isWatcherOnlyWakeUp(item))

async function world(): Promise<World> {
  const directory = await mkdtemp(join(tmpdir(), 'sotto-hidden-wake-'))
  if (dirname(resolve(directory)) !== resolve(tmpdir())) throw new Error('Unexpected fixture path')
  directories.push(directory)
  const record = watcherRecordFixture()
  record.operations[0]!.deliveryState = 'accepted'
  const worker: AgentThread = { id: centerTarget.threadId, providerId: 'codex', projectId: 'project', modelId: 'model', title: 'Worker',
    status: 'running', lastTurn: { id: 'turn-0', status: 'running' }, messages: [], requests: [],
    pullRequests: [{ url: prUrl, number: 9, title: 'Synthetic pull request', state: 'open', draft: false, source: 'linked', linkedAt: centerTime }] }
  const watcher: AgentThread = { id: watcherId(), providerId: 'codex', projectId: 'center-project', modelId: 'model', title: 'Watcher', kind: 'watcher',
    status: 'idle', lastTurn: { id: 'w-0', status: 'completed' }, messages: [], requests: [] }
  const snapshot: AgentHostSnapshot = { ...structuredClone(EMPTY_AGENT_HOST), connected: true, hostId: centerTarget.hostId,
    capabilities: { ...EMPTY_AGENT_HOST.capabilities, observe: true }, threads: [worker, watcher], projects: [{ id: 'project', title: 'Project', path: 'synthetic' }] }
  const w = { directory, record, snapshot, worker, watcher, clock: Date.parse('2026-10-11T10:00:00Z'), timers: new Set(), writes: 0, failNextWrite: false,
    turn: 0, checks: 'passed', sends: [], told: new Set(), forgotten: new Set(), uncertain: new Map(), reconciling: new Set(), echoes: new Set(), attentionSince: false,
    automatic: 0, tolds: 0 } as unknown as World
  await load(w)
  return w
}
/** Sotto starting: the queue loads and Watcher's saved news goes from it, untold again, and Watcher's news starts afresh. */
async function load(w: World): Promise<void> {
  w.wakes?.close()
  w.store = new FollowupStore(w.directory); await w.store.load()
  const inner = (w.store as unknown as { store: { write: (value: unknown) => Promise<void> } }).store, write = inner.write.bind(inner)
  inner.write = async value => { if (w.failNextWrite) { w.failNextWrite = false; throw new Error('Synthetic disk failure') } w.writes++; await write(value) }
  const dropped = await w.store.dropWatcherNews(word)
  for (const event of dropped) w.forgotten.add(event.id)
  const ids = new Set(dropped.map(event => event.id))
  w.record.wakeEventIds = (w.record.wakeEventIds ?? []).filter(id => !ids.has(id))
  w.uncertain.clear(); w.reconciling.clear()
  w.wakes = new WatcherWakeUp({ now: () => w.clock, snapshot: () => w.snapshot, record: () => w.record, canDeliver: () => true,
    schedule: (callback, delay) => { const timer = { at: w.clock + delay, callback }; w.timers.add(timer); return () => { w.timers.delete(timer) } },
    restoredEvents: () => [], wakeUpQueued: () => hidden(w).length > 0, prune: async () => undefined,
    remember: async ids => { w.record.wakeEventIds = [...new Set([...w.record.wakeEventIds ?? [], ...ids])].slice(-1_000) },
    deliver: async (news: WatcherNews) => {
      await w.store.queueWakeUp(watcherId(), news, word, w.watcher.lastTurn?.id)
      const hold = w.holdSave; w.holdSave = undefined
      if (hold) { hold.entered(); await hold.release }
    } })
  w.wakes.start()
  w.attentionSince = true // A restart observes afresh.
}
async function advance(w: World, ms: number): Promise<void> {
  const end = w.clock + ms
  for (;;) {
    const timer = [...w.timers].sort((a, b) => a.at - b.at).find(item => item.at <= end)
    if (!timer) break
    w.clock = timer.at; w.timers.delete(timer); timer.callback(); await w.wakes.drained()
  }
  w.clock = end; await w.wakes.drained()
}
const observe = (w: World) => { w.wakes.observe() }

const untell = (w: World, events: readonly WatcherEvent[]) => { const ids = new Set(events.map(event => event.id)); w.record.wakeEventIds = (w.record.wakeEventIds ?? []).filter(id => !ids.has(id)) }
/** Takes the item out whole, as the coordinator does, and tells Watcher's news how it ended. */
async function settleItem(w: World, item: QueuedFollowup, outcome: HiddenWakeUpOutcome): Promise<void> {
  const events = hiddenEvents(item.news)
  // As the coordinator does: news that did not reach Watcher is saved as untold before its wake-up leaves the queue.
  if (outcome !== 'told') untell(w, events)
  await w.store.removeWakeUp(item.id)
  outcomes[outcome]++
  if (outcome === 'told') {
    // (d) Told once, unless forgotten and observed again in between.
    for (const event of events) { expect(w.told.has(event.id) && !w.forgotten.has(event.id), `told twice: ${event.kind}`).toBe(false); w.told.add(event.id); w.forgotten.delete(event.id) }
    w.tolds++
  }
  if (outcome === 'unknown') for (const event of events) w.forgotten.add(event.id)
  w.wakes.settled(events, outcome)
}
/**
 * One pass of the coordinator's pump over the hidden wake-up; `mode` says how a send it makes ends, or `hold` that
 * Watcher cannot take one now. Returns whether it acted.
 */
type Mode = 'ack' | 'fail' | 'unknown' | 'ack-save-fails' | 'hold'
async function pump(w: World, mode: Mode): Promise<boolean> {
  const item = hidden(w)[0], first = w.store.peek().items.find(other => other.threadId === watcherId())
  const ready = mode !== 'hold' && w.watcher.status !== 'running' && w.watcher.lastTurn?.status !== 'running'
  // Anything else at the head of Watcher's queue, a resume note an earlier build saved, goes first, as any follow-up does.
  if (first && first !== item) { if (!ready) return false; await w.store.claim(first.id); await w.store.settle(first.id, 'accepted'); return true }
  if (!item) return false
  const step = hiddenWakeUpStep(item, { echoed: !!item.messageId && w.echoes.has(item.messageId), reconciling: w.reconciling.has(item.id),
    outdated: item.status === 'queued' && ready && hiddenEvents(item.news).some(event => !w.wakes.due(event)) })
  if (step === 'wait' || step === 'send' && !ready) return false
  if (step !== 'send') { await settleItem(w, item, step); return true }
  await w.store.claim(item.id)
  const sent = w.store.peek().items.find(other => other.id === item.id)!, events = hiddenEvents(sent.news)
  // (c) Every send holds news that needs Watcher; a thread's own facts only ride with it.
  expect(w.wakes.needsAttention(events), 'a send of a thread’s own facts alone').toBe(true)
  w.sends.push({ events, warranted: w.attentionSince })
  if (!w.attentionSince) w.automatic++
  w.attentionSince = false
  if (mode === 'fail') await settleItem(w, sent, 'failed')
  else if (mode === 'unknown') { await w.store.settle(sent.id, 'uncertain', 'Synthetic unknown send'); w.uncertain.set(sent.id, sent.messageId!); w.reconciling.add(sent.id) }
  else if (mode === 'ack') await settleItem(w, sent, 'told')
  else {
    // It went, and saving that fails once: nothing is lost, and the coordinator settles it as told on its next try.
    w.failNextWrite = true
    await expect(settleItem(w, sent, 'told')).rejects.toThrow('Synthetic disk failure')
    expect(hidden(w).map(other => other.id)).toEqual([sent.id])
    await settleItem(w, sent, 'told')
  }
  return true
}
/** Pumps and lets time pass until nothing more happens by itself, as the coordinator does. */
async function quiesce(w: World, mode: Mode): Promise<void> {
  for (let pass = 0; pass < 60; pass++) {
    await advance(w, 6_000)
    if (!await pump(w, mode)) { await advance(w, 6_000); if (!await pump(w, mode)) return }
  }
  throw new Error('Watcher’s news kept acting without news (rule b)')
}

type Step = 'finish' | 'start' | 'question' | 'answer' | 'checks' | 'local' | 'pump-ack' | 'pump-fail' | 'pump-unknown' | 'echo' | 'restart'
  | 'watcher-turn' | 'save-fail' | 'legacy' | 'mid-send' | 'lose-echo' | 'crash-between-saves' | 'mid-save'
async function apply(w: World, step: Step): Promise<void> {
  const worker = w.worker
  switch (step) {
    case 'finish': if (worker.status === 'running') { worker.status = 'idle'; worker.lastTurn = { id: `turn-${w.turn}`, status: 'completed' }; w.attentionSince = true; observe(w) } break
    case 'start': if (worker.status !== 'running') { w.turn++; worker.status = 'running'; worker.lastTurn = { id: `turn-${w.turn}`, status: 'running' }; observe(w) } break
    case 'question': worker.requests = [...worker.requests, { id: randomUUID(), kind: 'question', text: 'Synthetic question', options: [] }]; w.attentionSince = true; observe(w); break
    case 'answer': worker.requests = []; observe(w); break
    case 'checks':
      w.checks = w.checks === 'failed' ? 'passed' : 'failed'; w.attentionSince = true
      w.wakes.pullRequest({ url: prUrl, head: 'head', observedAt: new Date(w.clock).toISOString(), availability: 'available', checks: w.checks, checkCount: 1 })
      break
    case 'local': w.wakes.checkpoint({ threadId: worker.id, checkpointId: randomUUID(), observedAt: new Date(w.clock).toISOString(), availability: 'available', changedFiles: w.clock % 7 }); break
    case 'pump-ack': await advance(w, 6_000); await pump(w, 'ack'); break
    case 'pump-fail': await advance(w, 6_000); await pump(w, 'fail'); break
    case 'pump-unknown': await advance(w, 6_000); await pump(w, 'unknown'); break
    // The outbox settles an unknown send: its late echo shows it went, or no echo is ever seen.
    case 'echo': for (const [id, messageId] of w.uncertain) { w.echoes.add(messageId); w.reconciling.delete(id) } break
    case 'lose-echo': w.reconciling.clear(); break
    case 'restart': await load(w); break
    case 'mid-save': {
      // A wake-up is being saved when a question comes: the question is for the next one, and keeps its claim to go.
      if (hidden(w).length) break
      let entered!: () => void, release!: () => void
      const inside = new Promise<void>(resolve => { entered = resolve }), held = new Promise<void>(resolve => { release = resolve })
      w.holdSave = { entered, release: held }
      worker.requests = [...worker.requests, { id: randomUUID(), kind: 'question', text: 'Synthetic question', options: [] }]; w.attentionSince = true; observe(w)
      const passing = advance(w, 6_000)
      await Promise.race([inside, passing])
      worker.requests = [...worker.requests, { id: randomUUID(), kind: 'question', text: 'Synthetic question', options: [] }]; observe(w)
      release(); w.holdSave = undefined; await passing
      break
    }
    case 'crash-between-saves': {
      // Sotto stops after a wake-up's news was saved as untold and before the wake-up left the queue.
      const item = hidden(w)[0]
      if (item) untell(w, hiddenEvents(item.news))
      await load(w)
      break
    }
    case 'watcher-turn':
      w.watcher.status = 'running'; w.watcher.lastTurn = { id: randomUUID(), status: 'running' }; observe(w)
      w.watcher.status = 'idle'; w.watcher.lastTurn = { ...w.watcher.lastTurn, status: 'completed' }; observe(w)
      break
    case 'save-fail': await advance(w, 6_000); await pump(w, 'ack-save-fails'); break
    case 'mid-send': {
      // News arrives while a wake-up is being sent: it waits for the next one and changes nothing in this one.
      const item = hidden(w)[0]
      if (item?.status !== 'queued' || w.store.peek().items.find(other => other.threadId === watcherId()) !== item) break
      await w.store.claim(item.id)
      const before = structuredClone(w.store.peek().items.find(other => other.id === item.id)!)
      worker.requests = [...worker.requests, { id: randomUUID(), kind: 'question', text: 'Synthetic question', options: [] }]; observe(w); await advance(w, 6_000)
      expect(w.store.peek().items.find(other => other.id === item.id)).toEqual(before)
      expect(hidden(w)).toHaveLength(1)
      const events = hiddenEvents(before.news)
      w.sends.push({ events, warranted: true }); w.attentionSince = true
      await settleItem(w, before, 'told')
      break
    }
    case 'legacy': {
      // Earlier builds' queues: main's, with the news in the words; mixed with a resume note; and this branch's earlier
      // rounds, with and without what they kept beside the news, two side by side, one mid-send.
      const at = new Date(w.clock).toISOString()
      const news = (kind: 'turn-finished' | 'needs-user'): WatcherNews => ({ source: 'watcher', watcher: w.record.current!.target, omitted: 0, events: [{ id: randomUUID(),
        requestId: w.record.requests[0]!.id, target: centerTarget, generation: 0, kind, turnId: worker.lastTurn!.id, observedAt: at,
        ...kind === 'needs-user' ? { requestCardId: 'legacy-card', requestCardKind: 'question', revision: 'legacy' } : {} }] })
      const item = (patch: Record<string, unknown>): Record<string, unknown> => ({ id: randomUUID(), threadId: watcherId(), draftId: randomUUID(), attachments: [], status: 'queued',
        wakeUp: true, createdAt: at, updatedAt: at, text: 'Synthetic earlier words', ...patch })
      const main = news('turn-finished'), mixed = news('needs-user')
      const items = [item({ news: [main], text: watcherNewsText(main) }), item({ news: [{ source: 'restart', since: at, resumes: 1 }, mixed] }),
        item({ news: [news('turn-finished')], attention: [], status: 'dispatching', commandId: randomUUID(), messageId: randomUUID() }),
        item({ news: [news('needs-user')], attention: ['x'], carried: ['x'], attempts: 3, status: 'paused' })]
      for (const entry of items) for (const event of hiddenEvents(entry.news as WatcherNews[])) w.record.wakeEventIds = [...w.record.wakeEventIds ?? [], event.id]
      await writeFile(join(w.directory, 'followups.json'), JSON.stringify({ items, receipts: [] }))
      await load(w)
      expect(hidden(w)).toEqual([])
      for (const entry of items) for (const event of hiddenEvents(entry.news as WatcherNews[])) expect(w.record.wakeEventIds).not.toContain(event.id)
      break
    }
  }
}

async function check(w: World): Promise<void> {
  // (a) One hidden wake-up at most, in memory and saved.
  expect(hidden(w).length).toBeLessThanOrEqual(1)
  // (b) Automatic tries are bounded: at most WAKE_UP_TRIES - 1 after each send that reached Watcher, and after the start.
  expect(w.automatic).toBeLessThanOrEqual((WAKE_UP_TRIES - 1) * (w.tolds + 1) + w.forgotten.size)
  // (e) With nothing new, pumping again changes nothing and writes nothing.
  await quiesce(w, 'hold')
  const writes = w.writes, sends = w.sends.length
  await quiesce(w, 'hold')
  expect(w.writes - writes).toBe(0)
  expect(w.sends.length - sends).toBe(0)
}

/** (d) None lost: with Watcher answering, every news that needs it and is still true reaches it. */
async function noneLost(w: World): Promise<void> {
  w.attentionSince = true
  // The outbox settles every unknown send in the end, and a question is news that needs Watcher, which takes everything
  // waiting with it.
  w.reconciling.clear()
  await apply(w, 'question')
  for (let round = 0; round < 6; round++) { await quiesce(w, 'ack'); await apply(w, 'watcher-turn') }
  await quiesce(w, 'ack')
  const pending = (w.wakes as unknown as { pending: WatcherEvent[] }).pending
  const due = w.wakes.news().filter(event => w.wakes.needsAttention([event]))
  for (const event of due) expect(w.told.has(event.id) || pending.some(item => item.id === event.id) || hidden(w).some(item => hiddenEvents(item.news).some(other => other.id === event.id)),
    `${event.kind} was lost`).toBe(true)
  expect(pending.filter(event => w.wakes.needsAttention([event]))).toEqual([])
}

it.each([
  ['a send with news arriving mid-send', ['start', 'finish', 'mid-send', 'pump-ack']],
  ['a refusal, then news that needs Watcher', ['question', 'pump-fail', 'pump-fail', 'question', 'pump-ack']],
  ['only a thread’s own facts', ['local', 'local', 'pump-ack', 'start', 'local', 'pump-ack']],
  ['an unknown send and its late echo', ['question', 'pump-unknown', 'echo', 'pump-ack', 'pump-ack']],
  ['a failed save of an acknowledgement', ['question', 'save-fail', 'pump-ack', 'question', 'pump-ack']],
  ['a withdrawal as the worker starts a new turn', ['finish', 'start', 'pump-ack', 'checks', 'local', 'pump-ack']],
  ['an unknown send no echo ever settles', ['question', 'pump-unknown', 'lose-echo', 'pump-ack']],
  ['a restart mid-dispatch', ['question', 'pump-unknown', 'restart', 'pump-ack']],
  ['news that comes while a wake-up is being saved, after a miss', ['question', 'pump-fail', 'mid-save', 'pump-fail', 'pump-ack']],
  ['a crash between the two saves of a wake-up leaving', ['question', 'crash-between-saves', 'pump-ack', 'question', 'pump-fail', 'crash-between-saves', 'watcher-turn', 'pump-ack']],
  ['queues earlier builds saved', ['question', 'legacy', 'pump-ack', 'pump-fail', 'watcher-turn', 'pump-ack']],
  ['refusals past the bound', ['question', 'pump-fail', 'watcher-turn', 'pump-fail', 'watcher-turn', 'pump-fail', 'watcher-turn', 'pump-fail', 'watcher-turn']],
] as const)('keeps the hidden wake-up’s rules through %s', async (_, steps) => {
  const w = await world()
  for (const step of steps) { await apply(w, step); await check(w) }
  await noneLost(w)
}, 60_000)

it('never wakes Watcher for a thread’s own facts alone', async () => {
  const w = await world()
  for (const step of ['local', 'local', 'start', 'local', 'local', 'watcher-turn', 'local'] as const) { await apply(w, step); await check(w) }
  expect(w.sends).toEqual([])
})

it('keeps the hidden wake-up’s rules through seeded random sequences', async () => {
  const steps: Step[] = ['finish', 'start', 'question', 'answer', 'checks', 'local', 'local', 'pump-ack', 'pump-fail', 'pump-unknown', 'echo', 'lose-echo', 'restart',
    'watcher-turn', 'save-fail', 'mid-send', 'legacy', 'crash-between-saves', 'mid-save']
  for (let seed = 1; seed <= 30; seed++) {
    const next = random(seed), w = await world()
    for (let step = 0; step < 16; step++) { await apply(w, steps[Math.floor(next() * steps.length)]!); await check(w) }
    await noneLost(w)
    const saved = JSON.parse(await readFile(join(w.directory, 'followups.json'), 'utf8').catch(() => '{"items":[]}')) as { items: QueuedFollowup[] }
    expect(saved.items.filter(item => item.threadId === watcherId() && isWatcherOnlyWakeUp(item)).length).toBeLessThanOrEqual(1)
    w.wakes.close()
  }
  for (const outcome of ['told', 'failed', 'unknown', 'withdrawn'] as const) expect(outcomes[outcome], outcome).toBeGreaterThan(0)
}, 180_000)
