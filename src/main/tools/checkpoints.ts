import { constants } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { copyFile, lstat, mkdir, open, readFile, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import { checkpointInspectionSchema, checkpointRequestSchema, checkpointRevertSchema, type Checkpoint } from '../../shared/checkpoints'
import { fileRelativePathSchema, type FileWorkspace } from '../../shared/files'
import { toolListRequestSchema } from '../../shared/tools'
import { AtomicJsonStore } from '../storage/atomicJsonStore'
import { ToolOperations, fail, parse, workspace } from './common'
import { checkoutIdentity } from '../agents/threadWorktrees'
import { CheckpointCapture } from './checkpointCapture'
import type { CheckpointDependencies, CheckpointThread } from './checkpointTypes'

const fileSchema = z.object({ hash: z.string().regex(/^[a-f0-9]{64}$/), mode: z.number() }).strict()
const snapshotSchema = z.object({ files: z.record(fileRelativePathSchema, fileSchema), index: z.string(), head: z.string() }).strict()
const recordSchema = z.object({ id: z.string().uuid(), threadId: z.string(), workspaceId: z.string(), cwd: z.string(), checkout: z.string().optional(), providerId: z.string(), bindingId: z.string(), createdAt: z.string().datetime(),
  beforeUsers: z.array(z.string()), afterUsers: z.array(z.string()).optional(), before: snapshotSchema, after: snapshotSchema.optional(),
  status: z.enum(['capturing', 'ready', 'reverting', 'uncertain', 'reverted', 'unavailable']), reason: z.string().optional(),
}).strict()
/** `generation` names this write of the file; journal lines written against another one are already in it, or stale. */
const storageSchema = z.object({ version: z.literal(1), generation: z.string().uuid().optional(), records: z.array(recordSchema) }).strict()
const journalLineSchema = z.object({ generation: z.string().uuid(), record: z.unknown() }).strict()
/** The journal is folded into `checkpoints.json` once it outgrows the file, and never before this much. */
const JOURNAL_FOLD_BYTES = 64 * 1024

/** Recover complete objects even when a later JSON record was cut short. */
function readableRecords(text: string): unknown[] {
  const records: unknown[] = [], starts: number[] = []
  let quoted = false, escaped = false
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; continue }
    if (char === '"') { quoted = true; continue }
    if (char === '{') starts.push(i)
    if (char === '}' && starts.length) {
      const start = starts.pop()!
      try {
        const record = recordSchema.safeParse(JSON.parse(text.slice(start, i + 1)))
        if (record.success) records.push(record.data)
      } catch { /* Keep scanning other complete records, even inside an unclosed object. */ }
    }
  }
  return records
}

type Record = z.infer<typeof recordSchema>
type Snapshot = z.infer<typeof snapshotSchema>
const equal = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
const digest = (data: Buffer): string => createHash('sha256').update(data).digest('hex')
/** A record's bytes inside the stored array, where each is indented four spaces and followed by a separator. */
const storedBytes = (record: Record): number => Buffer.byteLength(JSON.stringify(record, null, 2).split('\n').map(line => `    ${line}`).join('\n')) + 2

