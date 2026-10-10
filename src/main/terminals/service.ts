import { randomUUID } from 'node:crypto'
import { basename, win32 as win32Path } from 'node:path'
import type { IPty, IPtyForkOptions } from 'node-pty'
import type { AgentProject, AgentWorktree } from '../../shared/agents'
import type { ToolsResult } from '../../shared/tools'
import { TERMINAL_MAX_OUTPUT } from '../../shared/terminal'
import { commandLine, nativeModelName, providerCommand } from '../../shared/terminalCommands'
import {
  TERMINALS_MAX, terminalOpenSchema, workspaceTerminalImageSchema, workspaceTerminalRequestSchema, workspaceTerminalResizeSchema, workspaceTerminalVisibilitySchema, workspaceTerminalWriteSchema,
  type TerminalLaunch, type WorkspaceTerminal, type WorkspaceTerminalEvent, type WorkspaceTerminalSnapshot,
} from '../../shared/terminalWorkspace'
import { checkoutIdentity, type RunGit, type ThreadWorktrees } from '../agents/threadWorktrees'
import { ToolOperations, fail, parse } from '../tools/common'
import { saveTerminalImage, terminalImageInput } from './clipboard'
import { TerminalShell } from './shell'
import { prepareTerminalAgentHooks, type PreparedTerminalAgentHooks } from './hooks'
import { TerminalAgentStateMachine } from './state'

export interface TerminalWorkspaceDependencies {
  projects: () => readonly AgentProject[]
  worktrees: Pick<ThreadWorktrees, 'allocate' | 'ensure' | 'workingDirectory' | 'reclaim'>
  emit(event: WorkspaceTerminalEvent): void
  /** Best-effort Git for the branch shown under a terminal; failures leave it blank. */
  git?: RunGit
  spawn?: (file: string, args: string[], options: IPtyForkOptions) => IPty
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  executableExists?: (path: string) => Promise<boolean>
  /** Holds the desktop's checkout while proving that no thread or Tools/drawer shell still uses it. */
  acquireReclaim?: (directory: string) => Promise<() => void>
  now?: () => number
  /** Injection for state/lifecycle tests; production uses the packaged run-only helper. */
  prepareHooks?: typeof prepareTerminalAgentHooks
}

interface LiveTerminal {
  terminal: WorkspaceTerminal
  pty?: IPty | undefined
  starting?: boolean
  /** A lifecycle reservation: Close or a newer start invalidates work still awaiting its launcher/checkout. */
  generation: number
  /** The work still owed to a published terminal: its checkout, its process, its branch. Never rejects. */
  ready?: Promise<void> | undefined
  /** Folder preparation belongs to the terminal, so Reopen can await work begun by an earlier process lifecycle. */
  folder?: Promise<{ worktree: AgentWorktree; workingDirectory: string }> | undefined
  /** Restart waits for removal, then ensures the checkout again on its retained branch. */
  reclaiming?: Promise<void> | undefined
  output: string
  sequence: number
  subscriptions: { dispose(): void }[]
  agent?: TerminalAgentStateMachine | undefined
  hooks?: PreparedTerminalAgentHooks | undefined
  activityTimer?: ReturnType<typeof setTimeout> | undefined
}

interface Launcher { readonly file: string; readonly args: string[]; readonly command: string }
type SpawnProcess = (file: string, args: string[], options: IPtyForkOptions) => IPty


const shellName = (path: string, platform: NodeJS.Platform): string =>
  (platform === 'win32' ? win32Path.basename(path) : basename(path)).replace(/\.exe$/iu, '')
const posixQuote = (token: string): string => `'${token.replace(/'/gu, `'\\''`)}'`
const powerShellQuote = (token: string): string => `'${token.replace(/['\u2018-\u201b]/gu, quote => quote + quote)}'`

/**
 * Terminals of Terminal mode: each belongs to a project folder (or a worktree Sotto made for it) and runs either a
 * plain shell or a provider CLI with the flags the dialog chose. Main owns the PTYs for the session; nothing is kept
 * across a restart of Sotto.
 */
