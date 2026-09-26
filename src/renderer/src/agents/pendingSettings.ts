import { useSyncExternalStore } from 'react'
import { hostForThread, type AgentCommand, type AgentModel, type AgentRuntimeMode, type AgentState, type AgentThread } from '../../../shared/agents'

/** The three settings an option chip changes. */
export type SettingKind = 'model' | 'effort' | 'permissions'
export type SettingsPatch = { readonly modelId?: string; readonly reasoningEffort?: string; readonly runtimeMode?: AgentRuntimeMode; readonly providerMode?: string }
/** A thread's settings as the window drew them from main's published state, one string per chip. */
export type SettingValues = Readonly<Record<SettingKind, string>>
/** The connection's command, from the render a press was made in: a press belongs to the thread it was made on. */
export type SendSettings = (command: Extract<AgentCommand, { type: 'configure-thread' }>) => Promise<AgentState | null>

/**
 * A pending setting (CONTEXT.md): the value a chip shows because the user pressed it, while the thread's provider
 * has not confirmed it in the state this window draws.
 * - `provider`: the save is in flight.
 * - `window`: main has answered and the window has not drawn the state that says so yet (#306).
 * - `unconfirmed`: the provider never gave a result. Main keeps the change for the thread's next start and takes no
 *   other action on the thread meanwhile; `error` is its account of what happened.
 */
export interface PendingSetting { readonly value: string; readonly awaiting: 'provider' | 'window' | 'unconfirmed'; readonly error: string | null }
/** A press the provider did not take. `error` is main's own sentence, or null when no answer came back. */
export interface SettingRefusal { readonly kind: SettingKind; readonly wanted: string; readonly patch: SettingsPatch; readonly error: string | null }
export interface PendingSettingsView {
  readonly pending: Readonly<Partial<Record<SettingKind, PendingSetting>>>
  /** One per setting, so a press on another chip does not take away the alert that says which value is in force. */
  readonly refusals: Readonly<Partial<Record<SettingKind, SettingRefusal>>>
}

const KINDS: readonly SettingKind[] = ['model', 'effort', 'permissions']
const EMPTY: PendingSettingsView = { pending: {}, refusals: {} }
/**
 * How long a confirmed press is held for the window to draw it. Main publishes the state its answer carries, so
 * this only runs out when something newer moved the setting past it before the window drew it; the chip then
 * shows what the thread reports, which is the provider's word either way.
 */
export const CONFIRMED_HOLD_MS = 4_000

interface Press { readonly value: string; readonly patch: SettingsPatch }
interface Entry {
  desired: Press
  /** A save loop is running for this setting. */
  sending: boolean
  /** A press made while a save was in flight; the loop sends the last one when that save answers. */
  next: Press | null
  /** What main answered the last save with, while the window has not drawn it yet. */
  expected: string | null
  release: ReturnType<typeof setTimeout> | null
  /** Main's account of a result the provider never gave, and whether the window has drawn main keeping the change. */
  unconfirmed: { readonly error: string | null; drawn: boolean } | null
}

/** Each setting's value on this thread as its own model reads it: the defaults are the model's. */
export function settingValues(state: AgentState, thread: AgentThread): SettingValues {
  const model = hostForThread(state.host, thread).models.find(item => item.id === thread.modelId)
  return settingValuesFor(thread, model)
}
export function settingValuesFor(thread: Pick<AgentThread, 'modelId' | 'reasoningEffort' | 'runtimeMode' | 'providerMode'>, model: AgentModel | undefined): SettingValues {
  return {
    model: thread.modelId,
    effort: thread.reasoningEffort ?? model?.defaultReasoningEffort ?? '',
    permissions: (usesProviderModes(model) ? thread.providerMode ?? model?.providerModes?.[0]?.id : thread.runtimeMode) ?? '',
  }
}
/** Whether this model's permission list is the provider's own vocabulary rather than Sotto's four. */
export const usesProviderModes = (model: AgentModel | undefined): boolean => (model?.providerModes?.length ?? 0) > 0
/** The change a permission press sends: the provider's own mode where it names its own, Sotto's mode otherwise. */
export const permissionPatch = (model: AgentModel | undefined, mode: string): SettingsPatch =>
  usesProviderModes(model) ? { providerMode: mode } : { runtimeMode: mode as AgentRuntimeMode }

/** The settings on this thread that main keeps with no result from the provider. */
export function unconfirmedKinds(state: AgentState | null, threadId: string): ReadonlySet<SettingKind> {
  const kinds = new Set<SettingKind>()
  for (const item of state?.unconfirmedSettings ?? []) {
    if (item.threadId !== threadId) continue
    if (item.modelId !== undefined) kinds.add('model')
    if (item.reasoningEffort !== undefined) kinds.add('effort')
    if (item.runtimeMode !== undefined || item.providerMode !== undefined) kinds.add('permissions')
  }
  return kinds
}

