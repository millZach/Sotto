import { PROVIDER_LABELS, type AgentProviderStatus, type ProviderId } from '../../shared/agents'
import type { HostsCommand } from '../../shared/hosts'
import { HOST_PROVIDER_JOB_WORDS, hostProviderFound, hostProviderJobCase, hostProviderJobTitle, type HostProviderId, type HostProviderJobCase, type HostProviderJobState } from '../../shared/hostProviders'
import { hostProviderBrief, PROVIDER_COMMANDS, PROVIDER_INSTALL_METHODS, providerLookupOrder } from './hostProviderBrief'
import type { HostSetupThreads } from './hostSetup'
import { PROVIDER_JOB_TOOL_NAMES, type AgentJobToolName, type HostSetupToolReply } from './hostSetupTools'

/** A saved host as a provider job needs it: its name and SSH address, and whether it is connected now. */
export interface ProviderJobHost { readonly name: string; readonly target: string; readonly sshPort?: number | undefined; readonly connected: boolean }
/** What a provider job asks of the saved hosts: one host's provider, and the host's own refresh for it. */
export interface ProviderJobHosts {
  host(id: string): ProviderJobHost | undefined
  /** The provider's status as that host last published it; undefined while the host is not connected. */
  provider(id: string, provider: ProviderId): AgentProviderStatus | undefined
  /** Check again: the host's own refresh for this provider, and the status it answered with. */
  refresh(id: string, provider: ProviderId): Promise<{ readonly status?: AgentProviderStatus | undefined; readonly error?: string | undefined }>
  /** A host's providers or connection changed. */
  subscribe(listener: () => void): () => void
}
/** What Settings > Hosts & phones asks of the provider job, which runs beside the saved hosts and reports into them. */
export interface HostProviderJobSource {
  state(): HostProviderJobState | undefined
  command(command: Extract<HostsCommand, { type: 'start-provider-job' | 'stop-provider-job' }>): Promise<void>
  subscribe(listener: () => void): () => void
}
interface Job {
  readonly id: string
  readonly hostId: string
  readonly host: string
  readonly provider: HostProviderId
  readonly case: HostProviderJobCase
  readonly threadTitle: string
  readonly modelName: string
  threadId?: string
  phase: HostProviderJobState['phase']
  error?: string
  /** A check is running; the tool runs one at a time. */
  checking: boolean
}
const running = (job: Job | undefined): job is Job => job !== undefined && (job.phase === 'starting' || job.phase === 'running')
/** "An agent is installing Devin on forge now.", which refuses a second agent job while this one runs. */
const workingOn = (job: Job): string => `An agent is ${HOST_PROVIDER_JOB_WORDS[job.case].doing} ${PROVIDER_LABELS[job.provider]} on ${job.host} now.`

/**
 * Have my agent install it, update it or fix it (ADR-0035, amended for #461): one provider job at a time, for one
 * provider on one saved host, run by a normal thread on this computer in the Host setup project. The thread reaches the
 * host through this computer's SSH, every command a request the user answers, and gets the provider job's tools while
 * the job runs: `provider_status` and `provider_check`, both fixed to that host and that provider. The job ends when
 * the host finds the provider and can start it; signing in is the user's, from the tile. Nothing here is saved.
 */
