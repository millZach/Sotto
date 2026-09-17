import { randomUUID } from 'node:crypto'
import { access, mkdir, writeFile } from 'node:fs/promises'
import { basename, delimiter, join } from 'node:path'
import type { IPty, IPtyForkOptions } from 'node-pty'
import type { AgentProject, AgentWorktree } from '../../shared/agents'
import { TERMINAL_MAX_OUTPUT } from '../../shared/terminal'
import { commandLine, nativeModelName, providerCommand } from '../../shared/terminalCommands'
import {
  TERMINAL_IMAGE_MAX_BYTES, TERMINALS_MAX, terminalOpenSchema, workspaceTerminalImageSchema, workspaceTerminalRequestSchema, workspaceTerminalResizeSchema, workspaceTerminalWriteSchema,
  type TerminalLaunch, type WorkspaceTerminal, type WorkspaceTerminalEvent, type WorkspaceTerminalSnapshot,
} from '../../shared/terminalWorkspace'
import type { RunGit, ThreadWorktrees } from '../agents/threadWorktrees'
import { ToolOperations, fail, parse } from '../tools/common'

export interface TerminalWorkspaceDependencies {
  projects: () => readonly AgentProject[]
  worktrees: Pick<ThreadWorktrees, 'allocate' | 'ensure' | 'workingDirectory'>
  emit(event: WorkspaceTerminalEvent): void
  /** Best-effort Git for the branch shown under a terminal; failures leave it blank. */
  git?: RunGit
  spawn?: (file: string, args: string[], options: IPtyForkOptions) => IPty
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  executableExists?: (path: string) => Promise<boolean>
  now?: () => number
}

interface LiveTerminal { terminal: WorkspaceTerminal; pty?: IPty | undefined; starting?: boolean; output: string; sequence: number; subscriptions: { dispose(): void }[] }

interface Launcher { readonly file: string; readonly args: string[]; readonly command: string }

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const shellName = (path: string): string => basename(path).replace(/\.exe$/iu, '')
const posixQuote = (token: string): string => `'${token.replace(/'/gu, `'\\''`)}'`
const powerShellQuote = (token: string): string => `'${token.replace(/'/gu, "''")}'`

/**
 * Terminals of Terminal mode: each belongs to a project folder (or a worktree Sotto made for it) and runs either a
 * plain shell or a provider CLI with the flags the dialog chose. Main owns the PTYs for the session; nothing is kept
 * across a restart of Sotto.
 */
export class TerminalWorkspaceService extends ToolOperations {
  private readonly terminals = new Map<string, LiveTerminal>()
  constructor(private readonly dependencies: TerminalWorkspaceDependencies) { super() }
  private now(): number { return this.dependencies.now?.() ?? Date.now() }
  private publish(record: LiveTerminal): void { this.dependencies.emit({ type: 'terminal', terminal: { ...record.terminal } }) }
  private snapshot(record: LiveTerminal): WorkspaceTerminalSnapshot { return { terminal: { ...record.terminal }, output: record.output, sequence: record.sequence } }
  private async owned(id: string): Promise<LiveTerminal> {
    const record = this.terminals.get(id)
    if (!record || this.disposed) return fail('session-unavailable', 'This terminal is no longer available.')
    return record
  }

  list() { return this.run(async () => {
    const platform = this.dependencies.platform ?? process.platform
    return { terminals: [...this.terminals.values()].map(record => ({ ...record.terminal })), shell: shellName(await this.shell(this.environment(platform), platform)) }
  }) }

  open(payload: unknown) { return this.run(async () => {
    const request = parse(terminalOpenSchema, payload)
    if (this.disposed) return fail('unavailable', 'Terminal is shutting down.')
    if ([...this.terminals.values()].filter(record => record.terminal.closedAt === null).length >= TERMINALS_MAX) return fail('busy', `Close a terminal before opening another (${TERMINALS_MAX} maximum).`)
    const project = this.dependencies.projects().find(item => item.id === request.projectId)
    if (!project) return fail('workspace-unavailable', 'This project is no longer available.')
    let worktree: AgentWorktree | undefined
    let workingDirectory = project.path
    try {
      if (request.workingCopy === 'independent') {
        worktree = await this.dependencies.worktrees.ensure(await this.dependencies.worktrees.allocate(project.path, 'independent'))
        workingDirectory = await this.dependencies.worktrees.workingDirectory(worktree)
      }
    } catch (error) {
      return fail('workspace-unavailable', error instanceof Error ? error.message : 'The working folder could not be prepared.')
    }
    const launcher = await this.launcher(request.launch)
    const record: LiveTerminal = {
      terminal: {
        id: randomUUID(), projectId: project.id, title: request.title, launch: request.launch, workingCopy: worktree?.mode ?? 'shared', ...(worktree ? { worktree } : {}),
        workingDirectory, branch: await this.branch(workingDirectory), command: launcher.command, status: 'running', cols: request.cols ?? 80, rows: request.rows ?? 24, exitCode: null, openedAt: this.now(), closedAt: null,
      },
      output: '', sequence: 0, subscriptions: [],
    }
    this.terminals.set(record.terminal.id, record)
    try { await this.start(record, launcher) }
    catch (error) { this.terminals.delete(record.terminal.id); throw error }
    return this.snapshot(record)
  }) }