export class TerminalWorkspaceService extends ToolOperations {
  private readonly terminals = new Map<string, LiveTerminal>()
  private readonly reclaimingCheckouts = new Set<string>()
  private readonly shell: TerminalShell
  private spawnLoad: Promise<SpawnProcess> | null = null
  private readonly visibleClients = new Map<object, { ids: ReadonlySet<string>; active: () => boolean }>()
  private readonly defaultVisibilityClient = {}
  private readonly inputLanes = new Map<string, Promise<unknown>>()
  constructor(private readonly dependencies: TerminalWorkspaceDependencies) {
    super()
    this.shell = new TerminalShell(dependencies)
    this.warm()
  }
  /** Pays for the shell lookup and for loading node-pty once, before the first terminal is asked for. */
  private warm(): void {
    void this.shell.resolve().catch(() => { /* Reported when a terminal actually starts. */ })
    void this.spawner().catch(() => { /* Reported when a terminal actually starts. */ })
  }
  private now(): number { return this.dependencies.now?.() ?? Date.now() }
  private publish(record: LiveTerminal): void { this.dependencies.emit({ type: 'terminal', terminal: { ...record.terminal } }) }
  private snapshot(record: LiveTerminal): WorkspaceTerminalSnapshot { return { terminal: { ...record.terminal }, output: record.output, sequence: record.sequence } }
  private syncAgent(record: LiveTerminal): void {
    if (!record.agent || this.disposed) return
    const agentState = record.agent.state, stateDetection = record.agent.compatibility
    if (record.terminal.agentState === agentState && record.terminal.stateDetection === stateDetection) return
    record.terminal = { ...record.terminal, agentState, stateDetection }
    this.publish(record)
  }
  private isVisible(id: string): boolean { return [...this.visibleClients.values()].some(client => client.ids.has(id) && client.active()) }
  /** Trusted clients publish panes, not selection. The desktop IPC supplies an actual-window predicate. */
  visibility(payload: unknown, client: object = this.defaultVisibilityClient, active: () => boolean = () => true) { return this.run(async () => {
    const { ids } = parse(workspaceTerminalVisibilitySchema, payload)
    this.visibleClients.set(client, { ids: new Set(ids), active })
    this.refreshVisibility()
  }) }
  refreshVisibility(): void {
    for (const record of this.terminals.values()) { record.agent?.setVisible(this.isVisible(record.terminal.id)); this.syncAgent(record) }
  }
  withdrawVisibility(client: object): void { this.visibleClients.delete(client); this.refreshVisibility() }
  private requireCapacity(): void {
    if ([...this.terminals.values()].filter(record => record.terminal.closedAt === null).length >= TERMINALS_MAX) return fail('busy', `Close a terminal before opening another (${TERMINALS_MAX} maximum).`)
  }
  /** The terminal, once its startup has landed: an operation on a starting terminal waits for its process. */
  private async owned(id: string, wait = true): Promise<LiveTerminal> {
    const record = this.terminals.get(id)
    if (!record || this.disposed) return fail('session-unavailable', 'This terminal is no longer available.')
    if (wait) await record.ready
    if (this.disposed) return fail('session-unavailable', 'This terminal is no longer available.')
    return record
  }

  list() { return this.run(async () => {
    return { terminals: [...this.terminals.values()].map(record => ({ ...record.terminal })), shell: shellName(await this.shell.resolve(), this.dependencies.platform ?? process.platform) }
  }) }

  open(payload: unknown) { return this.run(async () => {
    const request = parse(terminalOpenSchema, payload)
    if (this.disposed) return fail('unavailable', 'Terminal is shutting down.')
    this.requireCapacity()
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
    if (this.disposed) return fail('unavailable', 'Terminal is shutting down.')
    // Other opens may have filled the last slot while the folder or launcher was being prepared.
    this.requireCapacity()
    const record: LiveTerminal = {
      terminal: {
        id: randomUUID(), projectId: project.id, title: request.title, launch: request.launch, workingCopy: worktree?.mode ?? 'shared', ...(worktree ? { worktree } : {}),
        workingDirectory, branch: null, command: launcher.command, status: 'starting', cols: request.cols ?? 80, rows: request.rows ?? 24, exitCode: null, openedAt: this.now(), closedAt: null,
        ...(request.launch.provider ? { agentState: 'starting' as const, stateDetection: 'available' as const } : {}),
      },
      output: '', sequence: 0, subscriptions: [], generation: 0,
    }
    this.terminals.set(record.terminal.id, record)
    // The renderer gets the terminal here; the checkout, the process and the branch arrive as further events.
    this.publish(record)
    record.ready = this.begin(record, launcher, record.generation)
    return this.snapshot(record)
  }) }