export class HostProviderJobs implements HostProviderJobSource {
  private current: Job | undefined
  private readonly listeners = new Set<() => void>()
  private revokeTool: ((threadId: string) => void) | undefined
  private readonly unsubscribe: (() => void)[]
  /** `busy` names the other agent job running, a host setup, as the sentence that refuses this one. */
  constructor(private readonly options: { hosts: ProviderJobHosts; threads: HostSetupThreads; busy?: () => string | undefined }) {
    this.unsubscribe = [options.threads.subscribe(() => this.threadsChanged()), options.hosts.subscribe(() => this.hostsChanged())]
  }
  /** The running job's own thread, by its Sotto thread ID. */
  threadId(): string | undefined { return running(this.current) ? this.current.threadId : undefined }
  /** Why a host setup may not start now, when a provider job runs: one agent job at a time. */
  busySentence(): string | undefined {
    const job = this.current
    return running(job) ? `${workingOn(job)} Stop it on its tile in Settings > Hosts & phones first. Nothing was started.` : undefined
  }
  /** How a job that ends takes its thread's tool away: the tool server's revoke. */
  useTools(revoke: (threadId: string) => void): void { this.revokeTool = revoke }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  state(): HostProviderJobState | undefined {
    const job = this.current
    if (!job) return undefined
    return { id: job.id, hostId: job.hostId, host: job.host, provider: job.provider, case: job.case, threadTitle: job.threadTitle, modelName: job.modelName, phase: job.phase,
      ...(job.threadId ? { threadId: this.options.threads.windowId(job.threadId) } : {}), ...(job.error ? { error: job.error } : {}) }
  }
  async command(command: Extract<HostsCommand, { type: 'start-provider-job' | 'stop-provider-job' }>): Promise<void> {
    if (command.type === 'start-provider-job') await this.start(command)
    else await this.stop(command.id)
  }
  // The tool's side, for the one thread whose job runs.
  admits(threadId: string): boolean { return running(this.current) && this.current.threadId === threadId }
  tools(threadId: string): readonly AgentJobToolName[] { return this.admits(threadId) ? PROVIDER_JOB_TOOL_NAMES : [] }
  async run(threadId: string, tool: AgentJobToolName): Promise<HostSetupToolReply> {
    const job = this.current
    if (!running(job) || job.threadId !== threadId || !(PROVIDER_JOB_TOOL_NAMES as readonly string[]).includes(tool)) {
      return { isError: true, result: { message: 'This thread is not installing, updating or fixing a provider now. Nothing was checked or changed.' } }
    }
    if (tool === 'provider_status') return { result: this.status(job) }
    if (job.checking) return { isError: true, result: { message: 'A check is already running for this provider. Wait for it, then read provider_status.' } }
    return this.check(job)
  }
  /** Quitting ends the job the way Stop does, without waiting on the thread. */
  close(): void {
    for (const off of this.unsubscribe) off()
    const job = this.current
    if (!running(job)) return
    job.phase = 'stopped'
    this.end(job)
  }