/** Durable per-turn file associations. Native effects are never retried after an uncertain delivery. */
export class CheckpointService extends ToolOperations {
  private readonly store: AtomicJsonStore<z.infer<typeof storageSchema>>
  private readonly records = new Map<string, Record>()
  private initialized = false
  private recoveryNotice: string | undefined
  private recoveryBackup: string | undefined
  private readonly blobSizes = new Map<string, number>()
  private loaded: Promise<void> | undefined
  private tail: Promise<unknown> = Promise.resolve()
  private readonly maintenance: ReturnType<typeof setInterval>
  private readonly locks = new Set<string>()
  private readonly capture: CheckpointCapture
  /** The generation `checkpoints.json` was last written with; journal lines carry it. */
  private generation: string | undefined
  /** Each record's bytes as `checkpoints.json` stores it, kept from when it was last written. */
  private readonly recordBytes = new Map<string, number>()
  private storedFileBytes = 0
  private journalBytes = 0
  private readonly journal: string
  constructor(private readonly dependencies: CheckpointDependencies) {
    super()
    this.store = new AtomicJsonStore(join(dependencies.directory, 'checkpoints.json'), storageSchema.parse, () => ({ version: 1, records: [] }))
    this.journal = join(dependencies.directory, 'checkpoints.journal')
    this.capture = new CheckpointCapture({ blobDirectory: join(dependencies.directory, 'blobs'), blobSizes: this.blobSizes, git: (cwd, args) => this.git(cwd, args) })
    this.maintenance = setInterval(() => { void this.privacyChanged().catch(() => this.dependencies.report?.('Expired checkpoints could not be removed. Check access to local storage.')) }, 60 * 60 * 1000)
    this.maintenance.unref()
  }
  private load(): Promise<void> {
    return this.loaded ??= readFile(join(this.dependencies.directory, 'checkpoints.json'), 'utf8').then(async text => {
      let candidates: unknown[], damaged = false, generation: string | undefined
      try {
        const value: unknown = JSON.parse(text)
        if (Array.isArray(value)) candidates = value
        else {
          const parsed = storageSchema.safeParse(value)
          if (parsed.success) { candidates = parsed.data.records; generation = parsed.data.generation }
          else {
            damaged = true; candidates = typeof value === 'object' && value !== null && 'records' in value && Array.isArray(value.records) ? value.records : []
            if (typeof value === 'object' && value !== null && 'generation' in value && typeof value.generation === 'string') generation = value.generation
          }
        }
      } catch {
        damaged = true
        candidates = readableRecords(text)
      }
      const records: Record[] = [], ids = new Set<string>()
      for (const candidate of candidates) {
        const parsed = recordSchema.safeParse(candidate)
        if (parsed.success && !ids.has(parsed.data.id)) { records.push(parsed.data); ids.add(parsed.data.id) }
        else damaged = true
      }
      // Sends since the file was last written are in the journal, newest last.
      const journal = await this.readJournal(generation)
      for (const record of journal.records) {
        const at = records.findIndex(item => item.id === record.id)
        if (at < 0) records.push(record); else records[at] = record
      }
      const source = join(this.dependencies.directory, 'checkpoints.json')
      if (damaged) {
        const backup = `${source}.corrupt-${randomUUID()}`
        try { await copyFile(source, backup, constants.COPYFILE_EXCL) }
        catch { throw new Error(`Checkpoint storage at ${source} could not be repaired. No checkpoints were discarded. Restore access and try again; the backup could not be saved at ${backup}.`) }
        // Without the file's generation the journal cannot be matched to it, so it is kept beside the backup.
        const unmatched = journal.text && generation === undefined ? `${source}.corrupt-${randomUUID()}` : undefined
        if (unmatched) {
          try { await writeFile(unmatched, journal.text, { flag: 'wx', mode: 0o600 }) }
          catch { throw new Error(`Checkpoint storage at ${this.journal} could not be repaired. No checkpoints were discarded. Restore access and try again; the backup could not be saved at ${unmatched}.`) }
        }
        try { await this.writeStore(records) }
        catch { throw new Error(`Checkpoint storage at ${source} could not be repaired. The original file is backed up at ${backup}. Restore access to local storage and try again.`) }
        this.setAside(backup)
      } else if (journal.text) {
        const backup = journal.damaged ? `${source}.corrupt-${randomUUID()}` : undefined
        if (backup) {
          try { await writeFile(backup, journal.text, { flag: 'wx', mode: 0o600 }) }
          catch { throw new Error(`Checkpoint storage at ${this.journal} could not be repaired. No checkpoints were discarded. Restore access and try again; the backup could not be saved at ${backup}.`) }
        }
        try { await this.writeStore(records) }
        catch { throw new Error(`Checkpoint storage at ${source} could not be updated from ${this.journal}. No checkpoints were discarded. Restore access to local storage and try again.`) }
        if (backup) this.setAside(backup)
      } else this.generation = generation
      for (const record of records) {
        if (record.status === 'capturing') {
          record.status = 'unavailable'
          record.reason = 'Checkpoint capture was interrupted before its completed file snapshot was saved. Later edits cannot be safely attributed to that turn.'
        }
        this.records.set(record.id, record)
      }
    }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { this.loaded = undefined; if (error instanceof Error && error.message.startsWith('Checkpoint storage at ')) throw error; throw new Error(`Checkpoint storage at ${join(this.dependencies.directory, 'checkpoints.json')} could not be read. No checkpoints were discarded. Restore access to the file and try again.`, { cause: error }) } })
  }
  /** Read the journal's complete lines written against `generation`. A line cut short at the end is an append that never finished, before its send went. */
  private async readJournal(generation: string | undefined): Promise<{ text: string; records: Record[]; damaged: boolean }> {
    const text = await readFile(this.journal, 'utf8').catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error })
    const records: Record[] = [], lines = text.split('\n')
    let damaged = false
    lines.pop()
    for (const line of lines) {
      if (!line) continue
      let entry: z.infer<typeof journalLineSchema>
      try { const parsed = journalLineSchema.safeParse(JSON.parse(line)); if (!parsed.success) { damaged = true; continue } entry = parsed.data }
      catch { damaged = true; continue }
      if (entry.generation !== generation) continue
      const record = recordSchema.safeParse(entry.record)
      if (record.success) records.push(record.data); else damaged = true
    }
    return { text, records, damaged }
  }
  private setAside(backup: string): void {
    this.recoveryBackup = backup
    this.recoveryNotice = `Sotto set aside a checkpoint file it could not read as ${basename(backup)} and kept the rest.`
    try { this.dependencies.report?.(this.recoveryNotice) } catch { /* Reporting cannot prevent recovery. */ }
  }
  /** Write every record to `checkpoints.json` under a new generation, which retires the journal's lines. */
  private async writeStore(records: Record[]): Promise<void> {
    const generation = randomUUID()
    await this.store.write({ version: 1, generation, records })
    this.generation = generation
    this.journalBytes = 0
    await this.removeBackup(this.journal)
  }
  /** Add records to the journal and wait until they are on disk. */
  private async append(records: readonly Record[]): Promise<void> {
    const text = records.map(record => `${JSON.stringify({ generation: this.generation, record })}\n`).join('')
    const handle = await open(this.journal, 'a', 0o600)
    try { await handle.writeFile(text, 'utf8'); await handle.sync() }
    finally { await handle.close() }
    this.journalBytes += Buffer.byteLength(text)
  }
  initialize(): Promise<void> { if (this.initialized) return Promise.resolve(); return this.serial(async () => { await this.load(); if (!this.initialized) { await this.save(); this.initialized = true } }) }
  private async refreshRecoveryNotice(): Promise<void> {
    if (!this.recoveryBackup) return
    const exists = await lstat(this.recoveryBackup).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; this.dependencies.report?.('checkpoint-cleanup-failed'); return true })
    if (!exists) { this.recoveryBackup = undefined; this.recoveryNotice = undefined }
  }
  private unresolved(record: Record): boolean { return record.status === 'reverting' || record.status === 'uncertain' }
  private async removeBackup(path: string): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try { await unlink(path); if (path === this.recoveryBackup) { this.recoveryBackup = undefined; this.recoveryNotice = undefined } return }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ENOENT') return
        if ((code === 'EBUSY' || code === 'EPERM') && attempt < 2) { await delay(25); continue }
        this.dependencies.report?.('checkpoint-cleanup-failed')
        return
      }
    }
  }
  /**
   * Save the records, then remove file backups and expired recovery copies nothing refers to. `changed` names the
   * records a send added or updated since the last save; when nothing was removed they are appended to the journal
   * instead of rewriting `checkpoints.json`, which every other save does.
   */
  private async save(changed?: readonly Record[]): Promise<void> {
    const cutoff = (this.dependencies.now?.() ?? Date.now()) - 30 * 24 * 60 * 60 * 1000
    let removed = false
    for (const record of this.records.values()) if (!this.unresolved(record) && (this.dependencies.historyEnabled?.() === false || Date.parse(record.createdAt) < cutoff)) { this.records.delete(record.id); removed = true }
    const directory = join(this.dependencies.directory, 'blobs')
    const blobInfo = await lstat(directory).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.dependencies.report?.('checkpoint-cleanup-failed'); return null })
    const safeDirectory = blobInfo?.isDirectory() && !blobInfo.isSymbolicLink()
    if (blobInfo && !safeDirectory) this.dependencies.report?.('checkpoint-cleanup-unsafe-directory')
    const names = safeDirectory ? (await readdir(directory).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.dependencies.report?.('checkpoint-cleanup-failed'); return [] })).filter(name => /^[a-f0-9]{64}$/.test(name)) : []
    const regular = new Set<string>()
    for (const name of names) {
      if (this.blobSizes.has(name)) { regular.add(name); continue }
      const info = await lstat(join(directory, name)).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.dependencies.report?.('checkpoint-cleanup-failed'); return null })
      if (info?.isFile() && !info.isSymbolicLink()) { regular.add(name); if (!this.blobSizes.has(name)) this.blobSizes.set(name, info.size) }
    }
    const hashes = (record: Record): Set<string> => new Set([record.before, record.after].flatMap(snapshot => snapshot ? Object.values(snapshot.files).map(file => file.hash) : []))
    const counts = new Map<string, number>()
    // The stored file's size, from each record's own: a journal save measures only the records it writes.
    if (changed) for (const record of changed) this.recordBytes.set(record.id, storedBytes(record))
    let stored = Buffer.byteLength(JSON.stringify({ version: 1, generation: randomUUID(), records: [] }, null, 2) + '\n') + (this.records.size ? 2 : 0)
    for (const record of this.records.values()) {
      const bytes = (changed ? this.recordBytes.get(record.id) : undefined) ?? storedBytes(record)
      this.recordBytes.set(record.id, bytes); stored += bytes
    }
    let total = stored + (changed ? this.journalBytes : 0)
    for (const record of this.records.values()) {
      for (const hash of hashes(record)) { if (!counts.has(hash)) total += this.blobSizes.get(hash) ?? 0; counts.set(hash, (counts.get(hash) ?? 0) + 1) }
    }
    const backupNames = (await readdir(this.dependencies.directory).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.dependencies.report?.('checkpoint-cleanup-failed'); return [] })).filter(name => name.startsWith('checkpoints.json.corrupt-'))
    const backups = new Map<string, { size: number; createdAt: number }>()
    const removedBackups = new Set<string>()
    for (const name of backupNames) {
      const info = await lstat(join(this.dependencies.directory, name)).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.dependencies.report?.('checkpoint-cleanup-failed'); return null })
      if (!info?.isFile() || info.isSymbolicLink()) continue
      if (this.dependencies.historyEnabled?.() === false || info.mtimeMs < cutoff) removedBackups.add(name)
      else { backups.set(name, { size: info.size, createdAt: info.mtimeMs }); total += info.size }
    }
    const oldest = [
      ...[...this.records.values()].filter(record => !this.unresolved(record)).map(record => ({ createdAt: Date.parse(record.createdAt), recordId: record.id, backup: undefined })),
      ...[...backups].map(([name, info]) => ({ createdAt: info.createdAt, recordId: undefined, backup: name })),
    ].sort((a, b) => a.createdAt - b.createdAt)
    for (const item of oldest) {
      if (total <= (this.dependencies.maxBytes ?? 500_000_000)) break
      if (item.recordId) {
        const record = this.records.get(item.recordId)!
        this.records.delete(item.recordId); removed = true
        const bytes = this.recordBytes.get(item.recordId) ?? 0
        total -= bytes; stored -= bytes
        if (!this.records.size) { total -= 2; stored -= 2 }
        for (const hash of hashes(record)) {
          const remaining = counts.get(hash)! - 1
          if (remaining) counts.set(hash, remaining)
          else { counts.delete(hash); total -= this.blobSizes.get(hash) ?? 0 }
        }
      }
      if (item.backup) { total -= backups.get(item.backup)!.size; backups.delete(item.backup); removedBackups.add(item.backup) }
    }
    for (const id of this.recordBytes.keys()) if (!this.records.has(id)) this.recordBytes.delete(id)
    // Commit references before deleting any file backups. A removal cannot be journaled, and a journal that
    // has outgrown the file is folded into it.
    if (!changed || removed || !this.generation || this.journalBytes > Math.max(JOURNAL_FOLD_BYTES, this.storedFileBytes)) {
      await this.writeStore([...this.records.values()])
      this.storedFileBytes = stored
    } else await this.append(changed.filter(record => this.records.has(record.id)))
    for (const name of regular) if (!counts.has(name)) {
      const info = await lstat(join(directory, name)).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.dependencies.report?.('checkpoint-cleanup-failed'); return null })
      if (info?.isFile() && !info.isSymbolicLink()) await this.removeBackup(join(directory, name))
      this.blobSizes.delete(name)
    }
    for (const name of removedBackups) await this.removeBackup(join(this.dependencies.directory, name))
    await this.refreshRecoveryNotice()
  }
  async forgetThread(threadId: string): Promise<void> { return this.serial(async () => {
    await this.load()
    for (const record of this.records.values()) if (record.threadId === threadId && !this.unresolved(record)) this.records.delete(record.id)
    await this.save()
    // A recovery copy must not retain a forgotten thread's records either. Match the
    // identifier field without requiring the rest of a damaged document to parse.
    for (const name of (await readdir(this.dependencies.directory)).filter(name => name.startsWith('checkpoints.json.corrupt-'))) {
      const path = join(this.dependencies.directory, name), text = await readFile(path, 'utf8')
      const mentionsThread = [...text.matchAll(/"threadId"\s*:\s*("(?:[^"\\]|\\.)*")/g)].some(match => {
        try { return JSON.parse(match[1]!) === threadId } catch { return false }
      })
      if (mentionsThread) await this.removeBackup(path)
    }
  }) }
  async privacyChanged(): Promise<void> { return this.serial(async () => { await this.load(); this.forgetFoldersWithoutHistory(); await this.save() }) }
  /** With Keep local history off, nothing about a working folder is kept either: its remembered files and verdict. */
  private forgetFoldersWithoutHistory(): boolean {
    if (this.dependencies.historyEnabled?.() !== false) return false
    this.capture.forget()
    return true
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.tail.then(operation, operation)
    this.tail = next.catch(() => undefined)
    return next
  }
  isBlocked(threadId: string): boolean {
    const records = [...this.records.values()]
    const cwd = records.find(record => record.threadId === threadId)?.cwd
    return records.some(record => (record.threadId === threadId || cwd !== undefined && record.cwd === cwd) && ['reverting', 'uncertain'].includes(record.status)) || this.locks.has(threadId)
  }
  private async sharesCheckout(record: Record, checkout: string): Promise<boolean> {
    if (record.checkout) return record.checkout === checkout
    // Older records predate checkout identity. An unavailable unrelated folder must not block every project.
    try { return await checkoutIdentity(record.cwd) === checkout }
    catch {
      const path = relative(checkout, record.cwd)
      return !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`)
    }
  }
  async isWorkspaceBlocked(threadId: string, destinationFolder?: string): Promise<boolean> {
    await this.load()
    if (this.isBlocked(threadId)) return true
    const pending = [...this.records.values()].filter(record => ['reverting', 'uncertain'].includes(record.status) || this.locks.has(record.threadId))
    if (!pending.length) return false
    const folder = destinationFolder ?? (await workspace(this.dependencies.files, threadId)).workingDirectory
    const checkout = await checkoutIdentity(folder)
    return (await Promise.all(pending.map(record => this.sharesCheckout(record, checkout)))).some(Boolean)
  }
  private git(cwd: string, args: string[]): Promise<string> {
    const env = { ...process.env }
    for (const key of Object.keys(env)) if (/^GIT_/i.test(key)) delete env[key]
    return new Promise((done, reject) => execFile('git', ['--no-optional-locks', '--literal-pathspecs', '-c', 'core.fsmonitor=false', ...args], { cwd, env, windowsHide: true, encoding: 'utf8', timeout: 15000, maxBuffer: 8 * 1024 * 1024 }, (error, output) => error ? reject(error) : done(output)))
  }
  private async safe(cwd: string, path: string): Promise<string> {
    parse(fileRelativePathSchema.refine(value => value.length > 0), path)
    const root = await realpath(cwd), absolute = resolve(root, path)
    const inside = (candidate: string): boolean => { const rel = relative(root, candidate); return rel === '' || !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`) }
    if (!inside(absolute)) return fail('blocked', 'A checkpoint path is outside the working folder.')
    let component = root
    for (const part of relative(root, absolute).split(sep)) {
      component = join(component, part)
      const info = await lstat(component).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error })
      if (!info) break
      if (info.isSymbolicLink()) return fail('blocked', 'Checkpoint paths cannot follow symbolic links or directory junctions.')
    }
    let candidate = absolute
    for (;;) {
      try {
        const info = await lstat(candidate)
        if (info.isSymbolicLink() || !inside(await realpath(candidate))) return fail('blocked', 'Checkpoint paths cannot follow symbolic links or directory junctions.')
        return absolute
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        if (candidate === root) throw error
        candidate = dirname(candidate)
      }
    }
  }
  async beforeTurn(threadId: string): Promise<void> {
    await this.afterTurn(threadId)
    return this.serial(async () => {
    await this.load()
    if (await this.isWorkspaceBlocked(threadId)) return fail('blocked', 'Resolve the interrupted checkpoint revert before sending more work.')
    if (this.forgetFoldersWithoutHistory()) { await this.save(); return }
    const thread = await this.dependencies.resolveThread(threadId, { historyOnly: true })
    if (!thread) return
    const pending = [...this.records.values()].find(record => record.threadId === threadId && record.status === 'capturing')
    if (pending) {
      if (!equal(pending.beforeUsers, thread.userMessageIds) || thread.running) return
      this.records.delete(pending.id)
    }
    const owner = await workspace(this.dependencies.files, threadId)
    const canonical = await realpath(owner.workingDirectory)
    const checkout = await this.capture.checkout(canonical)
    const candidates = [...this.records.values()].filter(record => record.threadId !== threadId && record.status === 'capturing')
    const sameCheckout = await Promise.all(candidates.map(record => this.sharesCheckout(record, checkout)))
    const overlapping = candidates.filter((_record, index) => sameCheckout[index])
    const overlapReason = overlapping.length ? 'Other thread work overlapped in this shared working copy. Its files cannot be safely attributed to this turn.' : undefined
    for (const other of overlapping) other.reason = overlapReason
    let before: Snapshot = { files: {}, index: '', head: '' }
    // A folder that could not be captured last time, and has not visibly changed since, is not walked again.
    let reason = await this.capture.heldVerdict(canonical)
    if (reason === undefined) {
      const release = await this.dependencies.acquireRead?.(threadId)
      try { before = await this.capture.snapshot(canonical, { reuse: true }) }
      catch (error) { reason = error instanceof Error ? error.message : 'File checkpoint capture was unavailable.' }
      finally { release?.() }
    }
    const record: Record = { id: randomUUID(), threadId, workspaceId: owner.workspaceId, cwd: canonical, checkout, providerId: thread.providerId, bindingId: thread.bindingId, beforeUsers: [...thread.userMessageIds], before, status: 'capturing', createdAt: new Date(this.dependencies.now?.() ?? Date.now()).toISOString() }
    if (overlapReason) record.reason = overlapReason
    if (reason) { record.status = 'unavailable'; record.reason = reason.slice(0, 2000) }
    this.records.set(record.id, record)
    await this.save(pending ? undefined : [record, ...overlapping])
  }) }
  async afterTurn(threadId: string): Promise<void> { return this.serial(async () => {
    await this.load()
    if (this.forgetFoldersWithoutHistory()) { await this.save(); return }
    const record = [...this.records.values()].find(record => record.threadId === threadId && record.status === 'capturing')
    if (!record) return
    const thread = await this.dependencies.resolveThread(threadId, { historyOnly: true })
    if (!thread || (thread.running ?? thread.busy) !== false) return
    if (!this.matches(record, thread) || !equal(thread.userMessageIds.slice(0, record.beforeUsers.length), record.beforeUsers)) { record.status = 'unavailable'; record.reason = 'The native conversation binding changed during this turn.'; await this.save(); return }
    if (thread.userMessageIds.length === record.beforeUsers.length) return
    await workspace(this.dependencies.files, threadId, record.workspaceId)
    const release = await this.dependencies.acquireRead?.(threadId)
    try { record.after = await this.capture.snapshot(record.cwd, { reuse: true }) }
    catch (error) { record.status = 'unavailable'; record.reason = error instanceof Error ? error.message.slice(0, 2000) : 'Completed file snapshot was unavailable.'; await this.save(); return }
    finally { release?.() }
    record.afterUsers = [...thread.userMessageIds]
    record.status = record.reason ? 'unavailable' : 'ready'
    if (record.before.index !== record.after.index || record.before.head !== record.after.head) { record.status = 'unavailable'; record.reason = 'This turn changed Git history or staging. Review and restore it with Git.' }
    await this.save()
  }) }
  private matches(record: Record, thread: CheckpointThread): boolean { return record.threadId === thread.threadId && record.providerId === thread.providerId && record.bindingId === thread.bindingId }
  private changes(record: Record): Checkpoint['files'] {
    if (!record.after) return []
    return [...new Set([...Object.keys(record.before.files), ...Object.keys(record.after.files)])].sort().filter(path => !equal(record.before.files[path], record.after!.files[path]))
      .map(path => ({ path, change: !record.before.files[path] ? 'added' : !record.after!.files[path] ? 'deleted' : 'modified' }))
  }
  private public(record: Record, thread: CheckpointThread | null): Checkpoint {
    const supported = !!thread?.rollbackSupported && this.matches(record, thread)
    const reason = record.reason ?? (!supported ? thread?.unsupportedReason ?? 'This provider does not expose matching native conversation rollback.' : undefined)
    return { id: record.id, threadId: record.threadId, createdAt: record.createdAt, status: record.status === 'capturing' ? 'unavailable' : record.status, files: this.changes(record), supported, ...(reason ? { reason } : {}) }
  }
  checkpoints(payload: unknown) { return this.run(async () => {
    const request = parse(toolListRequestSchema, payload)
    await this.afterTurn(request.threadId)
    await this.refreshRecoveryNotice()
    const owner = await workspace(this.dependencies.files, request.threadId, request.workspaceId)
    const thread = await this.dependencies.resolveThread(request.threadId)
    return { checkpoints: [...this.records.values()].filter(record => record.threadId === request.threadId && record.workspaceId === owner.workspaceId && record.status !== 'capturing').reverse().map(record => this.public(record, thread)), supported: thread?.rollbackSupported ?? false, ...((this.recoveryNotice || !thread?.rollbackSupported) ? { reason: [this.recoveryNotice, !thread?.rollbackSupported ? thread?.unsupportedReason ?? 'Native conversation rollback is unavailable for this provider.' : undefined].filter(Boolean).join(' ') } : {}) }
  }) }
  private async requested(payload: unknown): Promise<{ record: Record; thread: CheckpointThread; owner: FileWorkspace }> {
    const request = parse(checkpointRequestSchema, payload)
    await this.load()
    const owner = await workspace(this.dependencies.files, request.threadId, request.workspaceId)
    const record = this.records.get(request.checkpointId), thread = await this.dependencies.resolveThread(request.threadId)
    if (!record || !thread || record.workspaceId !== owner.workspaceId || !this.matches(record, thread)) return fail('workspace-changed', 'This checkpoint no longer matches the selected native thread and working copy.')
    return { record, thread, owner }
  }
  inspectCheckpoint(payload: unknown) { return this.run(async () => {
    const { record, thread } = await this.requested(payload)
    const patches = []
    for (const { path } of this.changes(record)) {
      const before = await this.blob(record.before.files[path]?.hash), after = await this.blob(record.after?.files[path]?.hash)
      const binary = [before, after].some(bytes => bytes && (bytes.includes(0) || bytes.length > 256 * 1024))
      patches.push({ path, before: binary || !before ? null : before.toString('utf8'), after: binary || !after ? null : after.toString('utf8'), binary })
    }
    return checkpointInspectionSchema.parse({ checkpoint: this.public(record, thread), patches })
  }) }
  private async blob(hash: string | undefined): Promise<Buffer | null> {
    if (!hash) return null
    const bytes = await readFile(join(this.dependencies.directory, 'blobs', hash))
    if (digest(bytes) !== hash) return fail('blocked', 'A checkpoint file backup failed its integrity check.')
    return bytes
  }
  private async checkFiles(record: Record, recovery = false): Promise<void> {
    if (!record.after) return fail('blocked', 'This checkpoint has no completed file snapshot.')
    // Reads every file: this is the check that keeps a revert from overwriting later edits.
    const current = await this.capture.snapshot(record.cwd, { reuse: false })
    if (current.head !== record.after.head || current.index !== record.after.index) return fail('blocked', 'Git history or staging changed after this checkpoint. Preserve those changes before reverting.')
    for (const { path } of this.changes(record)) {
      if (!equal(current.files[path], record.after.files[path]) && !(recovery && equal(current.files[path], record.before.files[path]))) return fail('blocked', `Later edits in ${path} would be overwritten. Preserve them before reverting.`)
      await this.blob(record.before.files[path]?.hash)
    }
  }
  private async restore(record: Record): Promise<void> {
    await this.checkFiles(record, true)
    for (const { path } of this.changes(record)) {
      const absolute = await this.safe(record.cwd, path), before = record.before.files[path]
      const current = await readFile(absolute).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error })
      if (current && digest(current) !== record.after?.files[path]?.hash && digest(current) !== before?.hash) return fail('blocked', `Later edits in ${path} would be overwritten.`)
      if (before) {
        const bytes = await this.blob(before.hash)
        await mkdir(dirname(absolute), { recursive: true })
        await this.safe(record.cwd, path)
        const temporary = `${absolute}.sotto-revert-${randomUUID()}`
        try { await writeFile(temporary, bytes!, { flag: 'wx', mode: before.mode }); await rename(temporary, absolute) }
        finally { await unlink(temporary).catch(() => undefined) }
      } else await unlink(absolute).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error })
    }
    record.status = 'reverted'; delete record.reason; await this.save()
  }
  revertCheckpoint(payload: unknown) { return this.run(() => this.serial(async () => {
    await this.load(); await this.save()
    const parsed = parse(checkpointRevertSchema, payload)
    const { confirmed: _confirmed, ...request } = parsed; void _confirmed
    const { record, thread } = await this.requested(request)
    if (!thread.rollbackSupported) return fail('blocked', thread.unsupportedReason ?? 'Matching native conversation rollback is unavailable.')
    if (thread.busy !== false || await this.isWorkspaceBlocked(thread.threadId)) return fail('blocked', 'Finish or resolve active and pending work before reverting.')
    if (record.status !== 'ready' || !record.afterUsers || !equal(thread.userMessageIds, record.afterUsers)) return fail('blocked', 'Only the latest completed checkpoint with unchanged native history can be reverted.')
    this.locks.add(thread.threadId)
    let release: (() => void) | undefined
    try {
      release = await this.dependencies.acquireMutation?.(thread.threadId)
      await this.checkFiles(record)
      const guarded = await this.dependencies.resolveThread(thread.threadId, { mutationHeld: Boolean(release) })
      if (!guarded || guarded.busy !== false || !this.matches(record, guarded) || !equal(guarded.userMessageIds, record.afterUsers)) return fail('blocked', 'Thread work changed while checking the checkpoint. Review it again before reverting.')
      await this.save()
      if (!this.records.has(record.id)) return fail('blocked', 'This checkpoint expired or local history changed. No rollback was sent. Review the working copy.')
      record.status = 'reverting'; await this.save()
      let result: { accepted: boolean; uncertain?: boolean }
      try { result = await this.dependencies.rollback(thread.threadId, record.afterUsers.length - record.beforeUsers.length, record.afterUsers) }
      catch { result = { accepted: false } }
      if (!result.accepted && !result.uncertain) { record.status = 'ready'; await this.save(); return fail('blocked', 'The provider rejected rollback. Files are unchanged; review the native thread before retrying.') }
      await this.dependencies.refresh(thread.threadId)
      const current = await this.dependencies.resolveThread(thread.threadId)
      if (!current || !this.matches(record, current) || !equal(current.userMessageIds, record.beforeUsers)) {
        record.status = 'uncertain'; record.reason = 'Native rollback has not been confirmed. Check recovery before continuing; Sotto will not send it again.'; await this.save()
        return this.public(record, current)
      }
      await this.restore(record)
      return this.public(record, current)
    } catch (error) {
      if (record.status === 'reverting') { record.status = 'uncertain'; record.reason = 'Revert was interrupted. Check recovery to reconcile native history and finish restoring files.'; await this.save() }
      throw error
    } finally { release?.(); this.locks.delete(thread.threadId); await this.save() }
  })) }
  recoverCheckpoint(payload: unknown) { return this.run(() => this.serial(async () => {
    await this.load(); await this.save()
    let release: (() => void) | undefined
    try {
      const { record, thread } = await this.requested(payload)
      if (!['uncertain', 'reverting'].includes(record.status)) return this.public(record, thread)
      if (thread.busy !== false) return fail('blocked', 'Wait for active or pending work to finish before recovery.')
      release = await this.dependencies.acquireMutation?.(thread.threadId)
      await this.dependencies.refresh(thread.threadId)
      const current = await this.dependencies.resolveThread(thread.threadId)
      if (!current || !this.matches(record, current) || !equal(current.userMessageIds, record.beforeUsers)) return fail('blocked', 'Native rollback is still unconfirmed. No files were changed and rollback was not sent again.')
      await this.restore(record)
      return this.public(record, current)
    } finally { release?.(); await this.save() }
  })) }
  dispose(): void { clearInterval(this.maintenance); this.disposed = true }
}
