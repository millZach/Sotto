import { join } from 'node:path'
import { readFile, readdir, unlink } from 'node:fs/promises'
import { z } from 'zod'
import { agentThreadDraftSchema, type AgentThreadDraft } from '../../shared/agents'
import { AtomicJsonStore } from '../storage/atomicJsonStore'

const retainedDraftSchema = z.object({ hostId: z.uuid(), registrationId: z.uuid().optional(), draft: agentThreadDraftSchema,
  questionsDigest: z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
  saved: z.boolean(), recovery: z.boolean(), editing: z.boolean().optional(), hostDraftId: z.uuid().optional(),
  baseDraftId: z.uuid().nullable().optional(),
  sendAttempt: z.object({ commandId: z.string().min(1).max(512), draftId: z.uuid(), requestId: z.string().nullable(),
    packetDigest: z.string().regex(/^[a-f0-9]{64}$/u).optional() }).strict().optional() }).strict()
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
  private readonly retiredDiskHosts = new Set<string>()
  private savedHosts: Map<string, string> | undefined
  private loadFailure: unknown
  constructor(private readonly options: { directory?: string; historyEnabled?: () => boolean; onRecovery?: () => void; onWriteFailure?: () => void } = {}) {
    if (options.directory) this.disk = new AtomicJsonStore(join(options.directory, 'remote-drafts.json'), retainedDraftsSchema.parse, () => [], undefined, undefined, options.onRecovery)
  }
  private get keepsHistory(): boolean { return this.options.historyEnabled?.() !== false }
  /** History-on unread files stay untouched; history off uses only this window's memory edits. */
  get storageAvailable(): boolean { return !this.keepsHistory || this.loadFailure === undefined }
  get requiresDurableWrites(): boolean { return this.keepsHistory && this.disk !== undefined }
  load(): Promise<void> {
    if (this.loading) return this.loading
    const task = (async () => {
      if (!this.disk) return
      if (!this.keepsHistory) {
        try { await this.clearHistory(); this.loadFailure = undefined }
        catch (error) { this.loadFailure = error }
        return
      }
      let saved: RetainedDraft[]
      try { saved = retainedDraftsSchema.parse(JSON.parse(await readFile(join(this.options.directory!, 'remote-drafts.json'), 'utf8'))) }
      catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') saved = []
        else {
          try { this.options.onRecovery?.() } catch { /* A notice cannot alter the unread original. */ }
          this.loadFailure = error
          return
        }
      }
      let removed = false
      if (this.keepsHistory) for (const edit of saved) {
        const key = owner(edit.hostId, edit.draft.threadId)
        if (!this.acceptsEdit(edit) || !this.savedHosts && this.retiredDiskHosts.has(edit.hostId)) { removed = true; continue }
        if (!this.edits.has(key)) this.edits.set(key, { ...edit, recovery: !edit.saved || edit.recovery })
      }
      else {
        try { await this.clearHistory() }
        catch (error) { this.loadFailure = error; return }
      }
      this.loadFailure = undefined
      if (removed) this.changed()
    })()
    this.loading = task
    void task.finally(() => { if (this.loadFailure !== undefined && this.loading === task) this.loading = undefined }).catch(() => undefined)
    return task
  }
  /** Saved host identities decide which disk copies remain eligible after a failed optional cleanup. */
  setSavedHosts(hosts: Array<{ hostId: string; registrationId: string }>): void {
    this.savedHosts = new Map(hosts.map(host => [host.hostId, host.registrationId]))
    let removed = false
    for (const [key, edit] of this.edits) if (!this.acceptsEdit(edit)) { this.edits.delete(key); removed = true }
    if (removed) this.changed()
  }
  /** Only a completed Add admits a new host; canceled Forget never changes its admission. */
  allowHost(hostId: string, registrationId?: string): void {
    if (this.savedHosts && registrationId === undefined) return
    if (this.forgottenHosts.has(hostId) || this.savedHosts && !this.savedHosts.has(hostId)) this.retiredDiskHosts.add(hostId)
    if (registrationId !== undefined) this.savedHosts?.set(hostId, registrationId)
    this.forgottenHosts.delete(hostId)
    let removed = false
    for (const [key, edit] of this.edits) if (edit.hostId === hostId && !this.acceptsEdit(edit)) { this.edits.delete(key); removed = true }
    if (removed) this.changed()
  }
  registrationForHost(hostId: string): string | undefined { return this.savedHosts?.get(hostId) }
  private acceptsHost(hostId: string): boolean { return !this.forgottenHosts.has(hostId) && (!this.savedHosts || this.savedHosts.has(hostId)) }
  private acceptsEdit(edit: RetainedDraft): boolean { return this.acceptsHost(edit.hostId) && (!this.savedHosts || edit.registrationId === this.savedHosts.get(edit.hostId)) }
  get(hostId: string, threadId: string): RetainedDraft | undefined {
    const edit = this.edits.get(owner(hostId, threadId))
    return edit && this.acceptsEdit(edit) ? structuredClone(edit) : undefined
  }
  list(hostId: string): RetainedDraft[] {
    return structuredClone([...this.edits.values()].filter(edit => edit.hostId === hostId && this.acceptsEdit(edit)))
  }
  put(edit: RetainedDraft): void {
    if (!this.acceptsEdit(edit)) return
    const key = owner(edit.hostId, edit.draft.threadId)
    if (!this.edits.has(key) && this.edits.size >= 512) throw new Error('This computer has too many unsent remote drafts. Save or clear a draft before starting another.')
    this.edits.set(key, retainedDraftSchema.parse(structuredClone(edit)))
    this.changed()
  }
  saved(hostId: string, threadId: string, draftId: string, acknowledged: AgentThreadDraft): void {
    const edit = this.edits.get(owner(hostId, threadId))
    if (edit?.draft.draftId !== draftId) return
    edit.draft = { ...acknowledged, draftId: edit.draft.draftId }
    edit.saved = true; edit.recovery = false; edit.hostDraftId = acknowledged.draftId; edit.baseDraftId = acknowledged.draftId
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
    this.retiredDiskHosts.add(hostId)
    this.savedHosts?.delete(hostId)
    for (const [key, edit] of this.edits) if (edit.hostId === hostId) this.edits.delete(key)
    this.changed(); await this.close().catch(() => undefined)
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
      if (this.loadFailure !== undefined && this.keepsHistory) {
        throw new Error('Saved remote drafts could not be read. The original file was preserved. Repair local storage before saving draft text.', { cause: this.loadFailure })
      }
      while (this.dirty) {
        this.dirty = false
        if (this.disk) {
          const snapshot = this.keepsHistory ? structuredClone([...this.edits.values()]) : []
          try {
            await this.disk.write(snapshot)
            if (!this.keepsHistory) await this.removeLeftovers()
          }
          catch (error) {
            this.dirty = true; this.reportWriteFailure()
            if (this.keepsHistory) throw error
            return
          }
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