/**
 * What each thread's option chips show between a press and the provider's answer: desired against confirmed, per
 * thread and per setting. The confirmed value is always the one the window drew from main's published state; this
 * holds only the press. A press shows at once. A press made while a save of the same setting is in flight waits,
 * and only the last one is sent when that save answers. A refusal lets go of the press, so the chip shows the value
 * still in force, and keeps what main said for the alert under the chips. A result the provider never gave keeps the
 * press, because main keeps the change for the thread's next start, until the thread shows it or main lets it go. A
 * confirmed press is held until the window draws the value main answered with, so the chip never steps back through
 * the old value on the way.
 *
 * Nothing here gates a send: main runs a thread's settings and its prompts in that thread's own lane, in the order
 * they arrive, so a prompt sent after a press runs on the settings the press asked for (#311).
 */
export class PendingSettingsStore {
  private readonly entries = new Map<string, Entry>()
  private readonly refusals = new Map<string, SettingRefusal>()
  /** What each thread's chips last drew, for a save that answers while no chip is drawing it. */
  private readonly lastDrawn = new Map<string, SettingValues>()
  private readonly views = new Map<string, PendingSettingsView>()
  private readonly listeners = new Set<() => void>()

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  view(threadId: string): PendingSettingsView { return this.views.get(threadId) ?? EMPTY }

  /**
   * Choose `value` for one setting. Sends at once unless a save of that setting is in flight. `showing` is what the
   * chip shows without a press, which is the drawn value unless another pending setting changes it (a model change
   * starts on the new model's default effort); a press on it with nothing pending has nothing to change.
   */
  press(threadId: string, kind: SettingKind, value: string, patch: SettingsPatch, send: SendSettings, drawn: SettingValues,
    showing: string = drawn[kind]): void {
    this.lastDrawn.set(threadId, drawn)
    this.refusals.delete(keyOf(threadId, kind))
    const key = keyOf(threadId, kind)
    let entry = this.entries.get(key)
    if (!entry) {
      if (showing === value) { this.emit(threadId); return }
      entry = { desired: { value, patch }, sending: false, next: null, expected: null, release: null, unconfirmed: null }
      this.entries.set(key, entry)
    } else {
      if (entry.desired.value === value && entry.unconfirmed === null) { this.emit(threadId); return }
      // Landing back on the value a save in flight is sending is covered by the loop's own exit.
      entry.desired = { value, patch }
      entry.unconfirmed = null
      this.hold(entry, null)
    }
    if (entry.sending) { entry.next = { value, patch }; this.emit(threadId); return }
    void this.run(threadId, kind, entry, { value, patch }, send)
  }

  /** Send a refused press again. */
  retry(threadId: string, kind: SettingKind, send: SendSettings, drawn: SettingValues): boolean {
    const refusal = this.refusals.get(keyOf(threadId, kind))
    if (!refusal) return false
    this.press(threadId, kind, refusal.wanted, refusal.patch, send, drawn, '')
    return true
  }

  /**
   * The values the window has just drawn for this thread, and which of its settings main keeps unconfirmed. A
   * confirmed press lets go once they carry what main answered with. An unconfirmed one lets go once the thread shows
   * it, or once main, having kept it, no longer does. A refusal is dropped once the thread shows the value it asked
   * for after all.
   */
  observe(threadId: string, values: SettingValues, unconfirmed: ReadonlySet<SettingKind> = new Set()): void {
    this.lastDrawn.set(threadId, values)
    let changed = false
    for (const kind of KINDS) {
      const key = keyOf(threadId, kind)
      const entry = this.entries.get(key)
      if (entry?.unconfirmed) {
        if (unconfirmed.has(kind)) entry.unconfirmed.drawn = true
        if (values[kind] === entry.desired.value || (entry.unconfirmed.drawn && !unconfirmed.has(kind))) { this.drop(key, entry); changed = true }
      } else if (entry && !entry.sending && entry.expected !== null && values[kind] === entry.expected) { this.drop(key, entry); changed = true }
      const refusal = this.refusals.get(key)
      if (refusal && values[kind] === refusal.wanted) { this.refusals.delete(key); changed = true }
    }
    if (changed) this.emit(threadId)
  }

  /** A thread's chips are gone from the window; its presses stay until they settle. */
  forget(threadId: string): void { this.lastDrawn.delete(threadId) }

