// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { FollowupStore, type QueuedFollowup, type WordWakeUp } from '../../../src/main/agents/followups'
import { HIDDEN_WAKE_UP_ATTEMPTS, hiddenEvents, hiddenWakeUpAction, needsWatcherNow } from '../../../src/main/agents/hiddenWakeUp'
import { isWatcherOnlyWakeUp, queuedWakeUpText, type WakeUpNews } from '../../../src/main/agents/wakeUp'

/**
 * Drives Watcher's hidden wake-up through table-driven and seeded random sequences (news, sends that land, fail or go
 * unknown, late echoes, Stops, Watcher's own turns, prunes and restarts) with the real store and the one policy the
 * coordinator applies (hiddenWakeUp.ts), and checks its rules after every step:
 * (a) at most one hidden wake-up, after any load; (b) nothing repeats without news that needs Watcher, and tries are
 * bounded; (c) no send carries only events that did not need Watcher; (d) an event leaves only with an acknowledged send
 * that carried it, or when it is withdrawn or let go to be observed afresh.
 */
const directories: string[] = []
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }) })
const hostId = '11111111-1111-4111-8111-111111111111', thread = 'watcher-thread'
const word: WordWakeUp = news => queuedWakeUpText(news, { tool: false })
function random(seed: number): () => number {
  let state = seed >>> 0
  return () => { state = (state * 1_664_525 + 1_013_904_223) >>> 0; return state / 2 ** 32 }
}

interface World {
  store: FollowupStore; directory: string; writes: number
  watcher: { running: boolean; lastTurn: { id: string; status: 'completed' | 'interrupted' } | undefined }
  echoes: Set<string>; observed: Map<string, boolean>; acknowledged: Set<string>; released: Set<string>
  sends: { carried: string[] }[]; renewals: number
}
async function world(): Promise<World> {
  const directory = await mkdtemp(join(tmpdir(), 'sotto-hidden-wake-'))
  if (dirname(resolve(directory)) !== resolve(tmpdir())) throw new Error('Unexpected fixture path')
  directories.push(directory)
  const w: World = { store: new FollowupStore(directory), directory, writes: 0, watcher: { running: false, lastTurn: undefined },
    echoes: new Set(), observed: new Map(), acknowledged: new Set(), released: new Set(), sends: [], renewals: 0 }
  await load(w)
  return w
}
async function load(w: World): Promise<void> {
  w.store = new FollowupStore(w.directory); await w.store.load()
  const inner = (w.store as unknown as { store: { write: (value: unknown) => Promise<void> } }).store, write = inner.write.bind(inner)
  inner.write = async value => { w.writes++; await write(value) }
}
const hidden = (w: World): QueuedFollowup[] => w.store.peek().items.filter(item => item.threadId === thread && isWatcherOnlyWakeUp(item))

/** News of one event, and whether it needed Watcher when it was observed. */
async function news(w: World, attention: boolean): Promise<void> {
  const id = randomUUID()
  w.observed.set(id, attention)
  if (attention) w.renewals++
  const item: WakeUpNews = { source: 'watcher', watcher: { hostId, threadId: thread }, omitted: 0, events: [{ id, requestId: randomUUID(),
    target: { hostId, threadId: `worker-${id}` }, generation: 0, kind: attention ? 'turn-finished' : 'evidence-changed', turnId: id,
    ...attention ? {} : { evidenceIds: [id], revision: id }, observedAt: new Date().toISOString() }] }
  await w.store.queueWakeUp(thread, item, word, undefined, attention ? new Set([id]) : new Set())
}

