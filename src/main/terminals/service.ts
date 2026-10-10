import { createHash, randomUUID } from 'node:crypto'
import { access, mkdir, writeFile } from 'node:fs/promises'
import { basename, join, win32 as win32Path } from 'node:path'
import type { IPty, IPtyForkOptions } from 'node-pty'
import type { AgentProject, AgentWorktree } from '../../shared/agents'
import { TERMINAL_MAX_OUTPUT } from '../../shared/terminal'
import { commandLine, nativeModelName, providerCommand } from '../../shared/terminalCommands'
import {
  TERMINAL_IMAGE_MAX_BYTES, TERMINALS_MAX, terminalOpenSchema, workspaceTerminalImageSchema, workspaceTerminalRequestSchema, workspaceTerminalResizeSchema, workspaceTerminalVisibilitySchema, workspaceTerminalWriteSchema,
  type TerminalLaunch, type WorkspaceTerminal, type WorkspaceTerminalEvent, type WorkspaceTerminalSnapshot,
} from '../../shared/terminalWorkspace'
import type { RunGit, ThreadWorktrees } from '../agents/threadWorktrees'
import { ToolFailure, ToolOperations, fail, parse } from '../tools/common'
import type { ToolsResult } from '../../shared/tools'
import { prepareTerminalAgentHooks, type PreparedTerminalAgentHooks } from './hooks'
import { TerminalAgentStateMachine } from './state'
import type { PhoneTerminal, PhoneTerminalAnswer, PhoneTerminalApproval, PhoneTerminals } from '../../shared/phoneTerminals'
import type { TerminalAgentHookEvent, TerminalHookAnswer } from './hooks'

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
  output: string
  sequence: number
  subscriptions: { dispose(): void }[]
  agent?: TerminalAgentStateMachine | undefined
  hooks?: PreparedTerminalAgentHooks | undefined
  activityTimer?: ReturnType<typeof setTimeout> | undefined
  plainActive?: boolean
  phonePreviewId?: string | undefined
  approvals?: Map<string, TerminalAgentHookEvent>
  answers?: Map<string, { answer: TerminalHookAnswer; settle(delivered: boolean): void }>
}

interface Launcher { readonly file: string; readonly args: string[]; readonly command: string }
type SpawnProcess = (file: string, args: string[], options: IPtyForkOptions) => IPty
/** `discovered` marks a shell found by scanning PATH: only that one can disappear under the cache. */
interface ResolvedShell { readonly path: string; readonly discovered: boolean }

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const shellName = (path: string, platform: NodeJS.Platform): string =>
  (platform === 'win32' ? win32Path.basename(path) : basename(path)).replace(/\.exe$/iu, '')
const posixQuote = (token: string): string => `'${token.replace(/'/gu, `'\\''`)}'`
const powerShellQuote = (token: string): string => `'${token.replace(/['\u2018-\u201b]/gu, quote => quote + quote)}'`

/**
 * Terminals of Terminal mode: each belongs to a project folder (or a worktree Sotto made for it) and runs either a
 * plain shell or a provider CLI with the flags the dialog chose. Main owns the PTYs for the session; nothing is kept
 * across a restart of Sotto.
 */
