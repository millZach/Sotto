import { useSyncExternalStore } from 'react'
import { hostForThread, type AgentCommand, type AgentModel, type AgentRuntimeMode, type AgentState, type AgentThread } from '../../../shared/agents'

/** The three settings an option chip changes. */
export type ThreadSettingKind = 'model' | 'effort' | 'permissions'
export type ThreadSettingsPatch = { readonly modelId?: string; readonly reasoningEffort?: string; readonly runtimeMode?: AgentRuntimeMode; readonly providerMode?: string }
/** A thread's settings as the window last drew them from main's published state, one string per chip. */
export type ThreadSettingValues = Readonly<Record<ThreadSettingKind, string>>
/** The connection's command, from the render a press was made in: a press belongs to the thread it was made on. */
export type SendThreadSettings = (command: Extract<AgentCommand, { type: 'configure-thread' }>) => Promise<AgentState | null>

/**
 * A pending setting: the value a chip shows because the user pressed it, while the provider has not confirmed it
 * in the state this window draws. `provider` while the save is in flight; `window` once main has answered and the
 * window has not yet drawn the state that says so (#306: a reply can land before the broadcast that carries it).
 */
export interface PendingSetting { readonly value: string; readonly awaiting: 'provider' | 'window' }
/** A press the provider did not take. `error` is main's own sentence, or null when the answer never came back. */
export interface SettingRefusal { readonly kind: ThreadSettingKind; readonly wanted: string; readonly patch: ThreadSettingsPatch; readonly error: string | null }
export interface ThreadSettingsView { readonly pending: Readonly<Partial<Record<ThreadSettingKind, PendingSetting>>>; readonly refusal: SettingRefusal | null }

const KINDS: readonly ThreadSettingKind[] = ['model', 'effort', 'permissions']
const EMPTY: ThreadSettingsView = { pending: {}, refusal: null }
/**
 * How long a confirmed press is held for the window to draw it. Main publishes the state its answer carries, so
 * this only runs out when something newer moved the setting past it before the window drew it; the chip then
 * shows what the thread reports, which is the provider's word either way.
 */
export const CONFIRMED_HOLD_MS = 4_000

interface Press { readonly value: string; readonly patch: ThreadSettingsPatch }
interface Entry {
  desired: Press
  /** A save loop is running for this setting. */
  sending: boolean
  /** A press made while a save was in flight; the loop sends the last one when that save answers. */
  next: Press | null
  /** What main answered the last save with, while the window has not drawn it yet. */
  expected: string | null
  release: ReturnType<typeof setTimeout> | null
}

/** Each setting's value on this thread as its own model reads it: the defaults are the model's. */
export function threadSettingValues(state: AgentState, thread: AgentThread): ThreadSettingValues {
  const model = hostForThread(state.host, thread).models.find(item => item.id === thread.modelId)
  return settingValuesFor(thread, model)
}
export function settingValuesFor(thread: Pick<AgentThread, 'modelId' | 'reasoningEffort' | 'runtimeMode' | 'providerMode'>, model: AgentModel | undefined): ThreadSettingValues {
  const own = (model?.providerModes?.length ?? 0) > 0
  return {
    model: thread.modelId,
    effort: thread.reasoningEffort ?? model?.defaultReasoningEffort ?? '',
    permissions: (own ? thread.providerMode ?? model?.providerModes?.[0]?.id : thread.runtimeMode) ?? '',
  }
}

/**
 * What each thread's option chips show between a press and the provider's answer: desired against confirmed, per
 * thread and per setting. The confirmed value is always the one the window drew from main's published state; this
 * holds only the press. A press shows at once. A press made while a save of the same setting is in flight waits
 * and only the last one is sent when that save answers. A refusal lets go of the press, so the chip shows the
 * value still in force, and keeps what main said for the alert under the chips. A confirmed press is held until
 * the window draws the value main answered with, so the chip never steps back through the old value on the way.
 *
 * Nothing here gates a send: main runs a thread's settings and its prompts in that thread's own lane, in the order
 * they arrive, so a prompt sent after a press runs on the settings the press asked for (#311).
 */
export class ThreadSettingsStore {
  private readonly entries = new Map<string, Entry>()
  private readonly refusals = new Map<string, SettingRefusal>()
  private readonly rendered = new Map<string, ThreadSettingValues>()
  private readonly views = new Map<string, ThreadSettingsView>()
  private readonly listeners = new Set<() => void>()

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  view(threadId: string): ThreadSettingsView { return this.views.get(threadId) ?? EMPTY }