  /** Let go of everything held for threads the state no longer has. */
  prune(threadIds: ReadonlySet<string>): void {
    const gone = new Set<string>()
    for (const map of [this.entries, this.refusals] as Map<string, unknown>[]) {
      for (const key of [...map.keys()]) {
        const threadId = key.slice(0, key.lastIndexOf('\0'))
        if (threadIds.has(threadId)) continue
        const entry = this.entries.get(key)
        if (entry) this.hold(entry, null)
        map.delete(key); gone.add(threadId)
      }
    }
    for (const threadId of this.lastDrawn.keys()) if (!threadIds.has(threadId)) this.lastDrawn.delete(threadId)
    for (const threadId of gone) this.emit(threadId)
  }

  /** Forget everything held for every thread; for tests. */
  clear(): void {
    for (const entry of this.entries.values()) this.hold(entry, null)
    const threads = new Set([...this.views.keys()])
    this.entries.clear(); this.refusals.clear(); this.lastDrawn.clear()
    for (const threadId of threads) this.emit(threadId)
  }

  private async run(threadId: string, kind: SettingKind, entry: Entry, first: Press, send: SendSettings): Promise<void> {
    const key = keyOf(threadId, kind)
    entry.sending = true
    this.emit(threadId)
    let target = first
    try {
      for (;;) {
        entry.next = null
        let reply: AgentState | null
        try { reply = await send({ type: 'configure-thread', threadId, ...target.patch }) } catch { reply = null }
        if (this.entries.get(key) !== entry) return
        // A newer press waited for this answer. The provider has one change in flight at a time, so the loop
        // sends where the user ended up, and what this answer said no longer decides what the chip shows.
        const next = entry.next as Press | null
        if (next !== null && next.value !== target.value) { target = next; continue }
        if (reply !== null && reply.error && unconfirmedKinds(reply, threadId).has(kind)) {
          // No result: main keeps the change for the thread's next start, so the chip keeps showing it.
          entry.unconfirmed = { error: reply.error, drawn: false }
          return
        }
        if (reply === null || reply.error) {
          this.drop(key, entry)
          this.refusals.set(key, { kind, wanted: target.value, patch: target.patch, error: reply?.error ?? null })
          return
        }
        const thread = reply.host.threads.find(item => item.id === threadId)
        const expected = thread ? settingValues(reply, thread)[kind] : null
        if (expected === null || this.lastDrawn.get(threadId)?.[kind] === expected) { this.drop(key, entry); return }
        this.hold(entry, expected, () => { if (this.entries.get(key) === entry && !entry.sending) { this.drop(key, entry); this.emit(threadId) } })
        return
      }
    } finally {
      entry.sending = false
      this.emit(threadId)
    }
  }

  private hold(entry: Entry, expected: string | null, release?: () => void): void {
    if (entry.release !== null) clearTimeout(entry.release)
    entry.expected = expected
    entry.release = release ? setTimeout(release, CONFIRMED_HOLD_MS) : null
  }

  private drop(key: string, entry: Entry): void {
    this.hold(entry, null)
    if (this.entries.get(key) === entry) this.entries.delete(key)
  }

  private emit(threadId: string): void {
    const pending: Partial<Record<SettingKind, PendingSetting>> = {}
    const refusals: Partial<Record<SettingKind, SettingRefusal>> = {}
    for (const kind of KINDS) {
      const entry = this.entries.get(keyOf(threadId, kind))
      if (entry) pending[kind] = { value: entry.desired.value, awaiting: entry.sending ? 'provider' : entry.unconfirmed ? 'unconfirmed' : 'window', error: entry.unconfirmed?.error ?? null }
      const refusal = this.refusals.get(keyOf(threadId, kind))
      if (refusal) refusals[kind] = refusal
    }
    const before = this.views.get(threadId) ?? EMPTY
    const same = KINDS.every(kind => before.refusals[kind] === refusals[kind] && before.pending[kind]?.value === pending[kind]?.value
      && before.pending[kind]?.awaiting === pending[kind]?.awaiting && before.pending[kind]?.error === pending[kind]?.error)
    if (same) return
    if (Object.keys(pending).length === 0 && Object.keys(refusals).length === 0) this.views.delete(threadId)
    else this.views.set(threadId, { pending, refusals })
    for (const listener of [...this.listeners]) listener()
  }
}

const keyOf = (threadId: string, kind: SettingKind): string => `${threadId}\0${kind}`

export const pendingSettingsStore = new PendingSettingsStore()

/** This thread's pending settings and refusals, as the chips and the pane read them. */
export function usePendingSettings(threadId: string, store: PendingSettingsStore = pendingSettingsStore): PendingSettingsView {
  return useSyncExternalStore(store.subscribe, () => store.view(threadId))
}
