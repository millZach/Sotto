import { setTimeout as delay } from 'node:timers/promises'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { checkpointInspectionSchema, checkpointRequestSchema, checkpointRevertSchema, type Checkpoint } from '../../shared/checkpoints'
import type { FileWorkspace } from '../../shared/files'
import { toolListRequestSchema } from '../../shared/tools'
import { ToolOperations, fail, parse, workspace } from './common'
import { checkoutIdentity } from '../agents/threadWorktrees'
import { CheckpointCapture } from './checkpointCapture'
import { LINK_MESSAGE, blobName, checkpointPathSchema, isInside } from './checkpointPaths'
import { CheckpointStore, type CheckpointRecord, type Snapshot } from './checkpointStore'
import { CheckpointReferences } from './checkpointReferences'
import type { CheckpointDependencies, CheckpointThread } from './checkpointTypes'

const equal = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
/** Whether no thread work or checkout change is active or pending. A thread whose `busy` was not checked counts as busy. */
const idle = (thread: CheckpointThread): boolean => thread.busy === false

/** Durable per-turn file associations. Native effects are never retried after an uncertain delivery. */
export class CheckpointService extends ToolOperations {
  private readonly store: CheckpointStore
  private readonly records = new Map<string, CheckpointRecord>()
  private initialized = false
  private recoveryNotice: string | undefined
  private recoveryBackup: string | undefined
  private readonly blobSizes = new Map<string, number>()
  private loaded: Promise<void> | undefined
  private tail: Promise<unknown> = Promise.resolve()
  private readonly maintenance: ReturnType<typeof setInterval>
  private readonly locks = new Set<string>()
  private readonly capture: CheckpointCapture
  private readonly references = new CheckpointReferences(hash => this.blobSizes.get(hash) ?? 0)
  constructor(private readonly dependencies: CheckpointDependencies) {
    super()
    this.store = new CheckpointStore(dependencies.directory, event => dependencies.report?.(event))
    this.capture = new CheckpointCapture({ blobDirectory: join(dependencies.directory, 'blobs'), blobSizes: this.blobSizes, git: (cwd, args) => this.git(cwd, args),
      now: () => this.dependencies.now?.() ?? Date.now() })
    this.maintenance = setInterval(() => { void this.privacyChanged().catch(() => this.dependencies.report?.('Expired checkpoints could not be removed. Check access to local storage.')) }, 60 * 60 * 1000)
    this.maintenance.unref()
  }
  private load(): Promise<void> {
    return this.loaded ??= this.store.load().then(({ records, setAside }) => {
      if (setAside) this.setAside(setAside)
      for (const record of records) {
        if (record.status === 'capturing') {
          record.status = 'unavailable'
          record.reason = 'Checkpoint capture was interrupted before its completed file snapshot was saved. Later edits cannot be safely attributed to that turn.'
        }
        this.records.set(record.id, record)
      }
    }, error => { this.loaded = undefined; throw error })
  }
  private setAside(backup: string): void {
    this.recoveryBackup = backup
    this.recoveryNotice = `Sotto set aside a checkpoint file it could not read as ${basename(backup)} and kept the rest.`
    try { this.dependencies.report?.(this.recoveryNotice) } catch { /* Reporting cannot prevent recovery. */ }
  }
  initialize(): Promise<void> { if (this.initialized) return Promise.resolve(); return this.serial(async () => { await this.load(); if (!this.initialized) { await this.save(); this.initialized = true } }) }
  private async refreshRecoveryNotice(): Promise<void> {
    if (!this.recoveryBackup) return
    const exists = await lstat(this.recoveryBackup).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; this.dependencies.report?.('checkpoint-cleanup-failed'); return true })
    if (!exists) { this.recoveryBackup = undefined; this.recoveryNotice = undefined }
  }
  private unresolved(record: CheckpointRecord): boolean { return record.status === 'reverting' || record.status === 'uncertain' }
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
  private async save(changed?: readonly CheckpointRecord[]): Promise<void> {
    const cutoff = (this.dependencies.now?.() ?? Date.now()) - 30 * 24 * 60 * 60 * 1000
    let removed = false
    for (const record of this.records.values()) if (!this.unresolved(record) && (this.dependencies.historyEnabled?.() === false || Date.parse(record.createdAt) < cutoff)) { this.records.delete(record.id); removed = true }
    const directory = join(this.dependencies.directory, 'blobs')
    let blobsMissing = false, listed = false
    const blobInfo = await lstat(directory).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') blobsMissing = true
      else this.dependencies.report?.('checkpoint-cleanup-failed')
      return null
    })
    const safeDirectory = blobInfo?.isDirectory() && !blobInfo.isSymbolicLink()
    if (blobInfo && !safeDirectory) this.dependencies.report?.('checkpoint-cleanup-unsafe-directory')
    const names = safeDirectory ? (await readdir(directory).then(found => { listed = true; return found }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.dependencies.report?.('checkpoint-cleanup-failed'); return [] })).filter(name => /^[a-f0-9]{64}$/.test(name)) : []
    // A backup removed outside Sotto is forgotten, so the next capture of its file writes it again.
    if (listed || blobsMissing) { const present = new Set(names); for (const name of [...this.blobSizes.keys()]) if (!present.has(name)) this.blobSizes.delete(name) }
    const regular = new Set<string>()
    for (const name of names) {
      if (this.blobSizes.has(name)) { regular.add(name); continue }
      const info = await lstat(join(directory, name)).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.dependencies.report?.('checkpoint-cleanup-failed'); return null })
      if (info?.isFile() && !info.isSymbolicLink()) { regular.add(name); if (!this.blobSizes.has(name)) this.blobSizes.set(name, info.size) }
    }
    // Only records added or changed since the last save are counted again, so a send's save does not scan every
    // saved checkpoint's files. The stored size comes from each record's own: a journal save measures only its own.
    this.references.sync(this.records.values())
    let total = this.store.measure([...this.records.values()], changed) + this.references.bytes
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
        this.records.delete(item.recordId); removed = true
        const referenced = this.references.bytes
        this.references.remove(item.recordId)
        total -= this.store.sizeOf(item.recordId) + referenced - this.references.bytes
      }
      if (item.backup) { total -= backups.get(item.backup)!.size; backups.delete(item.backup); removedBackups.add(item.backup) }
    }
    this.store.retain(new Set(this.records.keys()))
    // Commit references before deleting any file backups. A removal cannot be journaled.
    await this.store.commit([...this.records.values()], removed ? undefined : changed?.filter(record => this.records.has(record.id)))
    for (const name of regular) if (!this.references.has(name)) {
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
  async privacyChanged(): Promise<void> { return this.serial(async () => { await this.load(); if (this.historyOff()) this.capture.forget(); await this.save() }) }
  /** Whether Keep local history is off. Then nothing about a working folder is kept either: its remembered files and verdict. */
  private historyOff(): boolean { return this.dependencies.historyEnabled?.() === false }
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
  private async sharesCheckout(record: CheckpointRecord, checkout: string): Promise<boolean> {
    if (record.checkout) return record.checkout === checkout
    // Older records predate checkout identity. An unavailable unrelated folder must not block every project.
    try { return await checkoutIdentity(record.cwd) === checkout }
    catch { return isInside(checkout, record.cwd) }
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
    parse(checkpointPathSchema, path)
    const root = await realpath(cwd), absolute = resolve(root, path)
    if (!isInside(root, absolute)) return fail('blocked', 'A checkpoint path is outside the working folder.')
    let component = root
    for (const part of relative(root, absolute).split(sep)) {
      component = join(component, part)
      const info = await lstat(component).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error })
      if (!info) break
      if (info.isSymbolicLink()) return fail('blocked', LINK_MESSAGE)
    }
    let candidate = absolute
    for (;;) {
      try {
        const info = await lstat(candidate)
        if (info.isSymbolicLink() || !isInside(root, await realpath(candidate))) return fail('blocked', LINK_MESSAGE)
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
    if (this.historyOff()) { this.capture.forget(); await this.save(); return }
    const thread = await this.dependencies.resolveThread(threadId, { historyOnly: true })
    if (!thread) return
    const pending = [...this.records.values()].find(record => record.threadId === threadId && record.status === 'capturing')
    if (pending) {
      if (!equal(pending.beforeUsers, thread.userMessageIds) || thread.running) return
      this.records.delete(pending.id)
    }
    const owner = await workspace(this.dependencies.files, threadId)
    const canonical = await realpath(owner.workingDirectory)
    let before: Snapshot = { files: {}, index: '', head: '' }
    // A folder that could not be captured last time, and has not visibly changed since, is not walked again.
    let reason = await this.capture.heldVerdict(canonical)
    if (reason === undefined) {
      const release = await this.dependencies.acquireRead?.(threadId)
      try { before = await this.capture.snapshot(canonical, { reuse: true }) }
      catch (error) { reason = error instanceof Error ? error.message : 'File checkpoint capture was unavailable.' }
      finally { release?.() }
    }
    // Asked after the capture, which notices when the folder's Git directory changed and forgets its checkout.
    const checkout = await this.capture.checkout(canonical)
    const candidates = [...this.records.values()].filter(record => record.threadId !== threadId && record.status === 'capturing')
    const sameCheckout = await Promise.all(candidates.map(record => this.sharesCheckout(record, checkout)))
    const overlapping = candidates.filter((_record, index) => sameCheckout[index])
    const overlapReason = overlapping.length ? 'Other thread work overlapped in this shared working copy. Its files cannot be safely attributed to this turn.' : undefined
    for (const other of overlapping) other.reason = overlapReason
    const record: CheckpointRecord = { id: randomUUID(), threadId, workspaceId: owner.workspaceId, cwd: canonical, checkout, providerId: thread.providerId, bindingId: thread.bindingId, beforeUsers: [...thread.userMessageIds], before, status: 'capturing', createdAt: new Date(this.dependencies.now?.() ?? Date.now()).toISOString() }
    if (overlapReason) record.reason = overlapReason
    if (reason) { record.status = 'unavailable'; record.reason = reason.slice(0, 2000) }
    this.records.set(record.id, record)
    await this.save(pending ? undefined : [record, ...overlapping])
  }) }
  async afterTurn(threadId: string): Promise<void> { return this.serial(async () => {
    await this.load()
    if (this.historyOff()) { this.capture.forget(); await this.save(); return }
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
  private matches(record: CheckpointRecord, thread: CheckpointThread): boolean { return record.threadId === thread.threadId && record.providerId === thread.providerId && record.bindingId === thread.bindingId }
  private changes(record: CheckpointRecord): Checkpoint['files'] {
    if (!record.after) return []
    return [...new Set([...Object.keys(record.before.files), ...Object.keys(record.after.files)])].sort().filter(path => !equal(record.before.files[path], record.after!.files[path]))
      .map(path => ({ path, change: !record.before.files[path] ? 'added' : !record.after!.files[path] ? 'deleted' : 'modified' }))
  }
  private public(record: CheckpointRecord, thread: CheckpointThread | null): Checkpoint {
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
  private async requested(payload: unknown): Promise<{ record: CheckpointRecord; thread: CheckpointThread; owner: FileWorkspace }> {
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
    if (blobName(bytes) !== hash) return fail('blocked', 'A checkpoint file backup failed its integrity check.')
    return bytes
  }
  private async checkFiles(record: CheckpointRecord, recovery = false): Promise<void> {
    if (!record.after) return fail('blocked', 'This checkpoint has no completed file snapshot.')
    // Reads every file: this is the check that keeps a revert from overwriting later edits.
    const current = await this.capture.snapshot(record.cwd, { reuse: false })
    if (current.head !== record.after.head || current.index !== record.after.index) return fail('blocked', 'Git history or staging changed after this checkpoint. Preserve those changes before reverting.')
    for (const { path } of this.changes(record)) {
      if (!equal(current.files[path], record.after.files[path]) && !(recovery && equal(current.files[path], record.before.files[path]))) return fail('blocked', `Later edits in ${path} would be overwritten. Preserve them before reverting.`)
      await this.blob(record.before.files[path]?.hash)
    }
  }
  private async restore(record: CheckpointRecord): Promise<void> {
    await this.checkFiles(record, true)
    for (const { path } of this.changes(record)) {
      const absolute = await this.safe(record.cwd, path), before = record.before.files[path]
      const current = await readFile(absolute).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error })
      if (current && blobName(current) !== record.after?.files[path]?.hash && blobName(current) !== before?.hash) return fail('blocked', `Later edits in ${path} would be overwritten.`)
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
    if (!idle(thread) || await this.isWorkspaceBlocked(thread.threadId)) return fail('blocked', 'Finish or resolve active and pending work before reverting.')
    if (record.status !== 'ready' || !record.afterUsers || !equal(thread.userMessageIds, record.afterUsers)) return fail('blocked', 'Only the latest completed checkpoint with unchanged native history can be reverted.')
    this.locks.add(thread.threadId)
    let release: (() => void) | undefined
    try {
      release = await this.dependencies.acquireMutation?.(thread.threadId)
      await this.checkFiles(record)
      const guarded = await this.dependencies.resolveThread(thread.threadId, { mutationHeld: Boolean(release) })
      if (!guarded || !idle(guarded) || !this.matches(record, guarded) || !equal(guarded.userMessageIds, record.afterUsers)) return fail('blocked', 'Thread work changed while checking the checkpoint. Review it again before reverting.')
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
      if (!idle(thread)) return fail('blocked', 'Wait for active or pending work to finish before recovery.')
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