  /** Everything a published terminal still owes: its checkout, its process, its branch. Each lands with its own event. */
  private async begin(record: LiveTerminal, launcher: Launcher, generation: number): Promise<void> {
    try { await this.prepareFolder(record, generation) } catch {
      if (generation !== record.generation || this.disposed) return
      // The folder never appeared, so nothing can run in it; the pane says the command could not start.
      record.terminal = { ...record.terminal, status: 'unavailable', ...(record.terminal.launch.provider ? { agentState: 'exited' as const } : {}) }
      this.publish(record)
      return
    }
    await Promise.all([
      // start() publishes its own failure; open has already returned, so nobody is left to throw to.
      this.start(record, launcher, generation).catch(() => { /* Published as unavailable unless cancelled. */ }),
      this.track(record, generation),
    ])
  }

  private async prepareFolder(record: LiveTerminal, generation: number): Promise<void> {
    if (this.disposed || generation !== record.generation) return fail('session-unavailable', 'This terminal was closed before it could start.')
    const worktree = record.terminal.worktree
    if (!worktree) return
    record.folder ??= (async () => {
      const ready = await this.dependencies.worktrees.ensure(worktree)
      return { worktree: ready, workingDirectory: await this.dependencies.worktrees.workingDirectory(ready) }
    })().catch((error: unknown) => { record.folder = undefined; throw error })
    const folder = await record.folder
    if (this.disposed || generation !== record.generation) return fail('session-unavailable', 'This terminal was closed before it could start.')
    record.terminal = { ...record.terminal, ...folder }
    this.publish(record)
  }

  /** The branch under the terminal, looked up beside the spawn and published when it lands. */
  private async track(record: LiveTerminal, generation: number): Promise<void> {
    const branch = await this.branch(record.terminal.workingDirectory)
    if (branch === null || this.disposed || generation !== record.generation) return
    record.terminal = { ...record.terminal, branch }
    this.publish(record)
  }

