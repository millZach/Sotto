import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { basename, isAbsolute, join, win32 as win32Path } from 'node:path'
import { z } from 'zod'
import type { IPty, IPtyForkOptions } from 'node-pty'
import type { FileWorkspace } from '../../shared/files'
import type { ToolsResult } from '../../shared/tools'
import { terminalCreateSchema, terminalRequestSchema, terminalWriteSchema, terminalResizeSchema, terminalImageSchema, terminalSessionSchema, terminalListRequestSchema, TERMINAL_MAX_OUTPUT, TERMINAL_SESSIONS_MAX, TERMINAL_LIMIT_MESSAGE, type TerminalPlace, type TerminalSession, type TerminalSnapshot, type TerminalEvent } from '../../shared/terminal'
import { saveTerminalImage, terminalImageInput } from '../terminals/clipboard'
import type { FilesService } from '../files/service'
import { AtomicJsonStore } from '../storage/atomicJsonStore'
import { INVALID_REQUEST, ToolOperations, fail, parse, workspace } from './common'
import { terminalInputFor } from '../../shared/runnableCommand'
import { TerminalShell } from '../terminals/shell'
import { CheckoutSendRefusal } from '../agents/checkoutMutations'

export interface TerminalDependencies {
  files: FilesService
  directory: string
  /** The folder of a thread's project, where a pane drawer's shells start even when the thread has its own worktree. */
  projectFolder?: (projectId: string) => string | undefined
  emit(event: TerminalEvent): void
  spawn?: (file: string, args: string[], options: IPtyForkOptions) => IPty
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  executableExists?: (path: string) => Promise<boolean>
  /** Prevents a new shell from starting while the desktop removes its checkout. */
  acquireStart?: (workspace: FileWorkspace) => Promise<() => void>
  /** Whether a drawer shell may start with a command from a reply (ADR-0136, an Owl feature), read once at start. */
  runCommandEnabled?: boolean
}
interface PendingRun { output(): void; arm(): void; cancel(): void }
interface LiveTerminal { session: TerminalSession; pty?: IPty | undefined; cwd?: string; reopening?: boolean; output: string; sequence: number; subscriptions: { dispose(): void }[]; pendingRun?: PendingRun | undefined }

/** A reply's command waits for the new shell to go quiet this long after it last printed, so its prompt is drawn. */
export const RUN_QUIET_MS = 150
/** However busy a shell's start-up is, the command is typed this long after it spawned. */
export const RUN_START_CAP_MS = 3_000

