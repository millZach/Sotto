import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import { checkpointInspectionSchema, checkpointRequestSchema, checkpointRevertSchema, type Checkpoint } from '../../shared/checkpoints'
import { fileRelativePathSchema, type FileWorkspace } from '../../shared/files'
import { toolListRequestSchema } from '../../shared/tools'
import { AtomicJsonStore } from '../storage/atomicJsonStore'
import { ToolOperations, fail, parse, workspace } from './common'
import type { CheckpointDependencies, CheckpointThread } from './checkpointTypes'

const fileSchema = z.object({ hash: z.string().regex(/^[a-f0-9]{64}$/), mode: z.number() }).strict()
const snapshotSchema = z.object({ files: z.record(fileRelativePathSchema, fileSchema), index: z.string(), head: z.string() }).strict()
const recordSchema = z.object({ id: z.string().uuid(), threadId: z.string(), workspaceId: z.string(), cwd: z.string(), providerId: z.string(), bindingId: z.string(), createdAt: z.string(),
  beforeUsers: z.array(z.string()), afterUsers: z.array(z.string()).optional(), before: snapshotSchema, after: snapshotSchema.optional(),
  status: z.enum(['capturing', 'ready', 'reverting', 'uncertain', 'reverted', 'unavailable']), reason: z.string().optional(),
}).strict()
type Record = z.infer<typeof recordSchema>
type Snapshot = z.infer<typeof snapshotSchema>
const equal = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
const digest = (data: Buffer): string => createHash('sha256').update(data).digest('hex')