/** One pass of the coordinator's pump over the hidden wake-up; `outcome` says how a send it makes ends. Returns whether it acted. */
async function pump(w: World, outcome: 'ack' | 'fail' | 'unknown'): Promise<boolean> {
  const first = w.store.peek().items.find(item => item.threadId === thread)
  if (!first || !isWatcherOnlyWakeUp(first)) return false
  const resting = !w.watcher.running
  const action = hiddenWakeUpAction(first, { resting, finished: resting && w.watcher.lastTurn?.status === 'completed' && w.watcher.lastTurn.id !== first.resumeAfterTurnId,
    echoed: !!first.messageId && w.echoes.has(first.messageId), reconciling: false,
    holdingOthers: w.store.peek().items.slice(w.store.peek().items.indexOf(first) + 1).some(item => item.threadId === thread && !isWatcherOnlyWakeUp(item)) })
  if (action === 'none') return false
  if (action === 'acknowledge') { for (const id of first.carried ?? []) w.acknowledged.add(id); await w.store.settleSent(first.id, word); return true }
  if (action === 'revive') { await w.store.reviveWakeUp(first.id, w.watcher.lastTurn?.id ?? 'unknown'); return true }
  if (action === 'block') return w.store.blockWakeUp(first.id, 'Synthetic block')
  if (action === 'let-go') { for (const event of await w.store.letGoWakeUp(first.id, word)) w.released.add(event.id); return true }
  if (w.watcher.running) return false
  await w.store.claim(first.id)
  const sent = w.store.peek().items.find(item => item.id === first.id)!
  w.sends.push({ carried: [...sent.carried ?? []] })
  if (outcome === 'ack') { for (const id of sent.carried ?? []) w.acknowledged.add(id); await w.store.settleSent(sent.id, word); w.watcher.lastTurn = { id: randomUUID(), status: 'completed' } }
  else if (outcome === 'fail') await w.store.settle(sent.id, 'failed', 'Synthetic refusal')
  else { await w.store.settle(sent.id, 'uncertain', 'Synthetic unknown'); if (sent.messageId) w.echoes.add(sent.messageId) }
  return true
}

/** Pumps until nothing more happens by itself, as the coordinator does, and says how many passes acted. */
async function settle(w: World, outcome: 'ack' | 'fail' | 'unknown'): Promise<number> {
  let acted = 0
  for (let pass = 0; pass < 40; pass++) { if (!await pump(w, outcome)) return acted; acted++ }
  throw new Error('The hidden wake-up kept acting without news (rule b)')
}

function check(w: World): void {
  // (a) One hidden wake-up at most.
  expect(hidden(w).length).toBeLessThanOrEqual(1)
  // (c) No send carried only events that did not need Watcher.
  for (const send of w.sends) expect(send.carried.some(id => w.observed.get(id))).toBe(true)
  // (d) Every event is still held, or left with an acknowledged send that carried it, or was let go to be observed afresh.
  const held = new Set(hidden(w).flatMap(item => hiddenEvents(item.news).map(event => event.id)))
  for (const id of w.observed.keys()) expect(held.has(id) || w.acknowledged.has(id) || w.released.has(id)).toBe(true)
  // (b) Tries are bounded: each run of news that needs Watcher earns at most the budget.
  expect(w.sends.length).toBeLessThanOrEqual((w.renewals + 1) * HIDDEN_WAKE_UP_ATTEMPTS)
}

it.each([
  ['a refusal, then news that needs Watcher', [['news', true], ['pump', 'fail'], ['pump', 'fail'], ['news', true], ['pump', 'ack']]],
  ['only a thread’s own facts', [['news', false], ['pump', 'ack'], ['news', false], ['restart'], ['pump', 'ack']]],
  ['news folded while a send is unknown, and its late echo', [['news', true], ['claim-unknown'], ['news', true], ['echo'], ['pump', 'ack'], ['pump', 'ack']]],
  ['a Stop, a restart and Watcher’s own turn', [['news', true], ['pause'], ['restart'], ['turn'], ['pump', 'ack']]],
  ['two hidden wake-ups an earlier build saved', [['legacy'], ['pump', 'fail'], ['pump', 'fail'], ['pump', 'fail'], ['pump', 'fail'], ['pump', 'fail']]],
] as const)('keeps the hidden wake-up’s rules through %s', async (_, steps) => {
  const w = await world()
  for (const step of steps) { await apply(w, step as unknown as Step); check(w) }
})

type Step = readonly ['news', boolean] | readonly ['pump', 'ack' | 'fail' | 'unknown'] | readonly ['restart'] | readonly ['pause'] | readonly ['turn']
  | readonly ['legacy'] | readonly ['claim-unknown'] | readonly ['echo'] | readonly ['user'] | readonly ['prune']
