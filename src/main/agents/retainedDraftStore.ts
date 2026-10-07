import { join } from 'node:path'
import { readFile, readdir, unlink } from 'node:fs/promises'
import { z } from 'zod'
import { agentThreadDraftSchema, type AgentThreadDraft } from '../../shared/agents'
import { AtomicJsonStore } from '../storage/atomicJsonStore'

const retainedDraftSchema = z.object({ hostId: z.uuid(), draft: agentThreadDraftSchema,
  questionsDigest: z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
  saved: z.boolean(), recovery: z.boolean(), editing: z.boolean().optional(), hostDraftId: z.uuid().optional() }).strict()
export type RetainedDraft = z.infer<typeof retainedDraftSchema>
const retainedDraftsSchema = z.array(retainedDraftSchema).max(512)
const owner = (hostId: string, threadId: string): string => JSON.stringify([hostId, threadId])

/** Latest full remote edits survive a connection replacement. No delivery command is stored or replayed. */
export class RetainedDraftStore {
  private readonly edits = new Map<string, RetainedDraft>()
  private readonly disk?: AtomicJsonStore<RetainedDraft[]>
  private loading: Promise<void> | undefined
  private dirty = false
  private writing: Promise<void> | undefined
  private readonly forgottenHosts = new Set<string>()
  constructor(private readonly options: { directory?: string; historyEnabled?: () => boolean; onRecovery?: () => void; onWriteFailure?: () => void } = {}) {
    if (options.directory) this.disk = new AtomicJsonStore(join(options.directory, 'remote-drafts.json'), retainedDraftsSchema.parse, () => [], undefined, undefined, options.onRecovery)
  }
  private get keepsHistory(): boolean { return this.options.historyEnabled?.() !== false }
  load(): Promise<void> {
    if (this.loading) return this.loading
    const task = (async () => {
      if (!this.disk) return
      if (!this.keepsHistory) { await this.clearHistory(); return }
      let saved: RetainedDraft[]
      try { saved = retainedDraftsSchema.parse(JSON.parse(await readFile(join(this.options.directory!, 'remote-drafts.json'), 'utf8'))) }
      catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') saved = []
        else {
          try { this.options.onRecovery?.() } catch { /* A notice cannot alter the unread original. */ }
          throw new Error('Saved remote drafts could not be read. Restore local storage access before connecting.', { cause: error })
        }
      }
      if (this.keepsHistory) for (const edit of saved) {
        const key = owner(edit.hostId, edit.draft.threadId)
        if (!this.forgottenHosts.has(edit.hostId) && !this.edits.has(key)) this.edits.set(key, { ...edit, recovery: !edit.saved || edit.recovery })
      }
      else await this.clearHistory()
    })()
    this.loading = task
    void task.catch(() => { if (this.loading === task) this.loading = undefined })
    return task
  }
  get(hostId: string, threadId: string): RetainedDraft | undefined {
    const edit = this.edits.get(owner(hostId, threadId))
    return edit && structuredClone(edit)
  }
  list(hostId: string): RetainedDraft[] {
    return structuredClone([...this.edits.values()].filter(edit => edit.hostId === hostId))
  }
  put(edit: RetainedDraft): void {
    const key = owner(edit.hostId, edit.draft.threadId)
    if (!this.edits.has(key) && this.edits.size >= 512) throw new Error('This computer has too many unsent remote drafts. Save or clear a draft before starting another.')
    this.edits.set(key, retainedDraftSchema.parse(structuredClone(edit)))
    this.changed()
  }
  saved(hostId: string, threadId: string, draftId: string, acknowledged: AgentThreadDraft): void {
    const edit = this.edits.get(owner(hostId, threadId))
    if (edit?.draft.draftId !== draftId) return
    edit.draft = { ...acknowledged, draftId: edit.draft.draftId }
    edit.saved = true; edit.recovery = false; edit.hostDraftId = acknowledged.draftId
    this.changed()
  }
  recover(hostId: string): void {
    for (const edit of this.edits.values()) if (edit.hostId === hostId && !edit.saved) edit.recovery = true
    this.changed()
  }
  remove(hostId: string, threadId: string, draftId?: string): void {
    const key = owner(hostId, threadId), edit = this.edits.get(key)
    if (!edit || draftId !== undefined && edit.draft.draftId !== draftId) return
    this.edits.delete(key); this.changed()
  }
  async forgetHost(hostId: string): Promise<void> {
    this.forgottenHosts.add(hostId)
    for (const [key, edit] of this.edits) if (edit.hostId === hostId) this.edits.delete(key)
    this.changed(); await this.close()
  }
  /** Turning history off removes disk copies; current window edits remain in memory. */
  async privacyChanged(): Promise<void> { this.changed(); await this.close() }
  private changed(): void {
    this.dirty = true
    // Starting writes immediately makes quit's drain own every admitted edit, including an off-wire batch.
    void this.flush().catch(() => undefined)
  }
  flush(): Promise<void> {
    if (this.writing) return this.writing
    const task = (async () => {
      await this.load()
      while (this.dirty) {
        this.dirty = false
        if (this.disk) {
          const snapshot = this.keepsHistory ? structuredClone([...this.edits.values()]) : []
          try {
            await this.disk.write(snapshot)
            if (!this.keepsHistory) await this.removeLeftovers()
          }
          catch (error) { this.dirty = true; this.reportWriteFailure(); throw error }
        }
      }
    })()
    this.writing = task
    void task.finally(() => { if (this.writing === task) this.writing = undefined }).catch(() => undefined)
    return task
  }
  close(): Promise<void> { return this.flush() }
  private reportWriteFailure(): void {
    try { this.options.onWriteFailure?.() } catch { /* A notice cannot discard a retryable edit. */ }
  }
  private async clearHistory(): Promise<void> {
    try { await this.disk!.write([]); await this.removeLeftovers() }
    catch (error) { this.reportWriteFailure(); throw error }
  }
  private async removeLeftovers(): Promise<void> {
    if (!this.options.directory) return
    for (const name of await readdir(this.options.directory)) {
      if (name.startsWith('remote-drafts.json.tmp-') || name.startsWith('remote-drafts.json.corrupt-')) {
        await unlink(join(this.options.directory, name)).catch(error => {
          if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error
        })
      }
    }
  }
}
