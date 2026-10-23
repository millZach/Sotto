import { randomUUID } from 'node:crypto'
import type { AgentRequest } from '../../shared/agents'
import { HOST_SETUP_STEPS, type HostSetupChoice, type HostSetupState, type HostSetupStep, type HostsCommand, type HostStatus, type RemoteHost } from '../../shared/hosts'
import { isSottoRequest, SOTTO_REQUEST_PREFIX, type SottoThreadRequests } from '../agents/sottoRequests'
import type { HostSetupSource } from './desktopHosts'
import { hostSetupBrief } from './hostSetupBrief'
import { HOST_SETUP_TOOL_NAMES, type AgentJobToolName, type HostSetupToolHandlers, type HostSetupToolReply } from './hostSetupTools'
import { validateSshHost } from './sshConfiguration'

type Connection = Omit<RemoteHost, 'enabled'>
/** What the setup asks of the saved hosts: Add host's own check and add, and where each stands. */
export interface HostSetupHosts {
  /** Add host's connect without pairing or saving; undefined when it was cancelled before it finished. */
  check(connection: Connection): Promise<HostStatus | undefined>
  /** Add host's add, which saves the host only once it answers and pairs. */
  add(connection: Connection): Promise<void>
  /** Forgets the saved host with this ID, as its row's Forget does; false when it is not saved. */
  forget(id: string): Promise<boolean>
  attempt(id: string): HostStatus | undefined
  cancelAttempt(id: string): Promise<void>
  /** The saved host's name when this target and port are saved already. */
  savedAs(target: string, sshPort: number | undefined): string | undefined
}
/** What the setup reads of its thread: the requests waiting in it, and whether the user archived it. */
export interface HostSetupThreadInfo { readonly requestIds: readonly string[]; readonly archived: boolean }
/** What the setup asks of the threads on this computer. */
export interface HostSetupThreads {
  choice(): HostSetupChoice
  /**
   * Creates the host setup thread and sends it the brief. `created` runs between the two, so the thread's tool is
   * admitted before the native session starts, which is when a client reads its tool servers.
   */
  start(request: { readonly title: string; readonly modelId: string; readonly brief: string; readonly created: (threadId: string) => void }): Promise<void>
  interrupt(threadId: string): Promise<void>
  thread(threadId: string): HostSetupThreadInfo | undefined
  /** The thread as the window addresses it. */
  windowId(threadId: string): string
  subscribe(listener: () => void): () => void
}
interface Run {
  readonly id: string
  readonly connection: Connection
  readonly name: string
  readonly modelName: string
  readonly threadTitle: string
  threadId?: string
  phase: HostSetupState['phase']
  error?: string
  /** The check or add the tool ran last, and which it was. */
  attemptId?: string
  purpose?: 'check' | 'add'
  /** A check or add is running; the tool runs one at a time. */
  busy: boolean
  /** Steps a check stopped at, with the reason, which a later check passing marks as done by the agent. */
  readonly failed: Map<HostSetupStep, string | undefined>
  readonly byAgent: Set<HostSetupStep>
  /** "Add forge as a host?", while it waits in the thread. */
  request?: { readonly id: string; readonly resolve: (answer: 'add' | 'decline' | 'stopped') => void }
  /** The add under way, from the question to its result; a host_add repeated after a client timeout waits on it. */
  adding?: Promise<HostSetupToolReply>
}
/** Reasons that are the user's to answer, not something the agent fixed, so a later pass is not the agent's. */
const ANSWERED_BY_USER = new Set(['tailscale-unapproved', 'prompt-unanswered', 'host-key-rejected', 'cancelled'])
const running = (run: Run | undefined): run is Run => run !== undefined && (run.phase === 'starting' || run.phase === 'running')

/**
 * Have my agent set this up (ADR-0035): one host setup at a time, for one device, run by a normal thread on this
 * computer that gets the `sotto_host_setup` tools while the setup runs. The setup keeps the device's connection,
 * so the thread can check and add that device and no other; adding waits for the user's answer to a request in
 * the thread. Nothing here is saved: quitting ends the setup, and the thread stays as an ordinary thread.
 */
