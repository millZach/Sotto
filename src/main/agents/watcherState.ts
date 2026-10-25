import { readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { AtomicJsonStore } from '../storage/atomicJsonStore'
import { WATCHER_KEPT_CLOSED_MAX, WATCHER_KEPT_CLOSED_MS, WATCHER_KEPT_ITEMS_MAX, WATCHER_KEPT_LISTS, watcherKeptLegacySchema, watcherKeptRecordSchema,
  type WatcherKeepStateInput, type WatcherKeptItem, type WatcherKeptList, type WatcherKeptRecord, type WatcherKeptState } from '../../shared/watcher'
import type { WatcherRoomState } from '../../shared/watcherRoom'

const nothingKept = (): WatcherKeptRecord => ({ decisions: [], rules: [], issues: [], updatedAt: null, nextId: 1 })
const FILE = 'watcher-state.json'
const LETTER: Record<WatcherKeptList, string> = { decisions: 'd', rules: 'r', issues: 'i' }
const LIST_OF: Record<string, WatcherKeptList> = { d: 'decisions', r: 'rules', i: 'issues' }
const NAME: Record<WatcherKeptList, string> = { decisions: 'Decisions', rules: 'Rules', issues: 'Issues' }

/**
 * A saved file as the record. One an earlier build saved holds three lists of words: each line gets an ID, in list
 * order, and counts as touched when that file was last kept, so read_state can say which have gone untouched since.
 */
export function readKeptRecord(input: unknown, now: string): WatcherKeptRecord {
  const legacy = watcherKeptLegacySchema.safeParse(input)
  if (!legacy.success) return watcherKeptRecordSchema.parse(input)
  let nextId = 1
  const touchedAt = legacy.data.updatedAt ?? now
  const lines = (list: WatcherKeptList): WatcherKeptItem[] => legacy.data[list].map(text => ({ id: `${LETTER[list]}${nextId++}`, text, touchedAt }))
  return { decisions: lines('decisions'), rules: lines('rules'), issues: lines('issues'), updatedAt: legacy.data.updatedAt, nextId }
}

/** The kept lines as Watcher reads them: without a closed line Sotto has cleared, about a day after it was closed. */
export function keptAsShown(record: WatcherKeptRecord, now: number): WatcherKeptState {
  const stays = (line: WatcherKeptItem) => line.closedAt === undefined || Date.parse(line.closedAt) + WATCHER_KEPT_CLOSED_MS > now
  return { decisions: record.decisions.filter(stays), rules: record.rules.filter(stays), issues: record.issues.filter(stays), updatedAt: record.updatedAt }
}
/** When the next closed line clears, or Infinity when none is closed. */
function nextClearing(record: WatcherKeptRecord): number {
  let at = Infinity
  for (const list of WATCHER_KEPT_LISTS) for (const line of record[list]) if (line.closedAt !== undefined) at = Math.min(at, Date.parse(line.closedAt) + WATCHER_KEPT_CLOSED_MS)
  return at
}

/** Why keep_state kept nothing, in Watcher's words: what was wrong and what to do. */
export interface WatcherKeepRefusal { readonly code: 'INVALID_INPUT' | 'STATE_FULL'; readonly message: string }

/**
 * keep_state's change, worked out whole before anything is kept: every line it edits or closes must be there, and no
 * list it changes may pass WATCHER_KEPT_ITEMS_MAX open lines, or the call is refused and nothing changes. Adding never
 * makes room by dropping another line; a list given whole replaces only its open lines, and its closed lines stay until
 * they clear. Each change is safe to repeat: adding words a list already has open touches that line, and closing a
 * closed line or dropping one already gone changes nothing.
 */
export function applyKeep(record: WatcherKeptRecord, input: WatcherKeepStateInput, now: string): WatcherKeptRecord | WatcherKeepRefusal {
  const refused = (code: WatcherKeepRefusal['code'], message: string): WatcherKeepRefusal => ({ code, message: `${message} Nothing was kept.` })
  const shown = keptAsShown(record, Date.parse(now))
  const next: Record<WatcherKeptList, WatcherKeptItem[]> = { decisions: [...shown.decisions], rules: [...shown.rules], issues: [...shown.issues] }
  let nextId = record.nextId
  const named = [...input.edit?.map(item => item.id) ?? [], ...input.close?.map(item => item.id) ?? [], ...input.drop ?? []]
  const twice = named.find((id, at) => named.indexOf(id) !== at)
  if (twice) return refused('INVALID_INPUT', `Line ${twice} is named twice. Change each line once in a call.`)
  const changed = new Set<WatcherKeptList>([...input.add?.map(item => item.list) ?? [], ...named.map(id => LIST_OF[id[0]!]!)])
  for (const list of WATCHER_KEPT_LISTS) {
    const words = input[list]
    if (!words) continue
    if (changed.has(list)) return refused('INVALID_INPUT', `${NAME[list]} was given whole and changed by line in the same call. Do one or the other.`)
    const open = next[list].filter(line => line.closedAt === undefined), closed = next[list].filter(line => line.closedAt !== undefined)
    next[list] = [...[...new Set(words)].map(text => open.find(line => line.text === text) ?? { id: `${LETTER[list]}${nextId++}`, text, touchedAt: now }), ...closed]
    changed.add(list)
  }
  const find = (id: string) => {
    const list = LIST_OF[id[0]!]!, at = next[list].findIndex(line => line.id === id)
    return { list, at, line: next[list][at] }
  }
  for (const { id, text } of input.edit ?? []) {
    const { list, at, line } = find(id)
    if (!line) return refused('INVALID_INPUT', `No line ${id} is kept. read_state gives each line’s ID.`)
    if (line.closedAt !== undefined) return refused('INVALID_INPUT', `Line ${id} is closed. Add it again if it is open once more.`)
    next[list][at] = { id, text, touchedAt: now }
  }
  for (const { id, note } of input.close ?? []) {
    const { list, at, line } = find(id)
    if (!line) return refused('INVALID_INPUT', `No line ${id} is kept. read_state gives each line’s ID.`)
    if (line.closedAt === undefined) next[list][at] = { ...line, closedAt: now, ...note === undefined ? {} : { closedNote: note } }
  }
  for (const id of input.drop ?? []) { const { list, at } = find(id); if (at !== -1) next[list].splice(at, 1) }
  for (const { list, text } of input.add ?? []) {
    const at = next[list].findIndex(line => line.closedAt === undefined && line.text === text)
    if (at !== -1) next[list][at] = { ...next[list][at]!, touchedAt: now }
    else next[list].push({ id: `${LETTER[list]}${nextId++}`, text, touchedAt: now })
  }
  for (const list of WATCHER_KEPT_LISTS) {
    const open = next[list].filter(line => line.closedAt === undefined).length
    if (changed.has(list) && open > WATCHER_KEPT_ITEMS_MAX) {
      return refused('STATE_FULL', `${NAME[list]} would hold ${open} open lines, and it holds at most ${WATCHER_KEPT_ITEMS_MAX}. Close the lines that are done or drop ones no longer needed, then add again.`)
    }
    // Closed lines past their limit are done: the oldest clear now rather than in a day.
    const closed = next[list].filter(line => line.closedAt !== undefined).sort((a, b) => Date.parse(a.closedAt!) - Date.parse(b.closedAt!))
    if (closed.length > WATCHER_KEPT_CLOSED_MAX) {
      const cleared = new Set(closed.slice(0, closed.length - WATCHER_KEPT_CLOSED_MAX))
      next[list] = next[list].filter(line => !cleared.has(line))
    }
  }
  return { ...next, updatedAt: now, nextId }
}

/**
 * Watcher's kept state (#1189): the user's pending decisions, the standing rules the user gave and the issues Watcher
 * filed, which it keeps with keep_state, a line at a time, so that compacting its conversation loses none of them. They are the user's and
 * Watcher's words, so they are saved, in `watcher-state.json` beside `agents.json`, only while Keep local history is on.
 * Otherwise they live in memory, and the file, its recovery copies and any temporary write are removed, at start and as
 * soon as history is turned off. Every read and write goes in turn, so two calls never lose each other's lists.
 */
export class WatcherStateStore {
  private kept = nothingKept()
  /** What `read` gives while the record is this one and no closed line has cleared since. */
  private shown: { record: WatcherKeptRecord; until: number; state: WatcherKeptState } | undefined
  private readonly store: AtomicJsonStore<WatcherKeptRecord>
  private tail: Promise<unknown> = Promise.resolve()
  /** Whether the saved state could not be read at start: it is read again before anything is read or kept. */
  private unread = false
  constructor(private readonly directory: string, private readonly historyEnabled: () => boolean, private readonly clock: () => number = Date.now) {
    this.store = new AtomicJsonStore(join(directory, FILE), input => readKeptRecord(input, new Date(this.clock()).toISOString()), nothingKept)
    void this.inTurn(async () => { if (this.historyEnabled()) this.kept = await this.store.read(); else await this.removeSaved() }).catch(() => { this.unread = true })
  }
  /**
   * The saved state once it has been read. A read that failed at start, as on a passing permission or disk error, is tried
   * again here, and fails again rather than give empty lists, which a later keep_state would save over what was kept.
   */
  private async ensureRead(): Promise<void> {
    if (!this.unread) return
    if (this.historyEnabled()) this.kept = await this.store.read()
    this.unread = false
  }
  /** What is kept, read from disk first if the start could not. */
  current(): Promise<WatcherKeptState> { return this.inTurn(async () => { await this.ensureRead(); return this.read() }) }
  private inTurn<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.catch(() => undefined).then(work)
    this.tail = next
    return next
  }
  /** The saved file and everything the store may leave beside it: recovery copies of a damaged file and temporary writes. */
  private async removeSaved(): Promise<void> {
    // Only a folder that is not there holds nothing; any other failure is the privacy cleanup's to report and retry.
    const names = await readdir(this.directory).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [] as string[]
      throw error
    })
    await Promise.all(names.filter(name => name === FILE || name.startsWith(`${FILE}.`)).map(name => unlink(join(this.directory, name)).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    })))
  }
  /**
   * What is kept as Watcher reads it. The room reads it on every update, so it is worked out again only when the record
   * changes or a closed line clears.
   */
  read(): WatcherKeptState {
    const now = this.clock(), shown = this.shown
    if (shown && shown.record === this.kept && now < shown.until) return shown.state
    const state = keptAsShown(this.kept, now)
    this.shown = { record: this.kept, until: nextClearing(this.kept), state }
    return state
  }
  /** Applies keep_state's change (`applyKeep`), or keeps nothing and says why. */
  keep(input: WatcherKeepStateInput, now: string): Promise<WatcherKeptState | WatcherKeepRefusal> {
    return this.inTurn(async () => {
      await this.ensureRead()
      const next = applyKeep(this.kept, input, now)
      if (!('nextId' in next)) return next
      if (this.historyEnabled()) await this.store.write(next)
      else await this.removeSaved()
      this.kept = next
      return this.read()
    })
  }
  /** Keep local history changed: turned off, nothing kept stays on disk; turned on, what is kept now is saved. */
  privacyChanged(): Promise<void> {
    // Every settings save comes here. A saved state not read yet is read first, so what is kept is never written over it;
    // one still unreadable is left as it is, and the privacy cleanup reports it.
    return this.inTurn(async () => { if (this.historyEnabled()) { await this.ensureRead(); await this.store.write(this.kept) } else await this.removeSaved() })
  }
  /** Whether what is kept is known: false while a saved state could not be read, when the lists say nothing of it. */
  readable(): boolean { return !this.unread }
}

