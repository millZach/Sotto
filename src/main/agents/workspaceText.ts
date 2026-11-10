import type { AgentHostSnapshot, AgentModel, AgentThread } from '../../shared/agents'
import { sameJsonText } from './sameSnapshot'
import { verifyingThreadChanges } from './threadChanges'

const CATALOG_PLACEHOLDER = 'sotto-catalog-placeholder-v1'
const THREADS_PLACEHOLDER = 'sotto-threads-placeholder-v1'

/** The text of each item of the compact array JSON.stringify made, without parsing it again. */
function jsonArrayItems(text: string): string[] {
  const items: string[] = []
  let depth = 0, start = 1, quoted = false
  for (let at = 1; at < text.length - 1; at++) {
    const code = text.charCodeAt(at)
    if (quoted) { if (code === 92) at++; else if (code === 34) quoted = false; continue }
    if (code === 34) quoted = true
    else if (code === 123 || code === 91) depth++
    else if (code === 125 || code === 93) depth--
    else if (code === 44 && depth === 0) { items.push(text.slice(start, at)); start = at + 1 }
  }
  if (text.length > 2) items.push(text.slice(start, text.length - 1))
  return items
}

/** Store a provider's shared permission modes once; a model with different modes keeps its own. */
function catalogModelsForSave(models: readonly AgentModel[]): AgentModel[] {
  const first = new Map<string, string>()
  return models.map(model => {
    if (model.providerModes === undefined) return model
    const key = model.providerId ?? model.provider
    const modes = JSON.stringify(model.providerModes)
    if (first.get(key) === modes) {
      const { providerModes, ...rest } = model
      void providerModes
      return rest
    }
    if (!first.has(key)) first.set(key, modes)
    return model
  })
}

interface ThreadText { readonly source: AgentThread; readonly history: boolean; readonly text: string }

/** The incremental workspace encoding and its invalidation; WorkspaceHost owns persistence and saved-state policy. */
export class WorkspaceText {
  private threads = new Map<string, ThreadText>()
  private readonly invalidated = new Set<string>()
  private all = true
  private catalog: { readonly models: readonly AgentModel[]; readonly text: string } | undefined

  invalidate(threadId: string): void { this.invalidated.add(threadId) }
  invalidateAll(): void { this.all = true }
  get allInvalidated(): boolean { return this.all }
  /** An unchanged provider read restores the mark it found, keeping any thread-specific marks. */
  restoreAllInvalidated(all: boolean): void { this.all = all }

  /** Carry text across an unchanged read only when both records encode identically, including field order. */
  retain(previous: readonly AgentThread[], threads: readonly AgentThread[]): void {
    for (let at = 0; at < threads.length; at++) {
      const thread = threads[at]!, old = previous[at]
      if (!old || old === thread || old.id !== thread.id) continue
      const held = this.threads.get(thread.id)
      if (held?.source === old && sameJsonText(old, thread)) this.threads.set(thread.id, { ...held, source: thread })
    }
  }

  /** Byte-for-byte whole-state JSON, reusing the text of unchanged threads and the certified model catalog. */
  serialize(input: {
    readonly state: { readonly snapshot: AgentHostSnapshot }
    readonly preservedDormantThreads: ReadonlyMap<string, AgentThread>
    readonly history: boolean
    readonly keepActivities: boolean
    readonly savedThread: (thread: AgentThread) => AgentThread
    readonly scrubThread: (thread: AgentThread) => void
  }): string {
    const { state, preservedDormantThreads, history, keepActivities, savedThread, scrubThread } = input
    const all = this.all || keepActivities
    const kept = this.threads, texts = new Map<string, ThreadText>()
    const parts: string[] = []
    const fresh: AgentThread[] = [], placed: { readonly at: number; readonly id: string; readonly source: AgentThread }[] = []
    for (const thread of state.snapshot.threads) {
      const source = preservedDormantThreads.get(thread.id) ?? thread
      const held = all || this.invalidated.has(thread.id) ? undefined : kept.get(thread.id)
      if (held && held.source === source && held.history === history) {
        // A list that names a thread twice keeps the first's text, and the second is serialized every time.
        if (!texts.has(thread.id)) texts.set(thread.id, held)
        parts.push(held.text)
        continue
      }
      const saved = savedThread(thread)
      scrubThread(saved)
      fresh.push(saved)
      placed.push({ at: parts.length, id: thread.id, source })
      parts.push('')
    }
    const outline = { ...state, snapshot: { ...state.snapshot, models: CATALOG_PLACEHOLDER, threads: THREADS_PLACEHOLDER } }
    const [organization, ...made] = jsonArrayItems(JSON.stringify([outline, ...fresh]))
    for (let index = 0; index < placed.length; index++) {
      const { at, id, source } = placed[index]!, text = made[index]!
      parts[at] = text
      if (!texts.has(id)) texts.set(id, { source, history, text })
    }
    this.threads = keepActivities ? new Map() : texts
    this.invalidated.clear()
    this.all = false
    const text = organization!
      .replace(`"models":"${CATALOG_PLACEHOLDER}"`, () => `"models":${this.catalogText(state.snapshot.models)}`)
      .replace(`"threads":"${THREADS_PLACEHOLDER}"`, () => `"threads":[${parts.join(',')}]`)
    if (verifyingThreadChanges()) {
      const whole = { ...state, snapshot: { ...state.snapshot, models: CATALOG_PLACEHOLDER,
        threads: state.snapshot.threads.map(thread => { const saved = savedThread(thread); scrubThread(saved); return saved }) } }
      if (JSON.stringify(whole).replace(`"models":"${CATALOG_PLACEHOLDER}"`, () => `"models":${this.catalogText(state.snapshot.models)}`) !== text) throw new Error('The saved workspace text differs from the whole saved state: a thread changed without being marked.')
    }
    return text
  }

  private catalogText(models: readonly AgentModel[]): string {
    if (this.catalog?.models === models) return this.catalog.text
    const text = JSON.stringify(catalogModelsForSave(models))
    this.catalog = { models, text }
    return text
  }
}