export class HostSetup implements HostSetupSource, HostSetupToolHandlers {
  private current: Run | undefined
  private readonly listeners = new Set<() => void>()
  private readonly requestListeners = new Set<() => void>()
  private revokeTool: ((threadId: string) => void) | undefined
  private watched = ''
  private readonly unsubscribe: () => void
  /**
   * `busy` names the other agent job running, a provider job, as the sentence that refuses a second one: one agent job
   * runs at a time (ADR-0035).
   */
  constructor(private readonly options: { hosts: HostSetupHosts; threads: HostSetupThreads; version: string; busy?: () => string | undefined }) {
    this.unsubscribe = options.threads.subscribe(() => this.threadsChanged())
  }
  /** The running setup's own thread, by its Sotto thread ID. */
  threadId(): string | undefined { return running(this.current) ? this.current.threadId : undefined }
  /** How a setup that ends takes its thread's tool away: the tool server's revoke. */
  useTools(revoke: (threadId: string) => void): void { this.revokeTool = revoke }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  choice(): HostSetupChoice { return this.options.threads.choice() }
  state(): HostSetupState | undefined {
    const run = this.current
    if (!run) return undefined
    const status = run.attemptId ? this.options.hosts.attempt(run.attemptId) : undefined
    const waiting = this.waiting(run)
    return { id: run.id, name: run.name, target: run.connection.target, ...(run.connection.sshPort ? { sshPort: run.connection.sshPort } : {}),
      ...(run.threadId ? { threadId: this.options.threads.windowId(run.threadId) } : {}), threadTitle: run.threadTitle, modelName: run.modelName,
      phase: run.phase, ...(run.error ? { error: run.error } : {}),
      ...(status && run.purpose ? { attempt: { ...status, purpose: run.purpose } } : {}),
      byAgent: HOST_SETUP_STEPS.filter(step => run.byAgent.has(step)), ...(waiting ? { waiting } : {}) }
  }
  async command(command: Extract<HostsCommand, { type: 'start-setup' | 'stop-setup' | 'dismiss-setup' }>): Promise<void> {
    if (command.type === 'start-setup') await this.start(command)
    else if (command.type === 'stop-setup') await this.stop(command.id)
    else if (this.current?.id === command.id && !running(this.current)) {
      // Put away: a finished check or failed add the checklist still showed goes with it, as Add host's Cancel drops one.
      const { attemptId } = this.current
      this.current = undefined; this.emit()
      if (attemptId) await this.options.hosts.cancelAttempt(attemptId).catch(() => undefined)
    }
  }
  // Sotto's own request in the setup thread: "Add forge as a host?".
  requests(): ReadonlyMap<string, readonly AgentRequest[]> {
    const run = this.current
    if (!run?.request || !run.threadId) return new Map()
    const request: AgentRequest = { id: run.request.id, kind: 'permission',
      text: `Add ${run.name} as a host?\nSotto connects to ${run.connection.target}, starts the host there if it is not running and pairs this computer. ${run.name} is saved in Settings > Hosts & phones once it answers.`,
      options: [], permissionChoices: [{ id: 'add', label: `Add ${run.name}`, kind: 'allow-once' }, { id: 'decline', label: 'Don’t add', kind: 'deny' }],
      context: { toolName: 'Add host' } }
    return new Map([[run.threadId, [request]]])
  }
  answer(threadId: string, requestId: string, approved: boolean): void {
    const run = this.current
    if (!run?.request || run.request.id !== requestId || run.threadId !== threadId) throw new Error('This request is no longer pending. Refresh the thread.')
    const { resolve } = run.request
    delete run.request
    resolve(approved ? 'add' : 'decline')
    this.requestsChanged(); this.emit()
  }
  // The tool's side, for the one thread whose setup runs.
  admits(threadId: string): boolean { return running(this.current) && this.current.threadId === threadId }
  /** The setup thread's tools: the host setup's three, and none of a provider job's. */
  tools(threadId: string): readonly AgentJobToolName[] { return this.admits(threadId) ? HOST_SETUP_TOOL_NAMES : [] }
  async run(threadId: string, tool: AgentJobToolName): Promise<HostSetupToolReply> {
    const run = this.current
    if (!running(run) || run.threadId !== threadId || !(HOST_SETUP_TOOL_NAMES as readonly string[]).includes(tool)) return { isError: true, result: { message: 'This thread is not setting up a host now. Nothing was checked or added.' } }
    if (tool === 'host_status') return { result: this.status(run) }
    if (tool === 'host_add' && run.adding) return run.adding
    if (run.busy || run.adding) return { isError: true, result: { message: 'A check or an add is already running for this device. Wait for it, then read host_status.' } }
    if (tool === 'host_check') return this.check(run)
    const adding = run.adding = this.add(run).finally(() => { if (run.adding === adding) delete run.adding })
    return adding
  }
  /** Quitting ends the setup the way Stop setup does, without waiting on the thread. */
  async close(): Promise<void> {
    this.unsubscribe()
    const run = this.current
    if (!running(run)) return
    run.phase = 'stopped'
    this.end(run)
    if (run.attemptId) await this.options.hosts.cancelAttempt(run.attemptId).catch(() => undefined)
  }