type WatchedThread = WatcherRoomState['watchedThreads'][number]
/** What a watched thread waits on, in Sotto's words, from its own facts: never anything it said. */
export function watcherWaitsOn(thread: Pick<WatchedThread, 'status' | 'connected' | 'settled' | 'backgroundWorkCount' | 'paused'>
  & { readonly waitsOn: readonly { readonly kind: 'question' | 'permission' }[]; readonly delegatedWaitsOn?: readonly { readonly kind: 'question' | 'permission' }[]
    readonly prototypeReady?: boolean }): string {
  if (thread.waitsOn.some(card => card.kind === 'permission')) return 'The user’s answer to its permission request.'
  if (thread.waitsOn.length) return 'The user’s answer to its question.'
  // A prototype waiting for review is the user's to open, as a card is theirs to answer (ADR-0108).
  if (thread.prototypeReady) return 'The user’s review of the prototype it made. Only the user can review it.'
  // A thread it delegated to is its to see through (#1190), so that thread's card is what it waits on too.
  if (thread.delegatedWaitsOn?.some(card => card.kind === 'permission')) return 'The user’s answer to a permission request in a thread it delegated to.'
  if (thread.delegatedWaitsOn?.length) return 'The user’s answer to a question in a thread it delegated to.'
  if (thread.status === 'unavailable' || !thread.connected) return 'Its computer or provider to connect again.'
  if (thread.paused) return 'The user’s own turn in it to end. Watcher sends it nothing until then.'
  if (thread.status === 'running') return 'Its turn to finish.'
  if (thread.backgroundWorkCount > 0) return 'The background work or sub-agents its last turn left running to end.'
  if (thread.status === 'error') return 'A look at its failed turn.'
  if (thread.settled) return 'Nothing. It is settled.'
  return 'Nothing. It is at rest.'
}