export class TerminalWorkspaceService extends ToolOperations implements PhoneTerminals {
  private readonly terminals = new Map<string, LiveTerminal>()
  private cachedShell: ResolvedShell | null = null
  private shellLookup: Promise<ResolvedShell> | null = null
  private spawnLoad: Promise<SpawnProcess> | null = null
  private readonly visibleClients = new Map<object, { ids: ReadonlySet<string>; active: () => boolean }>()
  private readonly defaultVisibilityClient = {}
  private readonly phoneListeners = new Set<() => void>()
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
  private publish(record: LiveTerminal): void {
    record.phonePreviewId = this.phoneApproval(record.terminal.id)?.previewId
    this.dependencies.emit({ type: 'terminal', terminal: { ...record.terminal } })
    this.publishPhoneRows()
  }
  private publishPhoneRows(): void { for (const listener of this.phoneListeners) listener() }
  private snapshot(record: LiveTerminal): WorkspaceTerminalSnapshot { return { terminal: { ...record.terminal }, output: record.output, sequence: record.sequence } }
  private syncAgent(record: LiveTerminal): void {
    if (!record.agent || this.disposed) return
    const agentState = record.agent.state, stateDetection = record.agent.compatibility
    if (record.terminal.agentState === agentState && record.terminal.stateDetection === stateDetection) {
      const previewId = this.phoneApproval(record.terminal.id)?.previewId
      if (record.phonePreviewId !== previewId) { record.phonePreviewId = previewId; this.publishPhoneRows() }
      return
    }
    record.terminal = { ...record.terminal, agentState, stateDetection }
    this.publish(record)
  }
  private isVisible(id: string): boolean { return [...this.visibleClients.values()].some(client => client.ids.has(id) && client.active()) }
  /** Trusted clients publish panes, not selection. The desktop IPC supplies an actual-window predicate. */
  async visibility(payload: unknown, client: object = this.defaultVisibilityClient, active: () => boolean = () => true): Promise<ToolsResult<void>> {
    // Closing a visible pane must take effect even while all eight terminal operations are waiting.
    if (this.disposed) return { ok: false, error: { code: 'unavailable', message: 'This tool has shut down.' } }
    try {
      const { ids } = parse(workspaceTerminalVisibilitySchema, payload)
      this.visibleClients.set(client, { ids: new Set(ids), active })
      this.refreshVisibility()
      return { ok: true, value: undefined }
    } catch (error) {
      return { ok: false, error: error instanceof ToolFailure ? { code: error.code, message: error.message } : { code: 'unavailable', message: 'This tool is unavailable. Refresh and try again.' } }
    }
  }
  refreshVisibility(): void {
    for (const record of this.terminals.values()) { record.agent?.setVisible(this.isVisible(record.terminal.id)); this.syncAgent(record) }
  }
  withdrawVisibility(client: object): void { this.visibleClients.delete(client); this.refreshVisibility() }
  subscribePhoneRows(listener: () => void): () => void { this.phoneListeners.add(listener); return () => this.phoneListeners.delete(listener) }
  private phoneBinding(record: LiveTerminal): TerminalAgentHookEvent | undefined {
    if (!record.pty || record.terminal.launch.provider !== 'claude' || !record.hooks || !record.agent) return undefined
    const requests = [...record.approvals?.values() ?? []].filter(event => event.requestId && record.agent!.hasRequest(event.requestId))
    return requests.length === 1 && !record.answers?.has(requests[0]!.requestId!) ? requests[0] : undefined
  }
  phoneRows(): PhoneTerminal[] {
    if (this.disposed) return []
    return [...this.terminals.values()].filter(record => record.terminal.closedAt === null).map(record => {
      const terminal = record.terminal, preview = this.phoneApproval(terminal.id)
      return { id: terminal.id, projectId: terminal.projectId, title: terminal.title, providerId: terminal.launch.provider,
        state: terminal.agentState ?? (terminal.status === 'starting' ? 'starting' : terminal.status === 'running' ? record.plainActive ? 'working' : 'idle' : 'exited'),
        stateDetection: terminal.stateDetection ?? 'unavailable', openedAt: terminal.openedAt,
        ...(preview ? { approval: { runId: preview.runId, requestId: preview.requestId, approvalId: preview.approvalId, previewId: preview.previewId } } : {}) }
    })
  }
  phoneApproval(terminalId: string): PhoneTerminalApproval | null {
    if (this.disposed) return null
    const record = this.terminals.get(terminalId), request = record && this.phoneBinding(record)
    const lines = request && record?.agent?.approvalLines()
    if (!request || !lines?.length) return null
    const binding = { terminalId, runId: request.runId, requestId: request.requestId!, approvalId: request.approvalId! }
    return { ...binding, lines, previewId: createHash('sha256').update(JSON.stringify({ ...binding, lines })).digest('hex') }
  }
  async answerPhoneApproval(answer: PhoneTerminalAnswer, authorized: () => boolean): Promise<boolean> {
    const preview = this.phoneApproval(answer.terminalId), record = this.terminals.get(answer.terminalId)
    if (!preview || !record?.hooks || preview.runId !== answer.runId || preview.requestId !== answer.requestId ||
      preview.approvalId !== answer.approvalId || preview.previewId !== answer.previewId || !authorized()) return false
    const hookAnswer: TerminalHookAnswer = { terminalId: answer.terminalId, runId: answer.runId, requestId: answer.requestId,
      approvalId: answer.approvalId, decision: answer.decision, answerId: randomUUID() }
    // Reserve the exact request before writing; a competing desktop/phone answer cannot enter while awaiting its ack.
    let settle!: (delivered: boolean) => void
    const delivered = new Promise<boolean>(resolve => { settle = resolve })
    record.answers ??= new Map()
    record.answers.set(answer.requestId, { answer: hookAnswer, settle })
    if (!record.hooks.answer(hookAnswer)) { record.answers.delete(answer.requestId); settle(false) }
    this.publish(record)
    return delivered
  }
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
    return { terminals: [...this.terminals.values()].map(record => ({ ...record.terminal })), shell: shellName(await this.shellFor(), this.dependencies.platform ?? process.platform) }
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
    for (const entry of (env.PATH ?? env.Path ?? '').split(win32Path.delimiter).filter(Boolean)) {
      const candidate = win32Path.join(entry, 'pwsh.exe')
      if (await this.exists(candidate)) return { path: candidate, discovered: true }
    }
    return { path: win32Path.join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), discovered: false }
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
  private async launcher(launch: TerminalLaunch, hookArgs: string[] = []): Promise<Launcher> {
    const platform = this.dependencies.platform ?? process.platform
    const shell = await this.shellFor()
    const argv = providerCommand({ provider: launch.provider, model: launch.modelId === null ? null : nativeModelName(launch.modelId), reasoning: launch.reasoning, permission: launch.permission })
    if (argv.length === 0) return { file: shell, args: platform === 'win32' ? ['-NoLogo'] : ['-l'], command: shellName(shell, platform) }
    const command = commandLine(argv)
    argv.push(...hookArgs)
    if (platform === 'win32') return { file: shell, args: ['-NoLogo', '-Command', `& ${argv.map(powerShellQuote).join(' ')}`], command }
    return { file: shell, args: ['-l', '-i', '-c', `exec ${argv.map(posixQuote).join(' ')}`], command }
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
      // A closed row rejoins the active set only here, without an await between the check and the change.
      if (record.terminal.closedAt !== null) this.requireCapacity()
      if (record.terminal.launch.provider) {
        const provider = record.terminal.launch.provider
        try {
          const hooks = await (this.dependencies.prepareHooks ?? prepareTerminalAgentHooks)({
            terminalId: record.terminal.id, provider,
            onEvent: event => {
              if (this.disposed || generation !== record.generation || !record.agent || record.agent.state === 'exited') return
              record.agent.setVisible(this.isVisible(record.terminal.id)); record.agent.hook(event)
              if (event.kind === 'permission' && event.requestId && event.approvalId && record.agent.hasRequest(event.requestId)) {
                record.approvals ??= new Map(); record.approvals.set(event.requestId, event)
                this.publish(record)
              }
              this.syncAgent(record)
            },
            onRequestClosed: requestId => { if (!this.disposed && generation === record.generation) {
              record.approvals?.delete(requestId); record.answers?.get(requestId)?.settle(false); record.answers?.delete(requestId)
              record.agent?.requestClosed(requestId); this.syncAgent(record); this.publish(record)
            } },
            onAnswerDelivered: answer => {
              const pending = record.answers?.get(answer.requestId)
              if (generation === record.generation && pending?.answer.answerId === answer.answerId) pending.settle(true)
            },
            onUnavailable: () => { if (!this.disposed && generation === record.generation) {
              this.clearApprovals(record); record.agent?.unavailable(); this.syncAgent(record); this.publish(record)
            } },
          })
          if (this.disposed || generation !== record.generation) { hooks.dispose(); return }
          record.hooks = hooks
          Object.assign(env, hooks.env)
          launcher = await this.launcher(record.terminal.launch, hooks.args)
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
        } else {
          if (!record.plainActive) { record.plainActive = true; this.publishPhoneRows() }
          clearTimeout(record.activityTimer)
          record.activityTimer = setTimeout(() => { record.plainActive = false; if (record.pty === pty && !this.disposed) this.publishPhoneRows() }, 4000)
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
      this.publish(record)
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
  write(payload: unknown) { return this.run(async () => {
    const request = parse(workspaceTerminalWriteSchema, payload)
    const record = await this.owned(request.id)
    if (!record.pty) return fail('not-running', 'This terminal has exited. Restart it to run the command again.')
    record.agent?.input(request.data); this.syncAgent(record)
    record.pty.write(request.data)
  }) }
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
    record.starting = true
    const previousTerminal = record.terminal
    const generation = ++record.generation
    this.end(record)
    record.agent = undefined
    record.terminal = { ...record.terminal, ...(record.terminal.launch.provider ? { agentState: 'starting' as const, stateDetection: 'available' as const } : {}) }
    const restarting = (async () => {
      try {
        const launcher = await this.launcher(record.terminal.launch)
        await this.prepareFolder(record, generation)
        await this.start(record, launcher, generation)
        void this.track(record, generation)
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
    ++record.generation
    record.starting = false
    record.ready = undefined
    this.end(record)
    record.terminal = { ...record.terminal, closedAt: this.now(), status: record.terminal.status === 'starting' ? 'exited' : record.terminal.status, ...(record.terminal.launch.provider ? { agentState: 'exited' as const } : {}) }
    record.output = ''
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
    if (running) record.terminal = { ...record.terminal, status: 'exited', exitCode: null, ...(record.agent ? { agentState: 'exited' as const } : {}) }
  }
  private kill(record: LiveTerminal): void {
    const pty = record.pty; record.pty = undefined
    this.releaseAgentRun(record)
    for (const subscription of record.subscriptions.splice(0)) subscription.dispose()
    try { pty?.kill() } catch { /* Already exited. */ }
  }
  private releaseAgentRun(record: LiveTerminal): void {
    this.clearApprovals(record)
    record.agent?.exit(); record.hooks?.dispose(); record.hooks = undefined; clearTimeout(record.activityTimer)
    record.plainActive = false
  }
  private clearApprovals(record: LiveTerminal): void {
    for (const pending of record.answers?.values() ?? []) pending.settle(false)
    record.answers?.clear(); record.approvals?.clear()
  }
  dispose(): void {
    this.disposed = true
    for (const record of this.terminals.values()) { ++record.generation; record.starting = false; record.ready = undefined; this.kill(record) }
    this.phoneListeners.clear(); this.visibleClients.clear()
  }
}