  private async start(command: Extract<HostsCommand, { type: 'start-setup' }>): Promise<void> {
    if (running(this.current)) throw new Error(`Sotto is already setting up ${this.current.name}. Stop that setup first. Nothing was started.`)
    const busy = this.options.busy?.()
    if (busy) throw new Error(busy)
    const choice = this.options.threads.choice()
    if (choice.unavailable) throw new Error(choice.unavailable)
    const model = choice.models.find(item => item.id === command.modelId)
    if (!model) throw new Error('That model is not ready on this computer. Choose another one. Nothing was started.')
    const connection = command.host
    validateSshHost({ target: connection.target, installPath: connection.installPath, dataDirectory: connection.dataDirectory,
      ...(connection.sshPort ? { sshPort: connection.sshPort } : {}), ...(connection.identityFile ? { identityFile: connection.identityFile } : {}) })
    const saved = this.options.hosts.savedAs(connection.target, connection.sshPort)
    if (saved) throw new Error(`${connection.target} is already saved as ${saved}. Nothing was started. Switch it on in the list instead.`)
    // Have my agent fix this: the failed Add it attempt says where to start, and gives way to the setup.
    let failure: { step: HostSetupStep; reason?: string | undefined } | undefined
    if (command.after) {
      const previous = this.options.hosts.attempt(command.after)
      if (previous?.phase === 'error' && previous.step) failure = { step: previous.step, ...(previous.reason ? { reason: previous.reason } : {}) }
      await this.options.hosts.cancelAttempt(command.after)
    }
    const run: Run = { id: command.id, connection, name: connection.name, modelName: model.name, threadTitle: `Set up ${connection.name}`,
      phase: 'starting', busy: false, failed: new Map(failure ? [[failure.step, failure.reason]] : []), byAgent: new Set() }
    this.current = run
    this.emit()
    const brief = hostSetupBrief({ name: run.name, target: connection.target, sshPort: connection.sshPort, installPath: connection.installPath,
      dataDirectory: connection.dataDirectory, version: this.options.version, failure })
    try {
      await this.options.threads.start({ title: run.threadTitle, modelId: model.id, brief, created: threadId => { run.threadId = threadId; this.emit() } })
    } catch (error) {
      if (this.current !== run || run.phase !== 'starting') return
      const message = error instanceof Error ? error.message : 'The setup thread could not start.'
      this.end(run)
      // No thread: the form stays, with the reason. A thread that exists but did not take its brief stays open to look at.
      if (!run.threadId) { this.current = undefined; this.emit(); throw new Error(`${message} Nothing was started.`, { cause: error }) }
      run.phase = 'failed'; run.error = `The setup thread did not start working. ${message} Nothing was saved as a host.`
      this.emit()
      return
    }
    if (this.current !== run) return
    // Stop setup pressed while the thread was being made: the brief went after the stop could interrupt anything, so
    // the tool goes and the turn it began is interrupted now.
    if (run.phase === 'stopped' && run.threadId) {
      this.end(run)
      await this.options.threads.interrupt(run.threadId).catch(() => undefined)
      return
    }
    if (run.phase !== 'starting') return
    run.phase = 'running'
    this.emit()
  }
  private async stop(id: string): Promise<void> {
    const run = this.current
    if (run?.id !== id || !running(run)) return
    run.phase = 'stopped'
    this.end(run)
    this.emit()
    // A check or add in flight is dropped: nothing is saved, and a pairing it made is revoked. One that finished
    // stays for the checklist to show how far the setup got, until the setup is put away.
    const adding = run.adding
    if (run.attemptId && this.options.hosts.attempt(run.attemptId)?.phase === 'connecting') await this.options.hosts.cancelAttempt(run.attemptId).catch(() => undefined)
    if (run.threadId) await this.options.threads.interrupt(run.threadId).catch(() => undefined)
    // An add already past pairing cannot be cancelled and may save the host as the stop lands: wait for it, so
    // the stop reports what it did (add() forgets such a host again).
    if (adding) await adding.catch(() => undefined)
    this.emit()
  }
  /** The setup is over: its request goes, and its thread's tool with it. */
  private end(run: Run): void {
    if (run.request) { const { resolve } = run.request; delete run.request; resolve('stopped'); this.requestsChanged() }
    if (run.threadId) this.revokeTool?.(run.threadId)
  }
  private async check(run: Run): Promise<HostSetupToolReply> {
    const id = randomUUID()
    run.busy = true; run.attemptId = id; run.purpose = 'check'; this.emit()
    let status: HostStatus | undefined
    try { status = await this.options.hosts.check({ ...run.connection, id }) }
    catch (error) { return { isError: true, result: { ok: false, message: error instanceof Error ? error.message : 'The check could not start. Nothing was changed.' } } }
    finally { run.busy = false; this.emit() }
    if (this.current !== run || !running(run)) return { isError: true, result: { ok: false, message: 'The setup was stopped. Nothing was saved.' } }
    if (!status) return { isError: true, result: { ok: false, message: 'The check was cancelled before it finished. Nothing was saved.' } }
    this.learn(run, status)
    this.emit()
    if (status.checked) return { result: { ok: true, device: run.name, message: `${run.name} answered: Sotto reached it, signed in, found the host installed and started it. Nothing was paired or saved. Call host_add to add it.` } }
    return { isError: true, result: this.failure(status) }
  }
  private async add(run: Run): Promise<HostSetupToolReply> {
    const answer = await new Promise<'add' | 'decline' | 'stopped'>(resolve => {
      run.request = { id: `${SOTTO_REQUEST_PREFIX}host-setup:${randomUUID()}`, resolve }
      this.requestsChanged(); this.emit()
    })
    if (answer === 'stopped' || this.current !== run || !running(run)) return { isError: true, result: { added: false, message: 'The setup was stopped. Nothing was saved.' } }
    if (answer === 'decline') return { result: { added: false, declined: true, message: `The user chose not to add ${run.name} now. Nothing was saved. Ask them what they want to do next.` } }
    run.busy = true; run.attemptId = run.connection.id; run.purpose = 'add'; this.emit()
    let refused: unknown
    try { await this.options.hosts.add(run.connection) }
    catch (error) { refused = error instanceof Error ? error : new Error('The host could not be added. Nothing was saved.') }
    finally { run.busy = false; this.emit() }
    if (this.current !== run || !running(run)) return this.stoppedDuringAdd(run)
    if (refused instanceof Error) return { isError: true, result: { added: false, message: refused.message } }
    const status = this.options.hosts.attempt(run.connection.id)
    if (status) this.learn(run, status)
    if (status?.phase === 'connected') {
      run.phase = 'connected'
      this.end(run); this.emit()
      return { result: { added: true, message: `${run.name} is added and connected. It is in Settings > Hosts & phones, and its threads show in the Threads sidebar. There is nothing more to set up.` } }
    }
    // A host that answered with another Sotto version is saved, as Add host saves it, so the setup ends there: its
    // row says what to update, and the dialog must not go on saying nothing was saved.
    if (status && this.options.hosts.savedAs(run.connection.target, run.connection.sshPort)) {
      run.phase = 'failed'
      run.error = `${run.name} was saved as a host but is not connected. ${status.error ?? 'Its row in Settings > Hosts & phones says what to do.'}`
      this.end(run); this.emit()
      return { isError: true, result: { added: true, connected: false, message: run.error } }
    }
    this.emit()
    return { isError: true, result: status ? { added: false, ...this.failure(status) } : { added: false, message: 'The add was cancelled before it finished. Nothing was saved.' } }
  }
  /**
   * Stop setup landed while the add ran. An add past pairing cannot be cancelled and may have saved the host just
   * as the stop arrived; Stop setup saves nothing, so such a host is forgotten again. If that fails, the setup
   * says the host is saved rather than claiming nothing was.
   */
  private async stoppedDuringAdd(run: Run): Promise<HostSetupToolReply> {
    const stopped = { isError: true, result: { added: false, message: 'The setup was stopped. Nothing was saved.' } }
    try { if (!(await this.options.hosts.forget(run.connection.id))) return stopped }
    catch {
      run.error = `${run.name} was saved as a host just as the setup stopped, and Sotto could not forget it again. Forget it in Settings > Hosts & phones if you do not want it.`
      this.emit()
      return { isError: true, result: { added: true, message: 'The setup was stopped after the host was saved, and Sotto could not forget it again. The user can forget it in Settings > Hosts & phones.' } }
    }
    return { isError: true, result: { added: false, message: 'The setup was stopped as the host was added, so Sotto forgot it again. Nothing is saved.' } }
  }
  /** What a check or add that stopped says: the step, the reason code, Add host's sentence and its fix. */
  private failure(status: HostStatus): Record<string, unknown> {
    return { ok: false, step: status.step, ...(status.reason ? { reason: status.reason } : {}), message: status.error ?? 'The connection stopped before the host answered. Nothing was saved.',
      ...(status.fix ? { fix: status.fix } : {}), ...(status.tailscale ? { tailscaleAsked: true } : {}) }
  }
  private status(run: Run): Record<string, unknown> {
    const status = run.attemptId ? this.options.hosts.attempt(run.attemptId) : undefined
    const last = !status ? undefined : status.checked ? { kind: run.purpose, ok: true }
      : status.phase === 'connected' ? { kind: run.purpose, ok: true, connected: true }
        : status.phase === 'connecting' ? { kind: run.purpose, running: true, step: status.step, ...(status.tailscale?.waiting ? { waitingForTailscaleApproval: true } : {}), ...(status.prompt ? { waitingForSshAnswer: true } : {}) }
          : { kind: run.purpose, ...this.failure(status) }
    return { device: run.name, target: run.connection.target, ...(run.connection.sshPort ? { sshPort: run.connection.sshPort } : {}),
      installationFolder: run.connection.installPath, dataFolder: run.connection.dataDirectory, sottoVersion: this.options.version,
      ...(run.request ? { waitingForUser: 'The user has not answered whether to add this host yet.' } : {}), ...(last ? { last } : { last: 'No check has run yet.' }) }
  }
  /** A step that stopped an earlier check and passes now was fixed by the agent, unless the user's answer did it. */
  private learn(run: Run, status: HostStatus): void {
    const stopped = status.phase === 'error' ? status.step : status.checked ? 'pair' : status.phase === 'connected' ? undefined : status.step
    const passed = stopped === undefined ? HOST_SETUP_STEPS : HOST_SETUP_STEPS.slice(0, HOST_SETUP_STEPS.indexOf(stopped))
    for (const step of passed) {
      if (run.failed.has(step) && step !== 'tailscale' && !ANSWERED_BY_USER.has(run.failed.get(step) ?? '')) run.byAgent.add(step)
      run.failed.delete(step)
    }
    if (status.phase === 'error' && status.step) run.failed.set(status.step, status.reason)
  }
  /**
   * What the thread waits on the user for: Sotto's add request first, then an SSH question or Tailscale approval
   * holding the tool's check or add, else any request the provider made.
   */
  private waiting(run: Run): HostSetupState['waiting'] {
    if (run.request) return 'add'
    if (!running(run)) return undefined
    const attempt = run.attemptId ? this.options.hosts.attempt(run.attemptId) : undefined
    if (attempt?.phase === 'connecting' && (attempt.prompt || attempt.tailscale?.waiting)) return 'connection'
    if (!run.threadId) return undefined
    return this.options.threads.thread(run.threadId)?.requestIds.some(id => !isSottoRequest(id)) ? 'command' : undefined
  }
  /** The threads changed: the setup's waiting line, an archived setup thread, or a model becoming ready. */
  private threadsChanged(): void {
    const run = this.current
    if (running(run) && run.phase === 'running' && run.threadId && this.options.threads.thread(run.threadId)?.archived) { void this.stop(run.id); return }
    const choice = this.options.threads.choice()
    const watched = JSON.stringify([run ? this.waiting(run) : null, choice.unavailable ?? '', choice.modelId ?? '', choice.models.map(model => model.id)])
    if (watched === this.watched) return
    this.watched = watched
    this.emit()
  }
  private requestsChanged(): void { for (const listener of this.requestListeners) listener() }
  private emit(): void { for (const listener of this.listeners) listener() }
  /** For `SottoThreadRequests`: the coordinator listens for Sotto's own requests here. */
  subscribeRequests(listener: () => void): () => void { this.requestListeners.add(listener); return () => this.requestListeners.delete(listener) }
}

/** The setup's own requests as the coordinator reads them: its `subscribe` is the requests' own, not the setup's. */
export function hostSetupRequests(setup: HostSetup): SottoThreadRequests {
  return { requests: () => setup.requests(), answer: (threadId, requestId, approved) => setup.answer(threadId, requestId, approved), subscribe: listener => setup.subscribeRequests(listener) }
}
