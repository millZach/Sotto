import { randomUUID } from 'node:crypto'
import { basename, join } from 'node:path'
import { z } from 'zod'
import type { IPty, IPtyForkOptions } from 'node-pty'
import type { FileWorkspace } from '../../shared/files'
import { terminalCreateSchema, terminalRequestSchema, terminalWriteSchema, terminalResizeSchema, terminalSessionSchema, TERMINAL_MAX_OUTPUT, type TerminalSession, type TerminalSnapshot, type TerminalEvent } from '../../shared/terminal'
import { toolListRequestSchema } from '../../shared/tools'
import type { FilesService } from '../files/service'
import { AtomicJsonStore } from '../storage/atomicJsonStore'
import { ToolOperations, fail, parse, workspace } from './common'

export interface TerminalDependencies {
  files: FilesService
  directory: string
  emit(event: TerminalEvent): void
  spawn?: (file: string, args: string[], options: IPtyForkOptions) => IPty
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
}
interface LiveTerminal { session: TerminalSession; pty?: IPty | undefined; reopening?: boolean; output: string; sequence: number; subscriptions: { dispose(): void }[] }

/** Main owns live PTYs. Disk records are reopen hints, never process-resumption claims. */
export class TerminalService extends ToolOperations {
  private readonly sessions = new Map<string, LiveTerminal>()
  private readonly store: AtomicJsonStore<TerminalSession[]>
  private readonly ready: Promise<void>
  private persistence: Promise<void> = Promise.resolve()
  constructor(private readonly dependencies: TerminalDependencies) {
    super()
    this.store = new AtomicJsonStore(join(dependencies.directory, 'terminal-sessions.json'), value => z.array(terminalSessionSchema).max(32).parse(value), () => [])
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
    const request = parse(toolListRequestSchema, payload)
    await this.ready
    const owner = await workspace(this.dependencies.files, request.threadId, request.workspaceId)
    return { workspace: owner, sessions: [...this.sessions.values()].filter(record => record.session.workspace.workspaceId === owner.workspaceId).map(record => ({ ...record.session })) }
  }) }
  create(payload: unknown) { return this.run(async () => {
    const request = parse(terminalCreateSchema, payload)
    await this.ready
    const owner = await workspace(this.dependencies.files, request.threadId, request.workspaceId)
    return this.snapshot(await this.start(owner, request.cols ?? 80, request.rows ?? 24))
  }) }
  private async start(owner: FileWorkspace, cols: number, rows: number): Promise<LiveTerminal> {
    // Reserve synchronously before importing/spawning so concurrent create calls respect limits.
    if (this.disposed) return fail('unavailable', 'Terminal is shutting down.')
    if (this.sessions.size >= 32) return fail('busy', 'Close an existing terminal before opening another (32 maximum).')
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
    const shell = platform === 'win32' ? join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : env.SHELL || (platform === 'darwin' ? '/bin/zsh' : '/bin/sh')
    const record: LiveTerminal = { session: { id: randomUUID(), workspace: owner, title: basename(shell), shell, status: 'running', cols, rows, exitCode: null, createdAt: Date.now() }, output: '', sequence: 0, subscriptions: [] }
    this.sessions.set(record.session.id, record)
    try {
      const spawn = this.dependencies.spawn ?? (await import('node-pty')).spawn
      await workspace(this.dependencies.files, owner.threadId, owner.workspaceId)
      if (this.disposed) return fail('unavailable', 'Terminal is shutting down.')
      const pty = spawn(shell, platform === 'win32' ? ['-NoLogo'] : ['-l'], { cwd: owner.workingDirectory, cols, rows, env, name: 'xterm-256color' })
      record.pty = pty
      record.subscriptions.push(pty.onData(data => {
        if (record.pty !== pty || this.disposed) return
        for (let offset = 0; offset < data.length;) {
          let end = Math.min(offset + 65536, data.length)
          if (end < data.length && /[\uD800-\uDBFF]/.test(data[end - 1]!)) end--
          const chunk = data.slice(offset, end)
          record.output = (record.output + chunk).slice(-TERMINAL_MAX_OUTPUT)
          if (/^[\uDC00-\uDFFF]/.test(record.output)) record.output = record.output.slice(1)
          record.sequence++
          this.dependencies.emit({ type: 'output', threadId: owner.threadId, workspaceId: owner.workspaceId, sessionId: record.session.id, data: chunk, sequence: record.sequence })
          offset = end
        }
      }), pty.onExit(({ exitCode }) => {
        if (record.pty !== pty) return
        record.pty = undefined
        record.session.status = 'exited'
        record.session.exitCode = exitCode
        this.publish(record)
        void this.save().catch(() => { record.session.status = 'unavailable'; this.publish(record) })
      }))
      await this.save()
      if (this.disposed) return fail('unavailable', 'Terminal is shutting down.')
      this.publish(record)
      return record
    } catch {
      this.stop(record)
      this.sessions.delete(record.session.id)
      return fail('unavailable', 'The terminal could not start or save its session. Check that the shell is available and app storage is writable.')
    }
  }
  read(payload: unknown) { return this.run(async () => this.snapshot(await this.owned(parse(terminalRequestSchema, payload), false))) }
  write(payload: unknown) { return this.run(async () => {
    const request = parse(terminalWriteSchema, payload)
    const record = await this.owned(request)
    if (!record.pty) return fail('not-running', 'This terminal has exited. Reopen it to start a new shell.')
    record.pty.write(request.data)
  }) }
  resize(payload: unknown) { return this.run(async () => {
    const request = parse(terminalResizeSchema, payload)
    const record = await this.owned(request)
    if (!record.pty) return fail('not-running', 'This terminal has exited.')
    record.pty.resize(request.cols, request.rows)
    record.session.cols = request.cols; record.session.rows = request.rows
    this.publish(record)
  }) }
  interrupt(payload: unknown) { return this.run(async () => {
    const record = await this.owned(parse(terminalRequestSchema, payload), false)
    if (!record.pty) return fail('not-running', 'This terminal has exited.')
    record.pty.write('\x03')
  }) }
  close(payload: unknown) { return this.run(async () => {
    const request = parse(terminalRequestSchema, payload)
    const record = await this.owned(request, false)
    this.stop(record); this.sessions.delete(record.session.id)
    await this.save()
    this.dependencies.emit({ type: 'closed', ...request })
  }) }
  reopen(payload: unknown) { return this.run(async () => {
    const record = await this.owned(parse(terminalRequestSchema, payload))
    if (record.pty) return fail('not-running', 'This terminal is still running; select it instead.')
    if (record.reopening) return fail('busy', 'This terminal is already reopening.')
    record.reopening = true
    // Replace the dead session's slot; reopening must also work at the session limit.
    // start reserves its new slot synchronously before yielding.
    this.sessions.delete(record.session.id)
    let replacement: LiveTerminal
    try { replacement = await this.start(record.session.workspace, record.session.cols, record.session.rows) }
    catch (error) {
      this.sessions.set(record.session.id, record)
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