  /**
   * Choose `value` for one setting. Sends at once unless a save of that setting is in flight. `showing` is what the
   * chip shows without a press, which is the drawn value unless another pending setting changes it (a model change
   * starts on the new model's default effort); a press on it with nothing pending has nothing to change.
   */
  press(threadId: string, kind: ThreadSettingKind, value: string, patch: ThreadSettingsPatch, send: SendThreadSettings, rendered: ThreadSettingValues,
    showing: string = rendered[kind]): void {
    this.observe(threadId, rendered, { quiet: true })
    this.refusals.delete(threadId)
    const key = keyOf(threadId, kind)
    let entry = this.entries.get(key)
    if (!entry) {
      if (showing === value) { this.emit(threadId); return }
      entry = { desired: { value, patch }, sending: false, next: null, expected: null, release: null }
      this.entries.set(key, entry)
    } else {
      if (entry.desired.value === value) { this.emit(threadId); return }
      // Landing back on the value a save in flight is sending is covered by the loop's own exit.
      entry.desired = { value, patch }
      this.hold(entry, null)
    }
    if (entry.sending) { entry.next = { value, patch }; this.emit(threadId); return }
    void this.run(threadId, kind, entry, { value, patch }, send)
  }

  /** Send the refused press again. */
  retry(threadId: string, send: SendThreadSettings, rendered: ThreadSettingValues): SettingRefusal | null {
    const refusal = this.refusals.get(threadId)
    if (!refusal) return null
    this.press(threadId, refusal.kind, refusal.wanted, refusal.patch, send, rendered, '')
    return refusal
  }

  /**
   * The values the window has just drawn for this thread. A confirmed press lets go once they carry what main
   * answered with, and a refusal is dropped once the thread shows the value it asked for after all.
   */
  observe(threadId: string, values: ThreadSettingValues, options: { quiet?: boolean } = {}): void {
    this.rendered.set(threadId, values)
    let changed = false
    for (const kind of KINDS) {
      const key = keyOf(threadId, kind)
      const entry = this.entries.get(key)
      if (entry && !entry.sending && entry.expected !== null && values[kind] === entry.expected) { this.drop(key, entry); changed = true }
    }
    const refusal = this.refusals.get(threadId)
    if (refusal && values[refusal.kind] === refusal.wanted) { this.refusals.delete(threadId); changed = true }
    if (changed && !options.quiet) this.emit(threadId)
  }

  /** Forget everything held for every thread; for tests. */
  clear(): void {
    for (const entry of this.entries.values()) this.hold(entry, null)
    const threads = new Set([...this.views.keys()])
    this.entries.clear(); this.refusals.clear(); this.rendered.clear()
    for (const threadId of threads) this.emit(threadId)
  }

  private async run(threadId: string, kind: ThreadSettingKind, entry: Entry, first: Press, send: SendThreadSettings): Promise<void> {
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
        if (reply === null || reply.error) {
          this.drop(key, entry)
          this.refusals.set(threadId, { kind, wanted: target.value, patch: target.patch, error: reply?.error ?? null })
          return
        }
        const thread = reply.host.threads.find(item => item.id === threadId)
        const expected = thread ? threadSettingValues(reply, thread)[kind] : null
        if (expected === null || this.rendered.get(threadId)?.[kind] === expected) { this.drop(key, entry); return }
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
    const pending: Partial<Record<ThreadSettingKind, PendingSetting>> = {}
    for (const kind of KINDS) {
      const entry = this.entries.get(keyOf(threadId, kind))
      if (entry) pending[kind] = { value: entry.desired.value, awaiting: entry.sending ? 'provider' : 'window' }
    }
    const refusal = this.refusals.get(threadId) ?? null
    const before = this.views.get(threadId)
    if (before && before.refusal === refusal && KINDS.every(kind => before.pending[kind]?.value === pending[kind]?.value && before.pending[kind]?.awaiting === pending[kind]?.awaiting)) return
    if (Object.keys(pending).length === 0 && refusal === null) this.views.delete(threadId)
    else this.views.set(threadId, { pending, refusal })
    for (const listener of [...this.listeners]) listener()
  }
}

const keyOf = (threadId: string, kind: ThreadSettingKind): string => `${threadId}\0${kind}`

export const threadSettingsStore = new ThreadSettingsStore()

/** This thread's pending settings and the last refusal, as the chips and the pane read them. */
export function useThreadSettings(threadId: string, store: ThreadSettingsStore = threadSettingsStore): ThreadSettingsView {
  return useSyncExternalStore(store.subscribe, () => store.view(threadId))
}