  private async branch(directory: string): Promise<string | null> {
    if (!this.dependencies.git) return null
    try { return (await this.dependencies.git(directory, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim() || null } catch { return null }
  }

  /** The shell for this platform: pwsh when installed, else Windows PowerShell; the login shell elsewhere. */
  private async shell(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): Promise<string> {
    if (platform !== 'win32') return env.SHELL || (platform === 'darwin' ? '/bin/zsh' : '/bin/sh')
    const exists = this.dependencies.executableExists ?? (async (path: string) => { try { await access(path); return true } catch { return false } })
    for (const entry of (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean)) {
      const candidate = join(entry, 'pwsh.exe')
      if (await exists(candidate)) return candidate
    }
    return join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  }

  private environment(platform: NodeJS.Platform): NodeJS.ProcessEnv {
    const env = { ...(this.dependencies.env ?? process.env) }
    // Electron-run-as-Node/debug flags must not contaminate programs launched by a user shell.
    for (const key of Object.keys(env)) if (/^(ELECTRON_RUN_AS_NODE|NODE_OPTIONS|NODE_INSPECT_RESUME_ON_START)$/i.test(key)) delete env[key]
    // A launcher's plain-text output policy does not describe this interactive terminal.
    for (const key of Object.keys(env)) {
      const name = platform === 'win32' ? key.toUpperCase() : key
      if (/^(NO_COLOR|FORCE_COLOR|CLICOLOR|CLICOLOR_FORCE|TERM|COLORTERM|TERM_PROGRAM)$/.test(name)) delete env[key]
    }
    env.TERM = 'xterm-256color'
    env.COLORTERM = 'truecolor'
    env.TERM_PROGRAM = 'Sotto'
    return env
  }

  /** What to spawn: the shell alone, or the shell running the provider's CLI so the user's PATH and profile apply. */
  private async launcher(launch: TerminalLaunch): Promise<Launcher> {
    const platform = this.dependencies.platform ?? process.platform
    const shell = await this.shell(this.environment(platform), platform)
    const argv = providerCommand({ provider: launch.provider, model: launch.modelId === null ? null : nativeModelName(launch.modelId), reasoning: launch.reasoning, permission: launch.permission })
    if (argv.length === 0) return { file: shell, args: platform === 'win32' ? ['-NoLogo'] : ['-l'], command: shellName(shell) }
    const command = commandLine(argv)
    if (platform === 'win32') return { file: shell, args: ['-NoLogo', '-Command', `& ${argv.map(powerShellQuote).join(' ')}`], command }
    return { file: shell, args: ['-l', '-i', '-c', `exec ${argv.map(posixQuote).join(' ')}`], command }
  }

  private async start(record: LiveTerminal, launcher: Launcher): Promise<void> {
    const platform = this.dependencies.platform ?? process.platform
    const env = this.environment(platform)
    const { cols, rows } = record.terminal
    record.starting = true
    try {
      const spawn = this.dependencies.spawn ?? (await import('node-pty')).spawn
      if (this.disposed) return fail('unavailable', 'Terminal is shutting down.')
      record.output = ''
      record.sequence = 0
      record.terminal = { ...record.terminal, status: 'running', exitCode: null, closedAt: null }
      const pty = spawn(launcher.file, launcher.args, { cwd: record.terminal.workingDirectory, cols, rows, env, name: 'xterm-256color' })
      record.pty = pty
      this.append(record, `\x1b[2mOpened by Sotto at ${record.terminal.workingDirectory} · ${launcher.command}\x1b[0m\r\n`)
      record.subscriptions.push(pty.onData(data => {
        if (record.pty !== pty || this.disposed) return
        for (let offset = 0; offset < data.length;) {
          let end = Math.min(offset + 65536, data.length)
          if (end < data.length && /[\uD800-\uDBFF]/.test(data[end - 1]!)) end--
          this.append(record, data.slice(offset, end))
          offset = end
        }
      }), pty.onExit(({ exitCode }) => {
        if (record.pty !== pty) return
        record.pty = undefined
        record.terminal = { ...record.terminal, status: 'exited', exitCode }
        this.publish(record)
      }))
      this.publish(record)
    } catch (error) {
      this.kill(record)
      record.terminal = { ...record.terminal, status: 'unavailable', exitCode: null }
      this.publish(record)
      if (error instanceof Error && 'code' in error) throw error
      return fail('unavailable', 'The terminal could not start. Check that the shell and the command are available.')
    } finally { record.starting = false }
  }

  private append(record: LiveTerminal, chunk: string): void {
    record.output = (record.output + chunk).slice(-TERMINAL_MAX_OUTPUT)
    if (/^[\uDC00-\uDFFF]/.test(record.output)) record.output = record.output.slice(1)
    record.sequence++
    this.dependencies.emit({ type: 'output', id: record.terminal.id, data: chunk, sequence: record.sequence })
  }

  read(payload: unknown) { return this.run(async () => this.snapshot(await this.owned(parse(workspaceTerminalRequestSchema, payload).id))) }
  write(payload: unknown) { return this.run(async () => {
    const request = parse(workspaceTerminalWriteSchema, payload)
    const record = await this.owned(request.id)
    if (!record.pty) return fail('not-running', 'This terminal has exited. Restart it to run the command again.')
    record.pty.write(request.data)
  }) }
  resize(payload: unknown) { return this.run(async () => {
    const request = parse(workspaceTerminalResizeSchema, payload)
    const record = await this.owned(request.id)
    record.terminal = { ...record.terminal, cols: request.cols, rows: request.rows }
    if (!record.pty) return
    record.pty.resize(request.cols, request.rows)
    this.publish(record)
  }) }
  interrupt(payload: unknown) { return this.run(async () => {
    const record = await this.owned(parse(workspaceTerminalRequestSchema, payload).id)
    if (!record.pty) return fail('not-running', 'This terminal has exited.')
    record.pty.write('\x03')
  }) }
  stop(payload: unknown) { return this.run(async () => {
    const record = await this.owned(parse(workspaceTerminalRequestSchema, payload).id)
    if (!record.pty) return fail('not-running', 'This terminal has already exited.')
    this.end(record)
    this.publish(record)
  }) }
  /** The same command again in the same folder; a running process is ended first. */
  restart(payload: unknown) { return this.run(async () => {
    const record = await this.owned(parse(workspaceTerminalRequestSchema, payload).id)
    if (record.starting) return fail('busy', 'This terminal is already starting.')
    this.end(record)
    await this.start(record, await this.launcher(record.terminal.launch))
    return this.snapshot(record)
  }) }
  close(payload: unknown) { return this.run(async () => {
    const record = await this.owned(parse(workspaceTerminalRequestSchema, payload).id)
    this.end(record)
    record.terminal = { ...record.terminal, closedAt: this.now() }
    this.publish(record)
  }) }
  pasteImage(payload: unknown) { return this.run(async () => {
    const request = parse(workspaceTerminalImageSchema, payload)
    const record = await this.owned(request.id)
    if (!record.pty) return fail('not-running', 'This terminal has exited.')
    const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/u.exec(request.dataUrl)
    const bytes = match ? Buffer.from(match[1]!, 'base64') : null
    if (!bytes || bytes.length > TERMINAL_IMAGE_MAX_BYTES || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return fail('invalid-request', 'Only a PNG image up to 10 MiB can be pasted into a terminal.')
    const folder = join(record.terminal.workingDirectory, '.sotto', 'clipboard')
    // <timestamp>.png, to the millisecond; a second paste in the same millisecond counts up.
    const stamp = new Date(this.now()).toISOString().replace(/[-:]/gu, '').replace('T', '-').replace('.', '-').replace(/Z$/u, '')
    let path = join(folder, `${stamp}.png`)
    try {
      await mkdir(folder, { recursive: true })
      // The images are for pasting, not for committing.
      await writeFile(join(folder, '.gitignore'), '*\n', { flag: 'wx' }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error })
      for (let attempt = 2; ; attempt += 1) {
        try { await writeFile(path, bytes, { flag: 'wx' }); break }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || attempt > 100) throw error; path = join(folder, `${stamp}-${attempt}.png`) }
      }
    } catch { return fail('path-unavailable', 'The image could not be saved under this folder.') }
    record.pty.write(/\s/u.test(path) ? `"${path}"` : path)
    return { path }
  }) }

  /** Ends the process; the record and its output stay. A process ended here has no exit code of its own. */
  private end(record: LiveTerminal): void {
    const running = record.pty !== undefined
    this.kill(record)
    if (running) record.terminal = { ...record.terminal, status: 'exited', exitCode: null }
  }
  private kill(record: LiveTerminal): void {
    const pty = record.pty; record.pty = undefined
    for (const subscription of record.subscriptions.splice(0)) subscription.dispose()
    try { pty?.kill() } catch { /* Already exited. */ }
  }
  dispose(): void {
    this.disposed = true
    for (const record of this.terminals.values()) this.kill(record)
  }
}