/** Main owns live PTYs. Disk records are reopen hints, never process-resumption claims. */
export class TerminalService extends ToolOperations {
  private readonly sessions = new Map<string, LiveTerminal>()
  private readonly store: AtomicJsonStore<TerminalSession[]>
  private readonly ready: Promise<void>
  private persistence: Promise<void> = Promise.resolve()
  private readonly inputLanes = new Map<string, Promise<ToolsResult<void>>>()
  private readonly shell: TerminalShell
  private capacityVersion = 0
  constructor(private readonly dependencies: TerminalDependencies) {
    super()
    this.shell = new TerminalShell(dependencies)
    this.store = new AtomicJsonStore(join(dependencies.directory, 'terminal-sessions.json'), value => z.array(terminalSessionSchema).max(TERMINAL_SESSIONS_MAX).parse(value), () => [])
    this.ready = this.store.read().then(sessions => {
      for (const session of sessions) this.sessions.set(session.id, { session: { ...session, status: session.status === 'running' ? 'interrupted' : session.status }, output: '', sequence: 0, subscriptions: [] })
    })
    // Surface storage failure through requests without an unhandled startup rejection.
    void this.ready.catch(() => undefined)
  }
  private async save(): Promise<void> {
    const values = [...this.sessions.values()].map(record => ({ ...record.session }))
    this.persistence = this.store.write(values)
    await this.persistence
  }
  private publish(record: LiveTerminal): void { this.dependencies.emit({ type: 'session', session: { ...record.session } }) }
  private capacity() { return { count: this.sessions.size, version: this.capacityVersion } }
  private publishCapacity(): void { this.capacityVersion++; this.dependencies.emit({ type: 'capacity', capacity: this.capacity() }) }
  /** Whether a shell of this thread's is still running in its working copy, so the folder is not reclaimed under it. Counts a Tools shell and a pane drawer's shell alike: a drawer's shell starts in the project folder, but it can be changed into the working copy. */
  hasRunningTerminal(threadId: string): boolean {
    return [...this.sessions.values()].some(record => record.session.workspace.threadId === threadId && record.pty !== undefined)
  }
  private snapshot(record: LiveTerminal): TerminalSnapshot { return { session: { ...record.session }, output: record.output, sequence: record.sequence } }
  private async owned(request: z.infer<typeof terminalRequestSchema>, validateDirectory = true): Promise<LiveTerminal> {
    await this.ready
    const record = this.sessions.get(request.sessionId)
    if (!record || record.session.workspace.threadId !== request.threadId || record.session.workspace.workspaceId !== request.workspaceId) return fail('session-unavailable', 'This terminal belongs to a different workspace or was closed.')
    if (validateDirectory) await workspace(this.dependencies.files, request.threadId, request.workspaceId)
    if (this.disposed || this.sessions.get(request.sessionId) !== record) return fail('session-unavailable', 'This terminal has closed.')
    return record
  }
  list(payload: unknown) { return this.run(async () => {
    const request = parse(terminalListRequestSchema, payload)
    await this.ready
    const owner = await workspace(this.dependencies.files, request.threadId, request.workspaceId)
    const place = request.place ?? 'tools'
    return { workspace: owner, sessions: [...this.sessions.values()].filter(record => record.session.workspace.workspaceId === owner.workspaceId && record.session.place === place).map(record => ({ ...record.session })), capacity: this.capacity() }
  }) }
  create(payload: unknown) { return this.run(async () => {
    const request = parse(terminalCreateSchema, payload)
    // A command runs only in a new drawer shell, and only while the feature is on; the command itself is never logged.
    if (request.run !== undefined && (request.place !== 'drawer' || !this.dependencies.runCommandEnabled)) return fail('invalid-request', INVALID_REQUEST)
    await this.ready
    const owner = await workspace(this.dependencies.files, request.threadId, request.workspaceId)
    return this.snapshot(await this.start(owner, request.cols ?? 80, request.rows ?? 24, request.place ?? 'tools', undefined, request.run))
  }) }
  private async start(owner: FileWorkspace, cols: number, rows: number, place: TerminalPlace, replacing?: LiveTerminal, run?: string): Promise<LiveTerminal> {
    // Reserve synchronously before importing/spawning so concurrent create calls respect limits.
    if (this.disposed) return fail('unavailable', 'Terminal is shutting down.')
    if (!replacing && this.sessions.size >= TERMINAL_SESSIONS_MAX) return fail('busy', TERMINAL_LIMIT_MESSAGE)
    const platform = this.dependencies.platform ?? process.platform
    const env = { ...(this.dependencies.env ?? process.env) }
    // Electron-run-as-Node/debug flags must not contaminate programs launched by a user shell.
    for (const key of Object.keys(env)) if (/^(ELECTRON_RUN_AS_NODE|NODE_OPTIONS|NODE_INSPECT_RESUME_ON_START)$/i.test(key)) delete env[key]
    // A launcher's plain-text output policy does not describe this interactive terminal.
    // Clear inherited overrides before the shell profile runs so users can still customize it.
    for (const key of Object.keys(env)) {
      const name = platform === 'win32' ? key.toUpperCase() : key
      if (/^(NO_COLOR|FORCE_COLOR|CLICOLOR|CLICOLOR_FORCE|TERM|COLORTERM|TERM_PROGRAM)$/.test(name)) delete env[key]
    }
    env.TERM = 'xterm-256color'
    env.COLORTERM = 'truecolor'
    env.TERM_PROGRAM = 'Sotto'
    const record: LiveTerminal = { session: { id: randomUUID(), workspace: owner, title: '', shell: '', status: 'running', cols, rows, exitCode: null, createdAt: Date.now(), place }, output: '', sequence: 0, subscriptions: [] }
    if (replacing) this.sessions.delete(replacing.session.id)
    this.sessions.set(record.session.id, record)
    this.publishCapacity()
    const releases: (() => void)[] = []
    try {
      const shell = await this.shell.resolve()
      record.session.shell = shell
      record.session.title = platform === 'win32' ? win32Path.basename(shell) : basename(shell)
      const spawn = this.dependencies.spawn ?? (await import('node-pty')).spawn
      await workspace(this.dependencies.files, owner.threadId, owner.workspaceId)
      const cwd = place === 'drawer' ? await this.projectFolder(owner) : owner.workingDirectory
      // Keep the binding alive as before, and also reserve the drawer's actual launch folder.
      if (this.dependencies.acquireStart) {
        releases.push(await this.dependencies.acquireStart(owner))
        if (cwd !== owner.workingDirectory) releases.push(await this.dependencies.acquireStart({ ...owner, workingDirectory: cwd }))
      }
      if (this.disposed) return fail('unavailable', 'Terminal is shutting down.')
      const pty = spawn(shell, platform === 'win32' ? ['-NoLogo'] : ['-l'], { cwd, cols, rows, env, name: 'xterm-256color' })
      record.cwd = cwd
      record.pty = pty
      record.subscriptions.push(pty.onData(data => {
        if (record.pty !== pty || this.disposed) return
        record.pendingRun?.output()
        for (let offset = 0; offset < data.length;) {
          let end = Math.min(offset + 65536, data.length)
          if (end < data.length && /[\uD800-\uDBFF]/.test(data[end - 1]!)) end--
          const chunk = data.slice(offset, end)
          record.output = (record.output + chunk).slice(-TERMINAL_MAX_OUTPUT)
          if (/^[\uDC00-\uDFFF]/.test(record.output)) record.output = record.output.slice(1)
          record.sequence++
          this.dependencies.emit({ type: 'output', threadId: owner.threadId, workspaceId: owner.workspaceId, sessionId: record.session.id, data: chunk, sequence: record.sequence, place: record.session.place })
          offset = end
        }
      }), pty.onExit(({ exitCode }) => {
        if (record.pty !== pty) return
        record.pendingRun?.cancel()
        record.pty = undefined
        record.session.status = 'exited'
        record.session.exitCode = exitCode
        this.publish(record)
        void this.save().catch(() => { record.session.status = 'unavailable'; this.publish(record) })
      }))
      // Main types the command, so no window replay can drop it; it waits for the shell's prompt (typeWhenSettled).
      // The tab names the command.
      if (run !== undefined) {
        record.session.title = run.split('\n')[0]!.slice(0, 256)
        record.pendingRun = this.typeWhenSettled(record, pty, run)
      }
      await this.save()
      if (this.disposed) return fail('unavailable', 'Terminal is shutting down.')
      record.pendingRun?.arm()
      this.publish(record)
      return record
    } catch (error) {
      this.stop(record)
      this.sessions.delete(record.session.id)
      if (replacing) this.sessions.set(replacing.session.id, replacing)
      this.publishCapacity()
      if (error instanceof CheckoutSendRefusal) return fail('busy', error.terminalMessage())
      return fail('unavailable', 'The terminal could not start or save its session. Check that the shell is available and app storage is writable.')
    } finally { for (const release of releases.reverse()) release() }
  }
  /**
   * Types a reply's command into a new shell once it is ready to read it: after its first output and then RUN_QUIET_MS
   * with none, or RUN_START_CAP_MS after it spawned, whichever comes first. Typed sooner, a shell still running its
   * profile can drop the text or echo it twice. A shell that ended or was closed meanwhile receives nothing. Nothing
   * is typed before `arm`, which follows the session's save: a shell whose record could not be saved is stopped, so
   * "did not start" means the command did not run.
   */
  private typeWhenSettled(record: LiveTerminal, pty: IPty, run: string): PendingRun {
    let quiet: ReturnType<typeof setTimeout> | undefined
    let armed = false
    let due = false
    const cancel = (): void => {
      clearTimeout(quiet); clearTimeout(cap)
      if (record.pendingRun === pending) record.pendingRun = undefined
    }
    const type = (): void => {
      if (!armed) { due = true; return }
      cancel()
      if (record.pty === pty && !this.disposed) pty.write(terminalInputFor(run))
    }
    const cap = setTimeout(type, RUN_START_CAP_MS)
    const pending: PendingRun = {
      output: () => { if (due) return; clearTimeout(quiet); quiet = setTimeout(type, RUN_QUIET_MS) },
      arm: () => { armed = true; if (due) type() },
      cancel,
    }
    return pending
  }
  /** The project folder, or the thread's working copy when the project folder is gone or cannot be opened. */
  private async projectFolder(owner: FileWorkspace): Promise<string> {
    const folder = this.dependencies.projectFolder?.(owner.projectId)
    if (!folder || !isAbsolute(folder)) return owner.workingDirectory
    try { if ((await stat(folder)).isDirectory()) return folder } catch { /* Moved or unreadable: the working copy still opens. */ }
    return owner.workingDirectory
  }
  read(payload: unknown) { return this.run(async () => this.snapshot(await this.owned(parse(terminalRequestSchema, payload), false))) }
  write(payload: unknown): Promise<ToolsResult<void>> {
    const parsed = terminalWriteSchema.safeParse(payload)
    if (!parsed.success) return this.run(async () => { parse(terminalWriteSchema, payload) })
    const request = parsed.data
    // Reserve order before ownership validation yields. Queued keys do not consume the active-operation cap.
    return this.input(request.sessionId, async () => {
      const record = await this.owned(request)
      if (!record.pty) return fail('not-running', 'This terminal has exited. Reopen it to start a new shell.')
      record.pty.write(request.data)
    })
  }
  private input(sessionId: string, action: () => Promise<void>): Promise<ToolsResult<void>> {
    const previous = this.inputLanes.get(sessionId) ?? Promise.resolve()
    const pending = previous.then(() => this.run(action))
    this.inputLanes.set(sessionId, pending)
    void pending.then(() => { if (this.inputLanes.get(sessionId) === pending) this.inputLanes.delete(sessionId) })
    return pending
  }
  resize(payload: unknown) { return this.run(async () => {
    const request = parse(terminalResizeSchema, payload)
    const record = await this.owned(request)
    if (!record.pty) return fail('not-running', 'This terminal has exited.')
    record.pty.resize(request.cols, request.rows)
    record.session.cols = request.cols; record.session.rows = request.rows
    this.publish(record)
  }) }
  pasteImage(payload: unknown) {
    const parsed = terminalImageSchema.safeParse(payload)
    if (!parsed.success) return this.run(async () => { parse(terminalImageSchema, payload) })
    const request = parsed.data
    return this.input(request.sessionId, async () => {
    const record = await this.owned(request)
    if (!record.pty) return fail('not-running', 'This terminal has exited. Reopen it before pasting an image.')
    const path = await saveTerminalImage(record.session.workspace.workingDirectory, request.dataUrl)
    // A save yields; do not write to a shell closed or replaced while it was on disk.
    await this.owned(request)
    if (!record.pty) return fail('not-running', 'The image was saved, but this terminal has exited. Reopen it before pasting again.')
    record.pty.write(terminalImageInput(path, this.dependencies.platform ?? process.platform))
    })
  }
  interrupt(payload: unknown) { return this.run(async () => {
    const record = await this.owned(parse(terminalRequestSchema, payload), false)
    if (!record.pty) return fail('not-running', 'This terminal has exited.')
    record.pty.write('\x03')
  }) }
  close(payload: unknown) { return this.run(async () => {
    const request = parse(terminalRequestSchema, payload)
    const record = await this.owned(request, false)
    this.stop(record); this.sessions.delete(record.session.id)
    this.publishCapacity()
    await this.save()
    this.dependencies.emit({ type: 'closed', ...request })
  }) }
  reopen(payload: unknown) { return this.run(async () => {
    const record = await this.owned(parse(terminalRequestSchema, payload))
    if (record.pty) return fail('not-running', 'This terminal is still running; select it instead.')
    if (record.reopening) return fail('busy', 'This terminal is already reopening.')
    record.reopening = true
    // Replace the dead session's reservation atomically, including rollback, so a failed reopen frees no slot.
    let replacement: LiveTerminal
    try { replacement = await this.start(record.session.workspace, record.session.cols, record.session.rows, record.session.place, record) }
    catch (error) {
      await this.save()
      throw error
    }
    finally { record.reopening = false }
    this.stop(record); this.sessions.delete(record.session.id)
    await this.save()
    this.dependencies.emit({ type: 'closed', threadId: record.session.workspace.threadId, workspaceId: record.session.workspace.workspaceId, sessionId: record.session.id })
    return this.snapshot(replacement)
  }) }
  private stop(record: LiveTerminal): void {
    record.pendingRun?.cancel()
    const pty = record.pty; record.pty = undefined
    for (const subscription of record.subscriptions.splice(0)) subscription.dispose()
    try { pty?.kill() } catch { /* Already exited. */ }
  }
  dispose(): void {
    this.disposed = true
    for (const record of this.sessions.values()) this.stop(record)
    // Saved running records deliberately recover as interrupted; no asynchronous quit write needed.
  }
}
