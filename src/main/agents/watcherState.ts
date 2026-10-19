import { join } from 'node:path'
import { AtomicJsonStore } from '../storage/atomicJsonStore'
import { watcherKeptStateSchema, type WatcherKeptState, type WatcherToolInput } from '../../shared/watcher'
import type { WatcherRoomState } from '../../shared/watcherRoom'

const nothingKept = (): WatcherKeptState => ({ decisions: [], rules: [], issues: [], updatedAt: null })

/**
 * Watcher's kept state (#1189): the user's pending decisions, the standing rules the user gave and the issues Watcher
 * filed, which it keeps with keep_state so that compacting its conversation loses none of them. They are the user's and
 * Watcher's words, so they are saved, in `watcher-state.json` beside `agents.json`, only while Keep local history is on;
 * otherwise they live in memory and a saved file is emptied.
 */
export class WatcherStateStore {
  private kept = nothingKept()
  private readonly store: AtomicJsonStore<WatcherKeptState>
  readonly loaded: Promise<void>
  constructor(directory: string, private readonly historyEnabled: () => boolean) {
    this.store = new AtomicJsonStore(join(directory, 'watcher-state.json'), input => watcherKeptStateSchema.parse(input), nothingKept)
    this.loaded = this.load().catch(() => undefined)
  }
  private async load(): Promise<void> {
    if (this.historyEnabled()) { this.kept = await this.store.read(); return }
    if (await this.store.exists()) await this.store.write(nothingKept())
  }
  read(): WatcherKeptState { return this.kept }
  /** Replaces each list given and keeps the rest. */
  async keep(input: WatcherToolInput<'keep_state'>, now: string): Promise<WatcherKeptState> {
    await this.loaded
    const next = { decisions: input.decisions ?? this.kept.decisions, rules: input.rules ?? this.kept.rules, issues: input.issues ?? this.kept.issues, updatedAt: now }
    if (this.historyEnabled()) await this.store.write(next)
    else if (await this.store.exists()) await this.store.write(nothingKept())
    this.kept = next
    return next
  }
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
