import { readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { AtomicJsonStore } from '../storage/atomicJsonStore'
import { watcherKeptStateSchema, type WatcherKeptState, type WatcherToolInput } from '../../shared/watcher'
import type { WatcherRoomState } from '../../shared/watcherRoom'

const nothingKept = (): WatcherKeptState => ({ decisions: [], rules: [], issues: [], updatedAt: null })
const FILE = 'watcher-state.json'

/**
 * Watcher's kept state (#1189): the user's pending decisions, the standing rules the user gave and the issues Watcher
 * filed, which it keeps with keep_state so that compacting its conversation loses none of them. They are the user's and
 * Watcher's words, so they are saved, in `watcher-state.json` beside `agents.json`, only while Keep local history is on.
 * Otherwise they live in memory, and the file, its recovery copies and any temporary write are removed, at start and as
 * soon as history is turned off. Every read and write goes in turn, so two calls never lose each other's lists.
 */
export class WatcherStateStore {
  private kept = nothingKept()
  private readonly store: AtomicJsonStore<WatcherKeptState>
  private tail: Promise<unknown> = Promise.resolve()
  /** Whether the saved state could not be read at start: it is read again before anything is read or kept. */
  private unread = false
  constructor(private readonly directory: string, private readonly historyEnabled: () => boolean) {
    this.store = new AtomicJsonStore(join(directory, FILE), input => watcherKeptStateSchema.parse(input), nothingKept)
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
  current(): Promise<WatcherKeptState> { return this.inTurn(async () => { await this.ensureRead(); return this.kept }) }
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
  read(): WatcherKeptState { return this.kept }
  /** Replaces each list given and keeps the rest. */
  keep(input: WatcherToolInput<'keep_state'>, now: string): Promise<WatcherKeptState> {
    return this.inTurn(async () => {
      await this.ensureRead()
      const next = { decisions: input.decisions ?? this.kept.decisions, rules: input.rules ?? this.kept.rules, issues: input.issues ?? this.kept.issues, updatedAt: now }
      if (this.historyEnabled()) await this.store.write(next)
      else await this.removeSaved()
      this.kept = next
      return next
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
  & { readonly waitsOn: readonly { readonly kind: 'question' | 'permission' }[] }): string {
  if (thread.waitsOn.some(card => card.kind === 'permission')) return 'The user’s answer to its permission request.'
  if (thread.waitsOn.length) return 'The user’s answer to its question.'
  if (thread.status === 'unavailable' || !thread.connected) return 'Its computer or provider to connect again.'
  if (thread.paused) return 'The user’s own turn in it to end. Watcher sends it nothing until then.'
  if (thread.status === 'running') return 'Its turn to finish.'
  if (thread.backgroundWorkCount > 0) return 'The background work its last turn left running to end.'
  if (thread.status === 'error') return 'A look at its failed turn.'
  if (thread.settled) return 'Nothing. It is settled.'
  return 'Nothing. It is at rest.'
}