  private async start(command: Extract<HostsCommand, { type: 'start-provider-job' }>): Promise<void> {
    const name = PROVIDER_LABELS[command.provider]
    if (running(this.current)) throw new Error(`${workingOn(this.current)} Stop it first. Nothing was started.`)
    const busy = this.options.busy?.()
    if (busy) throw new Error(busy)
    const choice = this.options.threads.choice()
    if (choice.unavailable) throw new Error(choice.unavailable)
    const model = choice.models.find(item => item.id === command.modelId)
    if (!model) throw new Error('That model is not ready on this computer. Choose another one. Nothing was started.')
    const host = this.options.hosts.host(command.hostId)
    if (!host?.connected) throw new Error(`${host?.name ?? 'This host'} is not connected. Nothing was started. Switch it on, then try again.`)
    const status = this.options.hosts.provider(command.hostId, command.provider)
    const jobCase = hostProviderJobCase(status)
    if (!jobCase) throw new Error(`${host.name}'s host can already use ${name}, so there is nothing for an agent to install, update or fix. Nothing was started.`)
    const job: Job = { id: command.id, hostId: command.hostId, host: host.name, provider: command.provider, case: jobCase, modelName: model.name,
      threadTitle: hostProviderJobTitle(jobCase, command.provider, host.name), phase: 'starting', checking: false }
    this.current = job
    this.emit()
    const brief = hostProviderBrief({ host: host.name, target: host.target, sshPort: host.sshPort, provider: command.provider, case: jobCase,
      version: status?.version || undefined, requiredVersion: status?.requiredVersion, message: status?.error })
    try {
      await this.options.threads.start({ title: job.threadTitle, modelId: model.id, brief, created: threadId => { job.threadId = threadId; this.emit() } })
    } catch (error) {
      if (this.current !== job || job.phase !== 'starting') return
      const message = error instanceof Error ? error.message : 'The thread could not start.'
      this.end(job)
      // No thread: nothing was started, and the tile says why. A thread that did not take its brief stays to look at.
      if (!job.threadId) { this.current = undefined; this.emit(); throw new Error(`${message} Nothing was started.`, { cause: error }) }
      job.phase = 'failed'; job.error = `The thread ${job.threadTitle} did not start working. ${message} Nothing was changed on ${job.host}.`
      this.emit()
      return
    }
    if (this.current !== job) return
    // Stopped while the thread was being made: the brief went after the stop could interrupt anything, so interrupt now.
    if (job.phase === 'stopped') { await this.interruptStopped(job); return }
    if (job.phase !== 'starting') return
    job.phase = 'running'
    this.emit()
    // Found meanwhile, by a check the user or the host ran: the job is already over.
    this.hostsChanged()
  }
  private async stop(id: string): Promise<void> {
    const job = this.current
    if (job?.id !== id || !running(job)) return
    job.phase = 'stopped'
    this.end(job)
    this.emit()
    if (job.threadId) await this.options.threads.interrupt(job.threadId).catch(() => undefined)
  }
  /** A job stopped before its thread took the brief: the tool goes and the turn the brief began is interrupted. */
  private async interruptStopped(job: Job): Promise<void> {
    if (!job.threadId) return
    this.end(job)
    await this.options.threads.interrupt(job.threadId).catch(() => undefined)
  }
  /** The job is over: its thread's tool goes. */
  private end(job: Job): void { if (job.threadId) this.revokeTool?.(job.threadId) }
  /** The host found the provider and can start it: the job ends there, and the tile offers Sign in. */
  private found(job: Job): void {
    if (!running(job)) return
    job.phase = 'found'
    this.end(job)
    this.emit()
  }
  private async check(job: Job): Promise<HostSetupToolReply> {
    job.checking = true
    let answer: Awaited<ReturnType<ProviderJobHosts['refresh']>>
    try { answer = await this.options.hosts.refresh(job.hostId, job.provider) }
    catch (error) { return { isError: true, result: { found: false, message: error instanceof Error ? error.message : `${job.host} did not answer. Nothing was changed. Try again.` } } }
    finally { job.checking = false }
    const status = answer.status ?? this.options.hosts.provider(job.hostId, job.provider)
    const name = PROVIDER_LABELS[job.provider]
    // Stopped while the host was looking: whatever it found, this thread's job is over and gets no "found" to act on.
    // A job the host's own update already ended as found (the refresh publishes as it answers) still hears found.
    if (this.current !== job || job.phase === 'stopped' || job.phase === 'failed') return { isError: true, result: { found: false, message: 'This job was stopped. Nothing more was checked.' } }
    if (hostProviderFound(status)) {
      this.found(job)
      return { result: { found: true, message: `${job.host}'s host found ${name} and started it${status?.connection === 'connected' ? ', and it is connected' : '; it is not signed in yet'}. The job is over: stop here and tell the user they can sign in from Settings > Hosts & phones. Do not sign in yourself.` } }
    }
    if (!running(job)) return { isError: true, result: { found: false, message: 'This job is over. Nothing more was checked.' } }
    return { isError: true, result: { found: false, ...this.reported(status), ...(answer.error ? { message: answer.error } : {}) } }
  }
  /** What the host last reported about the provider, as the tools and the brief name it. */
  private reported(status: AgentProviderStatus | undefined): Record<string, unknown> {
    if (!status) return { hostConnected: false, message: 'The host is not connected to this computer now, so Sotto cannot read its providers. Nothing was checked.' }
    const problem = status.connection === 'error' ? status.problem ?? 'cannot-start' : undefined
    return { connection: status.connection, ...(problem ? { problem } : {}), ...(status.version ? { versionFound: status.version } : {}),
      ...(status.requiredVersion ? { versionNeeded: status.requiredVersion } : {}), ...(status.error ? { message: status.error } : {}) }
  }
  private status(job: Job): Record<string, unknown> {
    const host = this.options.hosts.host(job.hostId)
    const status = this.options.hosts.provider(job.hostId, job.provider)
    return { host: job.host, ...(host ? { target: host.target, ...(host.sshPort ? { sshPort: host.sshPort } : {}), hostConnected: host.connected } : { hostSaved: false }),
      provider: PROVIDER_LABELS[job.provider], command: PROVIDER_COMMANDS[job.provider], job: job.case, found: hostProviderFound(status), ...this.reported(status),
      whereTheHostLooks: providerLookupOrder(job.provider), officialInstall: PROVIDER_INSTALL_METHODS[job.provider] }
  }
  /** A host's providers changed: a job whose provider the host now finds is over, whoever made the host look again. */
  private hostsChanged(): void {
    const job = this.current
    if (!running(job) || job.phase !== 'running') return
    // A host forgotten meanwhile has no tile to follow the job and nothing its tool may reach: the job stops.
    if (!this.options.hosts.host(job.hostId)) { void this.stop(job.id); return }
    if (hostProviderFound(this.options.hosts.provider(job.hostId, job.provider))) this.found(job)
  }
  /** The threads changed: archiving the job's thread stops the job, as archiving a host setup thread stops its setup. */
  private threadsChanged(): void {
    const job = this.current
    if (running(job) && job.phase === 'running' && job.threadId && this.options.threads.thread(job.threadId)?.archived) void this.stop(job.id)
  }
  private emit(): void { for (const listener of this.listeners) listener() }
}