  private async branch(directory: string): Promise<string | null> {
    if (!this.dependencies.git) return null
    try { return (await this.dependencies.git(directory, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim() || null } catch { return null }
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
  private async launcher(launch: TerminalLaunch, hookArgs: string[] = [], exitArgs: string[] = []): Promise<Launcher> {
    const platform = this.dependencies.platform ?? process.platform
    const shell = await this.shell.resolve()
    const argv = providerCommand({ provider: launch.provider, model: launch.modelId === null ? null : nativeModelName(launch.modelId), reasoning: launch.reasoning, permission: launch.permission })
    if (argv.length === 0) return { file: shell, args: platform === 'win32' ? ['-NoLogo'] : ['-l'], command: shellName(shell, platform) }
    const command = commandLine(argv)
    argv.push(...hookArgs)
    const reportExit = exitArgs.length ? `${platform === 'win32' ? '& ' : ''}${exitArgs.map(platform === 'win32' ? powerShellQuote : posixQuote).join(' ')}; ` : ''
    const exitMessage = `${launch.provider} exited with code`
    if (platform === 'win32') return { file: shell, args: ['-NoLogo', '-NoExit', '-Command',
      `$global:LASTEXITCODE = 0; & ${argv.map(powerShellQuote).join(' ')}; if ($?) { $sottoExitCode = 0 } else { $sottoExitCode = $LASTEXITCODE; if (!$sottoExitCode) { $sottoExitCode = 1 } }; Write-Host ("\`n${exitMessage} {0}." -f $sottoExitCode); ${reportExit}`,
    ], command }
    const run = argv.map(posixQuote).join(' ')
    const report = shellName(shell, platform) === 'fish'
      ? `set sotto_exit $status; printf '\\n${exitMessage} %s.\\n' $sotto_exit`
      : `sotto_exit=$?; printf '\\n${exitMessage} %s.\\n' "$sotto_exit"`
    return { file: shell, args: ['-l', '-i', '-c', `${run}; ${report}; ${reportExit}exec ${posixQuote(shell)} -l`], command }
  }

  private async start(record: LiveTerminal, launcher: Launcher, generation: number): Promise<void> {
    if (generation !== record.generation) return fail('session-unavailable', 'This terminal was closed before it could start.')
    const platform = this.dependencies.platform ?? process.platform
    const env = this.environment(platform)
    record.starting = true
    try {
      const spawn = await this.spawner()
      if (this.disposed) return fail('unavailable', 'Terminal is shutting down.')
      if (generation !== record.generation) return fail('session-unavailable', 'This terminal was closed before it could start.')
      if (this.reclaimingCheckouts.size && this.reclaimingCheckouts.has(await checkoutIdentity(record.terminal.workingDirectory))) return fail('workspace-unavailable', 'This folder is being reclaimed. Wait for Close to finish before opening a terminal here.')
      if (this.disposed || generation !== record.generation) return fail('session-unavailable', 'This terminal was closed before it could start.')
      // A closed row rejoins the active set only here, without an await between the check and the change.
      if (record.terminal.closedAt !== null) this.requireCapacity()
      if (record.terminal.launch.provider) {
        const provider = record.terminal.launch.provider
        try {
          const hooks = await (this.dependencies.prepareHooks ?? prepareTerminalAgentHooks)({
            terminalId: record.terminal.id, provider,
            onEvent: event => {
              if (this.disposed || generation !== record.generation || !record.agent || record.agent.state === 'exited' || event.runId !== record.agent.runId) return
              if (event.kind === 'process-exited') { this.releaseAgentRun(record); this.syncAgent(record); return }
              record.agent.setVisible(this.isVisible(record.terminal.id)); record.agent.hook(event); this.syncAgent(record)
            },
            onRequestClosed: requestId => { if (!this.disposed && generation === record.generation) { record.agent?.requestClosed(requestId); this.syncAgent(record) } },
            onUnavailable: () => { if (!this.disposed && generation === record.generation) { record.agent?.unavailable(); this.syncAgent(record) } },
          })
          if (this.disposed || generation !== record.generation) { hooks.dispose(); return }
          record.hooks = hooks
          Object.assign(env, hooks.env)
          launcher = await this.launcher(record.terminal.launch, hooks.args, hooks.exitArgs)
        } catch { /* A missing helper never prevents the native CLI; use the conservative screen fallback. */ }
        if (this.disposed || generation !== record.generation) { record.hooks?.dispose(); record.hooks = undefined; return }
        record.agent = new TerminalAgentStateMachine(record.hooks?.runId ?? randomUUID(), provider, record.terminal.cols, record.terminal.rows, record.hooks?.providerSessionId)
        record.agent.setVisible(this.isVisible(record.terminal.id))
      }
      if (record.terminal.closedAt !== null) this.requireCapacity()
      record.output = ''
      record.sequence = 0
      // The size is read here, not before the await: a pane that measured itself while the terminal started already said so.
      const { cols, rows } = record.terminal
      record.terminal = { ...record.terminal, status: 'running', exitCode: null, closedAt: null }
      const pty = spawn(launcher.file, launcher.args, { cwd: record.terminal.workingDirectory, cols, rows, env, name: 'xterm-256color' })
      record.pty = pty
      record.agent?.started()
      this.append(record, `\x1b[2mOpened by Sotto at ${record.terminal.workingDirectory} · ${launcher.command}\x1b[0m\r\n`)
      record.subscriptions.push(pty.onData(data => {
        if (record.pty !== pty || this.disposed) return
        record.agent?.setVisible(this.isVisible(record.terminal.id))
        record.agent?.output(data)
        this.syncAgent(record)
        if (record.agent) {
          clearTimeout(record.activityTimer)
          record.activityTimer = setTimeout(() => { if (record.pty !== pty || this.disposed) return; record.agent?.quiet(); this.syncAgent(record) }, 4000)
          record.activityTimer.unref()
        }
        for (let offset = 0; offset < data.length;) {
          let end = Math.min(offset + 65536, data.length)
          if (end < data.length && /[\uD800-\uDBFF]/.test(data[end - 1]!)) end--
          this.append(record, data.slice(offset, end))
          offset = end
        }
      }), pty.onExit(({ exitCode }) => {
        if (record.pty !== pty) return
        record.pty = undefined
        this.releaseAgentRun(record)
        record.terminal = { ...record.terminal, status: 'exited', exitCode }
        if (record.agent) record.terminal = { ...record.terminal, agentState: record.agent.state, stateDetection: record.agent.compatibility }
        this.publish(record)
      }))
      if (record.agent) record.terminal = { ...record.terminal, agentState: record.agent.state, stateDetection: record.agent.compatibility }
      if (!this.disposed) this.publish(record)
    } catch (error) {
      if (this.disposed || generation !== record.generation) throw error
      if (record.terminal.closedAt !== null && error instanceof Error && 'code' in error && error.code === 'busy') {
        record.hooks?.dispose(); record.hooks = undefined; record.agent?.exit(); record.agent = undefined
        throw error
      }
      this.kill(record)
      record.terminal = { ...record.terminal, status: 'unavailable', exitCode: null, ...(record.terminal.launch.provider ? { agentState: 'exited' as const } : {}) }
      this.publish(record)
      if (error instanceof Error && 'code' in error) throw error
      return fail('unavailable', 'The terminal could not start. Check that the shell and the command are available.')
    } finally { if (generation === record.generation) record.starting = false }
  }

  private append(record: LiveTerminal, chunk: string): void {
    record.output = (record.output + chunk).slice(-TERMINAL_MAX_OUTPUT)
    if (/^[\uDC00-\uDFFF]/.test(record.output)) record.output = record.output.slice(1)
    record.sequence++
    this.dependencies.emit({ type: 'output', id: record.terminal.id, data: chunk, sequence: record.sequence })
  }

  read(payload: unknown) { return this.run(async () => this.snapshot(await this.owned(parse(workspaceTerminalRequestSchema, payload).id))) }
  private input<T>(id: string, action: () => Promise<T>): Promise<ToolsResult<T>> {
    const previous = this.inputLanes.get(id) ?? Promise.resolve()
    const pending = previous.then(() => this.run(action))
    this.inputLanes.set(id, pending)
    void pending.then(() => { if (this.inputLanes.get(id) === pending) this.inputLanes.delete(id) })
    return pending
  }
  write(payload: unknown) {
    const parsed = workspaceTerminalWriteSchema.safeParse(payload)
    if (!parsed.success) return this.run(async () => { parse(workspaceTerminalWriteSchema, payload) })
    const request = parsed.data
    return this.input(request.id, async () => {
    const record = await this.owned(request.id)
    if (!record.pty) return fail('not-running', 'This terminal has exited. Restart it to run the command again.')
    record.agent?.input(request.data); this.syncAgent(record)
    record.pty.write(request.data)
    })
  }
  resize(payload: unknown) { return this.run(async () => {
    const request = parse(workspaceTerminalResizeSchema, payload)
    // A size never waits for the process: a terminal still starting spawns at the size its pane already measured.
    const record = await this.owned(request.id, false)
    record.terminal = { ...record.terminal, cols: request.cols, rows: request.rows }
    record.agent?.resize(request.cols, request.rows); this.syncAgent(record)
    if (!record.pty) return
    record.pty.resize(request.cols, request.rows)
    this.publish(record)
  }) }
  interrupt(payload: unknown) { return this.run(async () => {
    const record = await this.owned(parse(workspaceTerminalRequestSchema, payload).id)
    if (!record.pty) return fail('not-running', 'This terminal has exited.')
    record.agent?.input('\x03'); this.syncAgent(record)
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
    const record = await this.owned(parse(workspaceTerminalRequestSchema, payload).id, false)
    if (record.starting || record.terminal.status === 'starting') return fail('busy', 'This terminal is already starting.')
    const preparation = record.ready
    record.starting = true
    const previousTerminal = record.terminal
    const generation = ++record.generation
    this.end(record)
    record.agent = undefined
    record.terminal = { ...record.terminal, ...(record.terminal.launch.provider ? { agentState: 'starting' as const, stateDetection: 'available' as const } : {}) }
    const restarting = (async () => {
      try {
        await record.reclaiming
        // A running shell may still owe its first branch read; retain that debt across Restart.
        await preparation
        const launcher = await this.launcher(record.terminal.launch)
        await this.prepareFolder(record, generation)
        await this.start(record, launcher, generation)
        await this.track(record, generation)
        return this.snapshot(record)
      } catch (error) {
        if (record.terminal.closedAt !== null && error instanceof Error && 'code' in error && error.code === 'busy') { record.terminal = previousTerminal; throw error }
        // Launcher failures happen before start() can publish them. A superseded lifecycle owns no state.
        if (!this.disposed && generation === record.generation && record.terminal.status !== 'unavailable') {
          this.kill(record)
          record.terminal = { ...record.terminal, status: 'unavailable', exitCode: null, ...(record.terminal.launch.provider ? { agentState: 'exited' as const } : {}) }
          this.publish(record)
        }
        throw error
      } finally { if (generation === record.generation) record.starting = false }
    })()
    record.ready = restarting.then(() => undefined, () => undefined)
    return restarting
  }) }
  close(payload: unknown) { return this.run(async () => {
    const record = await this.owned(parse(workspaceTerminalRequestSchema, payload).id, false)
    const preparation = record.ready
    ++record.generation
    record.starting = false
    record.ready = undefined
    this.end(record)
    record.terminal = { ...record.terminal, closedAt: this.now(), status: record.terminal.status === 'starting' ? 'exited' : record.terminal.status, ...(record.terminal.launch.provider ? { agentState: 'exited' as const } : {}) }
    record.output = ''
    this.publish(record)
    // Close remains immediate while a checkout still starts; removal waits for that owned preparation.
    record.reclaiming ??= this.reclaim(record, preparation).finally(() => { record.reclaiming = undefined })
  }) }

  private async reclaim(record: LiveTerminal, preparation: Promise<void> | undefined): Promise<void> {
    const metadata = record.terminal.worktree
    if (!metadata || metadata.mode !== 'independent' || metadata.reused) return
    try {
      await preparation
      const prepared = await record.folder
      // A Reopen that overtook preparation owns the folder again. Never remove it under a new process.
      if (record.terminal.closedAt === null || record.pty || this.disposed) return
      const owner = prepared?.worktree ?? record.terminal.worktree
      if (!owner || owner.mode !== 'independent' || owner.reused || owner.reclaimedAt) return
      const release = await this.dependencies.acquireReclaim?.(owner.path!)
      let identity: string | undefined
      let reserved = false
      try {
        identity = await checkoutIdentity(owner.path!)
        if (this.reclaimingCheckouts.has(identity)) return
        this.reclaimingCheckouts.add(identity)
        reserved = true
        for (const other of this.terminals.values()) {
          if (other === record || other.terminal.closedAt !== null && !other.starting) continue
          if (await checkoutIdentity(other.terminal.workingDirectory) === identity) return
        }
        const worktree = await this.dependencies.worktrees.reclaim(owner, { automatic: true })
        record.terminal = { ...record.terminal, worktree }
        if (!this.disposed) this.publish(record)
      } finally { if (identity && reserved) this.reclaimingCheckouts.delete(identity); release?.() }
    } catch { /* Dirty, ignored, reused, locked or replaced folders stay; Close approves no loss. */ }
    finally { record.folder = undefined }
  }
  pasteImage(payload: unknown) {
    const parsed = workspaceTerminalImageSchema.safeParse(payload)
    if (!parsed.success) return this.run(async () => { parse(workspaceTerminalImageSchema, payload); return { path: '' } })
    const request = parsed.data
    return this.input(request.id, async () => {
    const record = await this.owned(request.id)
    if (!record.pty) return fail('not-running', 'This terminal has exited.')
    const pty = record.pty
    const path = await saveTerminalImage(record.terminal.workingDirectory, request.dataUrl, this.now())
    await this.owned(request.id)
    if (record.pty !== pty) return fail('not-running', 'The image was saved, but this terminal has exited. Paste it again in the restarted terminal.')
    record.pty.write(terminalImageInput(path, this.dependencies.platform ?? process.platform))
    return { path }
    })
  }

  /** Ends the process; the record and its output stay. A process ended here has no exit code of its own. */
  private end(record: LiveTerminal): void {
    const running = record.pty !== undefined
    this.kill(record)
    if (running) record.terminal = { ...record.terminal, status: 'exited', exitCode: null, ...(record.agent ? { agentState: 'exited' as const } : {}) }
  }
  private kill(record: LiveTerminal): void {
    const pty = record.pty; record.pty = undefined
    this.releaseAgentRun(record)
    for (const subscription of record.subscriptions.splice(0)) subscription.dispose()
    try { pty?.kill() } catch { /* Already exited. */ }
  }
  private releaseAgentRun(record: LiveTerminal): void {
    record.agent?.exit(); record.hooks?.dispose(); record.hooks = undefined; clearTimeout(record.activityTimer)
  }
  dispose(): void {
    this.disposed = true
    for (const record of this.terminals.values()) { ++record.generation; record.starting = false; record.ready = undefined; this.kill(record) }
  }
}
