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

interface LiveTerminal {
  terminal: WorkspaceTerminal
  pty?: IPty | undefined
  starting?: boolean
  /** The work still owed to a published terminal: its checkout, its process, its branch. Never rejects. */
  ready?: Promise<void> | undefined
  output: string
  sequence: number
  subscriptions: { dispose(): void }[]
}

interface Launcher { readonly file: string; readonly args: string[]; readonly command: string }
type SpawnProcess = (file: string, args: string[], options: IPtyForkOptions) => IPty
/** `discovered` marks a shell found by scanning PATH: only that one can disappear under the cache. */
interface ResolvedShell { readonly path: string; readonly discovered: boolean }

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
  private cachedShell: ResolvedShell | null = null
  private shellLookup: Promise<ResolvedShell> | null = null
  private spawnLoad: Promise<SpawnProcess> | null = null
  constructor(private readonly dependencies: TerminalWorkspaceDependencies) {
    super()
    this.warm()
  }
  /** Pays for the shell lookup and for loading node-pty once, before the first terminal is asked for. */
  private warm(): void {
    void this.shellFor().catch(() => { /* Reported when a terminal actually starts. */ })
    void this.spawner().catch(() => { /* Reported when a terminal actually starts. */ })
  }
  private now(): number { return this.dependencies.now?.() ?? Date.now() }
  private publish(record: LiveTerminal): void { this.dependencies.emit({ type: 'terminal', terminal: { ...record.terminal } }) }
  private snapshot(record: LiveTerminal): WorkspaceTerminalSnapshot { return { terminal: { ...record.terminal }, output: record.output, sequence: record.sequence } }
  /** The terminal, once its startup has landed: an operation on a starting terminal waits for its process. */
  private async owned(id: string, wait = true): Promise<LiveTerminal> {
    const record = this.terminals.get(id)
    if (!record || this.disposed) return fail('session-unavailable', 'This terminal is no longer available.')
    if (wait) await record.ready
    if (this.disposed) return fail('session-unavailable', 'This terminal is no longer available.')
    return record
  }

  list() { return this.run(async () => {
    return { terminals: [...this.terminals.values()].map(record => ({ ...record.terminal })), shell: shellName(await this.shellFor()) }
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
        // Allocation only reserves the folder and the branch; the checkout itself happens after the terminal exists.
        worktree = await this.dependencies.worktrees.allocate(project.path, 'independent')
        workingDirectory = worktree.path ?? project.path
      }
    } catch (error) {
      return fail('workspace-unavailable', error instanceof Error ? error.message : 'The working folder could not be prepared.')
    }
    const launcher = await this.launcher(request.launch)
    const record: LiveTerminal = {
      terminal: {
        id: randomUUID(), projectId: project.id, title: request.title, launch: request.launch, workingCopy: worktree?.mode ?? 'shared', ...(worktree ? { worktree } : {}),
        workingDirectory, branch: null, command: launcher.command, status: 'starting', cols: request.cols ?? 80, rows: request.rows ?? 24, exitCode: null, openedAt: this.now(), closedAt: null,
      },
      output: '', sequence: 0, subscriptions: [],
    }
    this.terminals.set(record.terminal.id, record)
    // The renderer gets the terminal here; the checkout, the process and the branch arrive as further events.
    this.publish(record)
    record.ready = this.begin(record, launcher, worktree)
    return this.snapshot(record)
  }) }

  /** Everything a published terminal still owes: its checkout, its process, its branch. Each lands with its own event. */
  private async begin(record: LiveTerminal, launcher: Launcher, worktree: AgentWorktree | undefined): Promise<void> {
    if (worktree) {
      try {
        const ready = await this.dependencies.worktrees.ensure(worktree)
        const workingDirectory = await this.dependencies.worktrees.workingDirectory(ready)
        if (!this.terminals.has(record.terminal.id) || this.disposed) return
        record.terminal = { ...record.terminal, worktree: ready, workingDirectory }
        this.publish(record)
      } catch {
        // The folder never appeared, so nothing can run in it; the pane says the command could not start.
        record.terminal = { ...record.terminal, status: 'unavailable' }
        this.publish(record)
        return
      }
    }
    await Promise.all([
      // start() publishes its own failure; open has already returned, so nobody is left to throw to.
      this.start(record, launcher).catch(() => { /* Published as unavailable. */ }),
      this.track(record),
    ])
  }

  /** The branch under the terminal, looked up beside the spawn and published when it lands. */
  private async track(record: LiveTerminal): Promise<void> {
    const branch = await this.branch(record.terminal.workingDirectory)
    if (branch === null || this.disposed || !this.terminals.has(record.terminal.id)) return
    record.terminal = { ...record.terminal, branch }
    this.publish(record)
  }

  private async branch(directory: string): Promise<string | null> {
    if (!this.dependencies.git) return null
    try { return (await this.dependencies.git(directory, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim() || null } catch { return null }
  }

  /**
   * The shell, resolved once for the session: PATH is scanned for the first terminal and not again, unless the shell
   * it found has since disappeared.
   */
  private async shellFor(): Promise<string> {
    const cached = this.cachedShell
    if (cached && (!cached.discovered || await this.exists(cached.path))) return cached.path
    this.cachedShell = null
    const lookup = this.shellLookup ??= this.shell().finally(() => { this.shellLookup = null })
    const found = await lookup
    this.cachedShell = found
    return found.path
  }

  private exists(path: string): Promise<boolean> {
    const check = this.dependencies.executableExists ?? (async (target: string) => { try { await access(target); return true } catch { return false } })
    return check(path)
  }

  /** The shell for this platform: pwsh when installed, else Windows PowerShell; the login shell elsewhere. */
  private async shell(): Promise<ResolvedShell> {
    const platform = this.dependencies.platform ?? process.platform
    const env = this.environment(platform)
    if (platform !== 'win32') return { path: env.SHELL || (platform === 'darwin' ? '/bin/zsh' : '/bin/sh'), discovered: false }
    for (const entry of (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean)) {
      const candidate = join(entry, 'pwsh.exe')
      if (await this.exists(candidate)) return { path: candidate, discovered: true }
    }
    return { path: join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), discovered: false }
  }

  /** node-pty, imported once for the session; the injected spawn stands in for it under test. */
  private spawner(): Promise<SpawnProcess> {
    const injected = this.dependencies.spawn
    if (injected) return Promise.resolve(injected)
    this.spawnLoad ??= import('node-pty').then(module => module.spawn, (error: unknown) => { this.spawnLoad = null; throw error })
    return this.spawnLoad
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
    const shell = await this.shellFor()
    const argv = providerCommand({ provider: launch.provider, model: launch.modelId === null ? null : nativeModelName(launch.modelId), reasoning: launch.reasoning, permission: launch.permission })
    if (argv.length === 0) return { file: shell, args: platform === 'win32' ? ['-NoLogo'] : ['-l'], command: shellName(shell) }
    const command = commandLine(argv)
    if (platform === 'win32') return { file: shell, args: ['-NoLogo', '-Command', `& ${argv.map(powerShellQuote).join(' ')}`], command }
    return { file: shell, args: ['-l', '-i', '-c', `exec ${argv.map(posixQuote).join(' ')}`], command }
  }

  private async start(record: LiveTerminal, launcher: Launcher): Promise<void> {
    const platform = this.dependencies.platform ?? process.platform
    const env = this.environment(platform)
    record.starting = true
    try {
      const spawn = await this.spawner()
      if (this.disposed) return fail('unavailable', 'Terminal is shutting down.')
      record.output = ''
      record.sequence = 0
      // The size is read here, not before the await: a pane that measured itself while the terminal started already said so.
      const { cols, rows } = record.terminal
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
    // A size never waits for the process: a terminal still starting spawns at the size its pane already measured.
    const record = await this.owned(request.id, false)
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