/** Durable per-turn file associations. Native effects are never retried after an uncertain delivery. */
export class CheckpointService extends ToolOperations {
  private readonly store: AtomicJsonStore<Record[]>
  private readonly records = new Map<string, Record>()
  private loaded: Promise<void> | undefined
  private tail: Promise<unknown> = Promise.resolve()
  private readonly locks = new Set<string>()
  constructor(private readonly dependencies: CheckpointDependencies) {
    super()
    this.store = new AtomicJsonStore(join(dependencies.directory, 'checkpoints.json'), z.array(recordSchema).parse, () => [])
  }
  private load(): Promise<void> {
    return this.loaded ??= readFile(join(this.dependencies.directory, 'checkpoints.json'), 'utf8').then(text => {
      // Recovery journals cannot use the ordinary store's corrupt-file default: forgetting
      // an uncertain native effect would unlock work against partially restored files.
      let records: Record[]
      try { records = z.array(recordSchema).parse(JSON.parse(text)) }
      catch { throw new Error('Checkpoint recovery storage is corrupt. Restore it before changing this workspace.') }
      for (const record of records) {
        if (record.status === 'capturing') {
          record.status = 'unavailable'
          record.reason = 'Checkpoint capture was interrupted before its completed file snapshot was saved. Later edits cannot be safely attributed to that turn.'
        }
        this.records.set(record.id, record)
      }
    }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error })
  }
  initialize(): Promise<void> { return this.load() }
  private async save(): Promise<void> { await this.store.write([...this.records.values()]) }
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
  async isWorkspaceBlocked(threadId: string): Promise<boolean> {
    await this.load()
    if (this.isBlocked(threadId)) return true
    const owner = await workspace(this.dependencies.files, threadId)
    const cwd = await realpath(owner.workingDirectory)
    return [...this.records.values()].some(record => (process.platform === 'win32' ? record.cwd.toLowerCase() === cwd.toLowerCase() : record.cwd === cwd)
      && (['reverting', 'uncertain'].includes(record.status) || this.locks.has(record.threadId)))
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
  private async snapshot(cwd: string): Promise<Snapshot> {
    const raw = await this.git(cwd, ['ls-files', '-c', '-o', '--exclude-standard', '-z', '--', '.'])
    const paths = [...new Set(raw.split('\0').filter(Boolean))].sort()
    if (paths.length > 10000) return fail('too-large', 'This working copy exceeds the 10,000-file checkpoint limit.')
    const files: Snapshot['files'] = Object.create(null), blobDirectory = join(this.dependencies.directory, 'blobs')
    await mkdir(blobDirectory, { recursive: true })
    let total = 0
    for (const path of paths) {
      if (['__proto__', 'constructor', 'prototype'].includes(path)) return fail('blocked', 'This working copy contains a file name that checkpoint storage cannot safely represent.')
      const absolute = await this.safe(cwd, path)
      const info = await lstat(absolute).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error })
      if (!info) continue
      if (!info.isFile() || info.nlink > 1) return fail('blocked', 'Checkpoint capture requires regular files without hard links.')
      total += info.size
      if (total > 64 * 1024 * 1024 || info.size > 8 * 1024 * 1024) return fail('too-large', 'This working copy exceeds the checkpoint size limit (64 MiB total, 8 MiB per file).')
      const bytes = await readFile(absolute), hash = digest(bytes)
      await writeFile(join(blobDirectory, hash), bytes, { flag: 'wx', mode: 0o600 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error })
      files[path] = { hash, mode: info.mode }
    }
    return { files, index: await this.git(cwd, ['ls-files', '--stage', '-z']), head: await this.git(cwd, ['rev-parse', '--verify', 'HEAD']).then(text => text.trim(), () => '') }
  }
  async beforeTurn(threadId: string): Promise<void> {
    await this.afterTurn(threadId)
    return this.serial(async () => {
    await this.load()
    if (this.isBlocked(threadId)) return fail('blocked', 'Resolve the interrupted checkpoint revert before sending more work.')
    const thread = await this.dependencies.resolveThread(threadId)
    if (!thread) return
    const pending = [...this.records.values()].find(record => record.threadId === threadId && record.status === 'capturing')
    if (pending) {
      if (!equal(pending.beforeUsers, thread.userMessageIds) || thread.running) return
      this.records.delete(pending.id)
    }
    const owner = await workspace(this.dependencies.files, threadId)
    const canonical = await realpath(owner.workingDirectory)
    const overlapping = [...this.records.values()].filter(record => record.threadId !== threadId && record.status === 'capturing' && (process.platform === 'win32' ? record.cwd.toLowerCase() === canonical.toLowerCase() : record.cwd === canonical))
    const overlapReason = overlapping.length ? 'Other thread work overlapped in this shared working copy. Its files cannot be safely attributed to this turn.' : undefined
    for (const other of overlapping) other.reason = overlapReason
    let before: Snapshot
    let reason: string | undefined
    try { before = await this.snapshot(owner.workingDirectory) }
    catch (error) { before = { files: {}, index: '', head: '' }; reason = error instanceof Error ? error.message : 'File checkpoint capture was unavailable.' }
    const record: Record = { id: randomUUID(), threadId, workspaceId: owner.workspaceId, cwd: canonical, providerId: thread.providerId, bindingId: thread.bindingId, beforeUsers: [...thread.userMessageIds], before, status: 'capturing', createdAt: new Date().toISOString() }
    if (overlapReason) record.reason = overlapReason
    if (reason) { record.status = 'unavailable'; record.reason = reason.slice(0, 2000) }
    this.records.set(record.id, record); await this.save()
  }) }
  async afterTurn(threadId: string): Promise<void> { return this.serial(async () => {
    await this.load()
    const record = [...this.records.values()].find(record => record.threadId === threadId && record.status === 'capturing')
    if (!record) return
    const thread = await this.dependencies.resolveThread(threadId)
    if (!thread || (thread.running ?? thread.busy)) return
    if (!this.matches(record, thread) || !equal(thread.userMessageIds.slice(0, record.beforeUsers.length), record.beforeUsers)) { record.status = 'unavailable'; record.reason = 'The native conversation binding changed during this turn.'; await this.save(); return }
    if (thread.userMessageIds.length === record.beforeUsers.length) return
    await workspace(this.dependencies.files, threadId, record.workspaceId)
    try { record.after = await this.snapshot(record.cwd) }
    catch (error) { record.status = 'unavailable'; record.reason = error instanceof Error ? error.message.slice(0, 2000) : 'Completed file snapshot was unavailable.'; await this.save(); return }
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
    const owner = await workspace(this.dependencies.files, request.threadId, request.workspaceId)
    const thread = await this.dependencies.resolveThread(request.threadId)
    return { checkpoints: [...this.records.values()].filter(record => record.threadId === request.threadId && record.workspaceId === owner.workspaceId && record.status !== 'capturing').reverse().map(record => this.public(record, thread)), supported: thread?.rollbackSupported ?? false, ...(!thread?.rollbackSupported ? { reason: thread?.unsupportedReason ?? 'Native conversation rollback is unavailable for this provider.' } : {}) }
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
    const current = await this.snapshot(record.cwd)
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
    const parsed = parse(checkpointRevertSchema, payload)
    const { confirmed: _confirmed, ...request } = parsed; void _confirmed
    const { record, thread } = await this.requested(request)
    if (!thread.rollbackSupported) return fail('blocked', thread.unsupportedReason ?? 'Matching native conversation rollback is unavailable.')
    if (thread.busy || this.isBlocked(thread.threadId)) return fail('blocked', 'Finish or resolve active and pending work before reverting.')
    if (record.status !== 'ready' || !record.afterUsers || !equal(thread.userMessageIds, record.afterUsers)) return fail('blocked', 'Only the latest completed checkpoint with unchanged native history can be reverted.')
    this.locks.add(thread.threadId)
    try {
      await this.checkFiles(record)
      const guarded = await this.dependencies.resolveThread(thread.threadId)
      if (!guarded || guarded.busy || !this.matches(record, guarded) || !equal(guarded.userMessageIds, record.afterUsers)) return fail('blocked', 'Thread work changed while checking the checkpoint. Review it again before reverting.')
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
    } finally { this.locks.delete(thread.threadId) }
  })) }
  recoverCheckpoint(payload: unknown) { return this.run(() => this.serial(async () => {
    const { record, thread } = await this.requested(payload)
    if (!['uncertain', 'reverting'].includes(record.status)) return this.public(record, thread)
    if (thread.busy) return fail('blocked', 'Wait for active or pending work to finish before recovery.')
    await this.dependencies.refresh(thread.threadId)
    const current = await this.dependencies.resolveThread(thread.threadId)
    if (!current || !this.matches(record, current) || !equal(current.userMessageIds, record.beforeUsers)) return fail('blocked', 'Native rollback is still unconfirmed. No files were changed and rollback was not sent again.')
    await this.restore(record)
    return this.public(record, current)
  })) }
  dispose(): void { this.disposed = true }
}