async function apply(w: World, step: Step): Promise<void> {
  switch (step[0]) {
    case 'news': await news(w, step[1]); break
    case 'pump': await settle(w, step[1]); break
    case 'restart': await load(w); break
    case 'pause': await w.store.pause(thread, 'Synthetic Stop'); w.watcher.lastTurn = { id: randomUUID(), status: 'interrupted' }; break
    case 'turn': w.watcher.lastTurn = { id: randomUUID(), status: 'completed' }; break
    case 'user': await w.store.enqueue({ threadId: thread, draftId: randomUUID(), text: 'Synthetic user follow-up', attachments: [] }); break
    case 'prune': {
      const item = hidden(w)[0]
      if (item && ['queued', 'paused', 'failed'].includes(item.status)) {
        const drop = new Set(hiddenEvents(item.news).filter((_, index) => index % 2 === 0).map(event => event.id))
        for (const id of drop) w.released.add(id)
        await w.store.pruneWakeUp(item.id, () => true, word, part => 'events' in part ? { ...part, events: part.events.filter(event => !drop.has(event.id)) } : part)
      }
      break
    }
    case 'claim-unknown': {
      const item = hidden(w)[0]
      if (item?.status === 'queued' && needsWatcherNow(item) && (item.attempts ?? 0) < HIDDEN_WAKE_UP_ATTEMPTS) {
        await w.store.claim(item.id)
        const sent = w.store.peek().items.find(other => other.id === item.id)!
        w.sends.push({ carried: [...sent.carried ?? []] })
        await w.store.settle(item.id, 'uncertain', 'Synthetic unknown'); w.echoes.delete(sent.messageId!)
        if (sent.messageId) (w as World & { pendingEcho?: string }).pendingEcho = sent.messageId
      }
      break
    }
    case 'echo': { const id = (w as World & { pendingEcho?: string }).pendingEcho; if (id) w.echoes.add(id); break }
    case 'legacy': {
      // An earlier build saved two hidden wake-ups for one Watcher, without the fields this build keeps.
      const item = (id: string): unknown => ({ id: randomUUID(), threadId: thread, draftId: randomUUID(), text: 'Synthetic earlier words', attachments: [], status: 'queued',
        wakeUp: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        news: [{ source: 'watcher', watcher: { hostId, threadId: thread }, omitted: 0, events: [{ id, requestId: randomUUID(), target: { hostId, threadId: `worker-${id}` },
          generation: 0, kind: 'turn-finished', turnId: id, observedAt: new Date().toISOString() }] }] })
      const ids = [randomUUID(), randomUUID()]
      for (const id of ids) w.observed.set(id, true)
      w.renewals += 2
      await writeFile(join(w.directory, 'followups.json'), JSON.stringify({ items: ids.map(item), receipts: [] }))
      await load(w)
      break
    }
  }
}

it('keeps the hidden wake-up’s rules through seeded random sequences, with a bound on queue writes', async () => {
  for (let seed = 1; seed <= 40; seed++) {
    const next = random(seed), w = await world()
    const pick = <T>(values: readonly T[]): T => values[Math.floor(next() * values.length)]!
    for (let step = 0; step < 18; step++) {
      const choice = pick(['news-attention', 'news-facts', 'pump-ack', 'pump-fail', 'pump-unknown', 'restart', 'pause', 'turn', 'user', 'prune', 'echo-all'] as const)
      if (choice === 'news-attention') await apply(w, ['news', true])
      else if (choice === 'news-facts') await apply(w, ['news', false])
      else if (choice === 'pump-ack') await apply(w, ['pump', 'ack'])
      else if (choice === 'pump-fail') await apply(w, ['pump', 'fail'])
      else if (choice === 'pump-unknown') await apply(w, ['pump', 'unknown'])
      else if (choice === 'echo-all') await settle(w, 'ack')
      else await apply(w, [choice] as unknown as Step)
      check(w)
      // With nothing new, pumping again changes nothing and writes nothing.
      const writes = w.writes
      await settle(w, 'fail'); await settle(w, 'fail')
      const quiet = w.writes
      await settle(w, 'fail')
      expect(w.writes - quiet).toBe(0)
      // Each try is at most a revival, a claim and its outcome; then at most one block.
      expect(quiet - writes).toBeLessThanOrEqual(3 * HIDDEN_WAKE_UP_ATTEMPTS + 2)
      check(w)
    }
    expect(JSON.parse(await readFile(join(w.directory, 'followups.json'), 'utf8')).items.filter((item: QueuedFollowup) => item.threadId === thread && isWatcherOnlyWakeUp(item)).length).toBeLessThanOrEqual(1)
  }
}, 120_000)
