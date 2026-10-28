import { join } from 'node:path'
import type { AgentThread, ProviderId } from '../../shared/agents'
import type { ThreadClearKeptReason } from '../../shared/threadClear'
import type { AppSettings } from '../../shared/settings'
import type { ProjectSetupRequest } from '../../shared/workerMachine'
import { babysitEndedReasonSchema, type BabysitEndedReason } from '../../shared/babysitting'
import { ShortTextWriter } from '../llm/shortTextWriter'
import { firstMessageTitleWriter, threadTitleWriter } from '../llm/threadTitle'
import { threadBranchWriter } from '../llm/threadBranch'
import { nextPromptWriter } from '../llm/nextPrompt'
import { NextPrompts } from './nextPrompts'
import type { NextPromptEntry } from '../../shared/nextPrompt'
import { CodexAppServerHost, type CodexAdapterEvent } from './codex'
import { ClaudeStreamJsonHost, type ClaudeAdapterEvent } from './claude'
import { WorkerRoles } from './subagentRoles'
import { subagentRoleTable } from '../../shared/workerRoles'
import { GrokAcpHost } from './grok'
import { DevinAcpHost } from './devin'
import { MuseMspHost } from './muse'
import { OpenCodeHost } from './opencode'
import { CursorAcpHost } from './cursor'
import { DeepSeekAcpHost } from './deepseek'
import { CursorSignIn } from './cursorSignIn'
import type { OwnServer } from '../../shared/ownModelServers'
import { openCodeForOwnServers } from '../ownModelServers/openCode'
import { HeldProviderHost } from './heldProviderGate'
import { heldProvidersOption, type HeldProviders } from '../../shared/heldProviders'
import { ConfiguredProviderHost } from './providerSwitch'
import { SottoThreadHost, ThreadRegistry } from './threads'
import { WorkspaceHost } from './workspace'
import { MainCheckoutKeeper, type MainCheckoutEvent } from './mainCheckout'
import type { PullRequestObservation } from './watcherEvidence'
import { WatcherService, type WatcherAutoSettleEvent } from './watcher'
import { WatcherPhoneService } from './watcherPhone'
import { WatcherToolServer } from './watcherTools'
import { DelegationService } from './delegation'
import { homedir, hostname } from 'node:os'
import { CheckQueue } from './checkQueue'
import type { PackageInstaller } from './checkWorktree'
import { ContinueService } from './continueThread'
import { AgentControl } from './control'
import { TurnRecorder } from './turns'
import { ConfiguredAgentReasoner } from './reasoning'
import { ClaudeSubscriptionClient } from './subscriptionClaude'
import { CodexSubscriptionClient } from './subscriptionCodex'
import { GrokSubscriptionClient } from './subscriptionGrok'
import { LocalHostService } from './hostService'
import { threadToolReads } from './threadToolReads'
import { GitStatusReader, runGitStatusCommand, runWithGhStandIn, type RunGitCommand } from './gitStatus'
import { GitHubHosts, GitHubRateLimit, type GitHubRateLimitEvent } from './github'
import { GitActions } from './gitActions'
import { Babysitter, type BabysitDeliver, type BabysitEndReason, type BabysitEvent } from './babysitting'
import { wakeUpPartDue, type BabysitNews } from './babysitNews'
import { WatchedPullRequestReader, type WatchedPullRequestEvent } from './watchedPullRequests'
import { GitPullRequests } from './gitPullRequests'
import { commitMessageWriter } from '../llm/commitMessage'
import { pullRequestTextWriter } from '../llm/pullRequestText'
import { WorktreeCleanup, type SharedGitHub, type WorktreeCleanupDependencies } from './worktreeCleanup'
import { IdleCompaction } from './idleCompaction'
import { RestartResume } from './restartResume'
import { LimitRestart } from './limitRestart'
import type { AgentHost } from './host'
import { UsageService } from './usageService'
import { mayGrantLocally } from './authority'
import { HostFactsSource, hostMachineReport, type MachineWork } from './hostFacts'
import type { HostMachineReport } from '../../shared/hostFacts'
import { readProjectOrigins } from './projectOrigins'
import { ProjectCopies } from './projectSetup'
import { threadDelegations } from './agentsView'
import { BranchBundles } from './branchBundles'
import { desktopBranchMoves, foldersOfSnapshot } from './branchMoves'
import { DesktopDefaultsStore, hostDelegationMachines } from './hostDelegation'
import type { HostDelegationRelay } from './delegationRelayHost'
import type { HostRemoteCallers } from './delegationRemoteHost'
import { DesktopDelegationRelay } from './delegationRelayDesktop'
import { DesktopRemoteDelegations } from './delegationRemoteDesktop'
import type { DelegationNews } from '../../shared/delegation'
import type { RelayedReply } from '../../shared/delegationRelay'
import { machineWorkingThreadsWarning } from '../../shared/workingThreads'

type ControlDependencies = ConstructorParameters<typeof AgentControl>[0]
type NativeHost = AgentHost & { closed?: () => Promise<void> }

export interface AgentRuntimeOptions {
  directory: string
  /** Immutable release-track gate, read once by the process owner. Absent fails closed. */
  watcherEnabled?: boolean
  /** The providers held to Owl on this run (ADR-0072, ADR-0079), read once by the process owner. Absent holds every one. */
  heldProviders?: HeldProviders
  /** Muse's answer alone, from before the held set; `heldProviders` wins. */
  museEnabled?: boolean
  /** Immutable Owl feature answer; absent fails closed and leaves saved usage untouched. */
  usageEnabled?: boolean
  /** The Owl list's answer for resuming threads after a restart (ADR-0076), read once by the process owner. Absent fails closed. */
  resumeAfterRestart?: boolean
  /**
   * The Owl list's answer for restarting stopped threads (ADR-0144), read once by the process owner. Absent fails closed:
   * no adapter reports a limit stop, nothing is scheduled, and the resume note reads `resumeThreadsAfterRestart`.
   */
  restartStoppedThreads?: boolean
  /** The Owl list's answer for cheaper publish windows while streaming (#991), read once by the process owner. Absent fails closed. */
  streamingPublishCost?: boolean
  /** The Owl list's answer for delegation between threads (ADR-0081), read once by the process owner. Absent fails closed. */
  delegationEnabled?: boolean
  /** The Owl list's answer for worker roles (#1041), read once by the process owner. Absent fails closed. */
  workerRolesEnabled?: boolean
  /** The Owl list's answer for continuing a thread on another provider (ADR-0089), read once by the process owner. Absent fails closed. */
  continueEnabled?: boolean
  /** The Owl list's answer for continuing an agent as its own thread and forking at a reply (#1028), read once. Absent fails closed. */
  threadStartsEnabled?: boolean
  /** Clearing settled threads (ADR-0140): the Owl list's answer, read once at start. Absent, nothing is deleted. */
  clearThreadsEnabled?: boolean
  /** What clearing did, as stable event names with a count or a reason's code. */
  clearLog?: (event: 'threads-cleared' | 'thread-clear-kept' | 'unsent-threads-removed', detail: string) => void
  /**
   * Keep main up to date (ADR-0142): the Owl list's answer, read once by the process owner, and its log of stable event
   * names. Absent fails closed, and a headless host builds none whatever it says.
   */
  keepMainCurrent?: { readonly log?: (event: MainCheckoutEvent) => void }
  /** The Owl list's answer for the iPhone's pull request sheet (#1281), read once. Absent fails closed. */
  pullRequestViewEnabled?: boolean
  /** The Owl list's answer for the iPhone's Agents view (ADR-0103), read once by the process owner. Absent fails closed. */
  agentsViewEnabled?: boolean
  /**
   * The Owl list's answer for Work across machines (ADR-0082), read once by the process owner. Absent fails closed: a
   * start names no machine or system, nothing reads where new workers start, the host does not report its projects'
   * origins, this machine's report is its host facts and running threads alone, no live load is sampled, and
   * list_machines shows none of it.
   */
  crossMachineEnabled?: boolean
  /**
   * A time of day as the user's computer writes it in the interface language main shows, for the words that say when a
   * check's snapshot was taken (#1312). Absent, as on a headless host, this machine's own default.
   */
  clockTime?: (at: Date) => string
  /** How a check installs packages first in the check worktree (#1312): `npm ci` under the user's Node by default; a test gives its own. */
  checkInstaller?: PackageInstaller
  /**
   * A headless host runs delegation for its own threads (#1310) only where its own Owl answer turns on Work across
   * machines. It holds them to the desktop defaults the last desktop that still counts sent it, and to Ask for approval
   * when none counts. `counts` says whether a desktop is still paired here with an answers grant, read from the host's
   * pairing and policy records at every start. `roles` is the host's own Owl answer for worker roles: with it, a
   * delegation's kind of work starts on the desktop's roles.
   */
  hostDelegation?: { counts(clientId: string): boolean; roles: boolean; revoked?(clientId: string): boolean
    /** The desktop relay (#1316): a thread here delegates to other machines through a desktop that relays, while one is connected. */
    relay?: HostDelegationRelay
    /** A desktop's delegations here for threads on other machines (#1316 part 2), admitted as this host's own threads' are. */
    remote?: HostRemoteCallers }
  /**
   * The Owl list's answer for attaching any file (ADR-0131), read once by the process owner. With it the store keeps files
   * that are not images and the host lists `file-staging`. Absent fails closed: only the four image types are kept.
   */
  attachAnyFile?: boolean
  /**
   * The Owl list's answer for next prompts (ADR-0132), read once by the process owner. Absent fails closed, and a headless
   * host builds none: only this computer's window shows them. `nextPromptChanged` hears each change, for the window.
   */
  nextPromptEnabled?: boolean
  nextPromptChanged?: (entry: NextPromptEntry) => void
  /**
   * The user's own model servers (ADR-0124), given to this computer's OpenCode at each process start. Present only while
   * the `own-model-servers` Owl answer is on; a headless host has none in this phase.
   */
  ownServers?: () => Promise<readonly OwnServer[]>
  claudeHistoryModulePath?: string
  credentials: ControlDependencies['credentials']
  settings: () => AppSettings
  /** What the short-writing switches read (ADR-0026). No key is needed: each thread's own provider writes. */
  writingSettings: () => Promise<AppSettings>
  historyEnabled: () => boolean
  observeActiveThread?: boolean
  openExternal: (url: string) => Promise<unknown>
  openThreadFolder?: ControlDependencies['openThreadFolder']
  authority?: ControlDependencies['authority']
  bindRequestDraftDecision?: ControlDependencies['bindRequestDraftDecision']
  logFailure?: ControlDependencies['logFailure']
  /** How a Claude settings change reached its CLI, as stable event names; never a model, a level or a mode. */
  claudeSettingsLog?: (event: ClaudeAdapterEvent) => void
  /** What happened to Sotto's Codex role files (#1042), as stable event names; never a path, a model or Codex's words. */
  codexLog?: (event: CodexAdapterEvent) => void
  missingAttachment?: ControlDependencies['missingAttachment']
  /** The headless host says so: it connects every signed-in provider at start and names itself in refusals (ADR-0036). */
  runsAs?: ControlDependencies['runsAs']
  /** Desktop design fixtures replace the whole provider boundary. */
  host?: AgentHost
  /** Native process overrides keep tests on the production coordinator path. */
  providers?: Partial<Record<ProviderId, NativeHost>>
  reasoner?: ControlDependencies['reasoner']
  /** A journey's stand-ins for the client update check and installer, and for where each client is (#480). */
  clients?: ControlDependencies['clients']
  locateClient?: ControlDependencies['locateClient']
  installedProviders?: ControlDependencies['installedProviders']
  /**
   * Git status the way T3 reads it: how often a project's origin may be fetched in the background, and
   * whether a window is in front to read for. Absent, thread records carry no Git status.
   */
  gitStatus?: { fetchIntervalMs: () => number; foreground?: () => boolean; visible?: () => boolean
    /** A scripted `gh` for a journey in the running app; development only. */
    ghStandIn?: { executable: string; args: readonly string[] }
    /** When GitHub's rate limit holds Sotto's questions back (#820), and what babysitting did (ADR-0061), as stable
     * event names; never gh's words, a pull request or a login. */
    log?: (event: GitHubRateLimitEvent | BabysitEvent | WatchedPullRequestEvent) => void }
  /** What the worktree cleanup (ADR-0041) may reach beyond the workspace: GitHub for the merged rule and Auto-settle
   * merged threads, and a log of stable event names. Without `pullRequestMerged` neither fires; the other rules read only the repository. */
  worktreeCleanup?: Pick<WorktreeCleanupDependencies, 'pullRequestMerged' | 'pullRequestState' | 'log'> & {
    /** GitHub's open pull requests' branches, which Clear settled threads after asks before a thread goes (ADR-0140). */
    readonly openPullRequestBranches?: (repositoryRoot: string, github?: SharedGitHub) => Promise<ReadonlySet<string>>
  }
  /**
   * Babysitting (ADR-0061). `agentTool` is the desktop's switch, read live: while it is on, this computer's Claude Code,
   * Codex and Grok Build threads have Sotto's pull request tools, so a wake-up tells the agent to stop with them. A
   * headless host has none, and its wake-ups say the user stops babysitting from the Pull request surface (decision 11).
   * `run` stands a test's scripted gh in for babysitting's reads alone.
   *
   * `retired` is the Owl list's answer for Restart stopped threads (ADR-0144), read once by the process owner: with it no
   * thread is babysat or offered the pull request tools, the switch is not read, the host does not list
   * `pull-request-babysit`, a babysitting wake-up saved in the queue is dropped at start, and the same reader follows the
   * pull requests of the threads Watcher watches, for Watcher alone. `run` stands in for that reader's reads too.
   */
  babysitting?: { agentTool?: () => boolean; run?: RunGitCommand; retired?: boolean }
  /** What Watcher's Settle finished threads did, as stable event names; never a thread, a title or a pull request. */
  watcherLog?: (event: WatcherAutoSettleEvent) => void
}

/** The provider stack both Electron main and a plain Node host own. No client transport lives here. */
/**
 * Whether this runtime clears its settled threads on its own (ADR-0140 decision 7): only on Owl, and never as a headless
 * host. A host has no Settings to choose Clear settled threads after in, so the 30-day default read from its own file
 * would delete threads no one asked it to, whatever the desktop chose. A desktop's Delete thread… still reaches it.
 */
export function clearsOnItsOwn(options: Pick<AgentRuntimeOptions, 'clearThreadsEnabled' | 'runsAs'>): boolean {
  return options.clearThreadsEnabled === true && options.runsAs !== 'headless-host'
}
export async function createAgentRuntime(options: AgentRuntimeOptions) {
  const { directory, credentials } = options
  // This machine's host facts: its operating system is read now, once; memory only when facts are asked for (#1031).
  // With Work across machines on, the first live load sample is taken now too, so the first ask reads over a window
  // without waiting (#1311); with it off, nothing is sampled and the report carries no load.
  const crossMachine = options.crossMachineEnabled === true
  const facts = new HostFactsSource()
  void facts.read().then(() => crossMachine ? facts.primeLoad() : undefined).catch(() => undefined)
  // Its threads and sends are read in place, after the load, as the report is answered, with Watcher's starts still on
  // their way to a thread here.
  const machineFacts = (): Promise<HostMachineReport> => hostMachineReport(facts, (): MachineWork => ({ threads: agentControl.watcherSnapshot().threads, ...agentControl.watcherSendRecords(),
    ...crossMachine && watcher ? { startsNotYetSent: watcher.startsNotYetSent() } : {} }), crossMachine)
  const threadRegistry = options.host ? null : new ThreadRegistry(directory)
  // Restarting stopped threads (ADR-0144): the adapters that can tell a usage limit report it on the failed turn, only with it on.
  const restartStopped = options.restartStoppedThreads === true
  const limitStops = restartStopped ? { limitStops: true } : {}
  const held = heldProvidersOption(options)
  // A held provider's adapter is never built: its stand-in starts nothing and refuses in the provider's name.
  const adapter = (id: ProviderId, build: () => NativeHost): NativeHost => held.has(id) ? new HeldProviderHost(id) : build()
  const providers: Partial<Record<ProviderId, NativeHost>> = options.host ? {} : {
    codex: adapter('codex', () => options.providers?.codex ?? new CodexAppServerHost({ userDataPath: directory, usageEnabled: options.usageEnabled === true, ...limitStops, ...(options.codexLog ? { logEvent: options.codexLog } : {}) })),
    claude: adapter('claude', () => options.providers?.claude ?? new ClaudeStreamJsonHost({ userDataPath: directory, usageEnabled: options.usageEnabled === true, ...limitStops, ...(options.claudeHistoryModulePath ? { historyModulePath: options.claudeHistoryModulePath } : {}),
      ...(options.claudeSettingsLog ? { logEvent: options.claudeSettingsLog } : {}), ultracodeEffort: () => agentControl.configuration().claudeUltracodeEffort })),
    grok: adapter('grok', () => options.providers?.grok ?? new GrokAcpHost(directory, { usageEnabled: options.usageEnabled === true, ...limitStops })),
    devin: adapter('devin', () => options.providers?.devin ?? new DevinAcpHost(directory)),
    muse: adapter('muse', () => options.providers?.muse ?? new MuseMspHost(directory, { disableSandbox: () => agentControl.configuration().museDisableSandbox, usageEnabled: options.usageEnabled === true, ...limitStops })),
    // A desktop's OpenCode opens a sign-in page in the user's browser (#1104). A headless host's has no browser: a desktop signs
    // it in over the host connection and opens its pages itself (#1107).
    opencode: adapter('opencode', () => options.providers?.opencode ?? new OpenCodeHost(directory, options.runsAs === 'headless-host' ? { heldProviders: held, usageEnabled: options.usageEnabled === true } : { heldProviders: held, openExternal: options.openExternal, usageEnabled: options.usageEnabled === true,
      ...(options.ownServers ? { ownServers: options.ownServers } : {}) })),
    // Cursor runs with Sotto's own Cursor folder under this runtime's directory: user data, or a headless host's data (ADR-0128).
    cursor: adapter('cursor', () => options.providers?.cursor ?? new CursorAcpHost(directory)),
    // DeepSeek Harness runs only the user's own model servers, whose record is this computer's in this phase, so a
    // headless host holds it back as OpenCode was held before its hosts slice (ADR-0138).
    deepseek: adapter('deepseek', () => options.providers?.deepseek ?? (options.runsAs === 'headless-host' ? new HeldProviderHost('deepseek')
      : new DeepSeekAcpHost(directory, { heldProviders: held, ...(options.ownServers ? { servers: options.ownServers } : {}) }))),
  }
  const agentHost = new WorkspaceHost(options.host ?? new ConfiguredProviderHost({
    directory,
    hosts: {
      codex: new SottoThreadHost('codex', providers.codex!, threadRegistry!),
      claude: new SottoThreadHost('claude', providers.claude!, threadRegistry!),
      grok: new SottoThreadHost('grok', providers.grok!, threadRegistry!),
      devin: new SottoThreadHost('devin', providers.devin!, threadRegistry!),
      muse: new SottoThreadHost('muse', providers.muse!, threadRegistry!),
      opencode: new SottoThreadHost('opencode', providers.opencode!, threadRegistry!),
      cursor: new SottoThreadHost('cursor', providers.cursor!, threadRegistry!),
      deepseek: new SottoThreadHost('deepseek', providers.deepseek!, threadRegistry!),
    },
    provider: () => agentControl.configuration().provider,
    enabledProviders: () => { const configuration = agentControl.configuration(); return configuration.enabledProviders ?? [configuration.provider] },
    threadProvider: threadId => threadRegistry?.byThread(threadId)?.provider,
  }), directory, options.historyEnabled, undefined, options.watcherEnabled ?? false, held, options.streamingPublishCost ?? false)
  const usage = options.usageEnabled === true ? new UsageService({ directory, host: agentHost,
    acceptedPromptIdentities: identities => agentHost.recordedUserMessages(identities) }) : undefined
  usage?.start()
  if (options.threadStartsEnabled === true) agentHost.allowThreadStarts()
  if (options.crossMachineEnabled === true) agentHost.allowBringBack()
  // A check takes the machine's one check worktree for its repository and installs packages first when they changed (#1312).
  if (options.crossMachineEnabled === true) agentHost.allowCheckWorktrees(options.checkInstaller)
  agentHost.setWorkingCopyDefaults(projectId => options.settings().projectThreadWorkingCopyDefaults[projectId] ?? options.settings().threadWorkingCopyDefault)
  let gitStatus: GitStatusReader | undefined
  let gitHubRateLimit: GitHubRateLimit | undefined
  let gitHubHosts: GitHubHosts | undefined
  /** How Git and gh are run; only a journey's stand-in changes it. */
  let gitRun: RunGitCommand | undefined
  if (options.gitStatus) {
    const { fetchIntervalMs, foreground, visible, ghStandIn, log } = options.gitStatus
    if (ghStandIn) gitRun = runWithGhStandIn(ghStandIn)
    // One rate limit for the process: the status reader and the Pull request surface spend the same gh sign-in's points.
    gitHubRateLimit = new GitHubRateLimit(log ? { log } : {})
    // One answer, too, to which hosts gh asks as GitHub, so `gh auth status` and `ssh -G` run once for everything that asks.
    gitHubHosts = new GitHubHosts({ run: gitRun ?? runGitStatusCommand })
    gitStatus = new GitStatusReader({ fetchIntervalMs, rateLimit: gitHubRateLimit, hosts: gitHubHosts, ...(gitRun ? { run: gitRun } : {}) })
    // Automatically pull is read at every remote read, so turning it on or off applies without a restart on the desktop.
    agentHost.setGitStatus(gitStatus, { pollIntervalMs: fetchIntervalMs, autoPull: () => options.settings().gitAutoPull, ...(foreground ? { foreground } : {}), ...(visible ? { visible } : {}) })
  }
  // Sotto's own short writing (ADR-0026): thread titles, branch names, commit and pull request drafts, each a
  // side call to the thread's own provider client. A design fixture host offers none, so its titles stay the stand-in.
  const shortTextWriter = new ShortTextWriter({
    write: (threadId, prompt, signal) => agentHost.writeShortText(threadId, prompt, signal),
    onFailure: failure => options.logFailure?.('short-writing-failed', `${failure.purpose} ${failure.reason}`),
  })
  agentHost.setBranchNameWriter(threadBranchWriter(shortTextWriter, options.writingSettings))
  // T3's Git actions (ADR-0027): the commit message and pull request text are the same side calls the forms use.
  const gitActions = gitStatus ? new GitActions({ status: gitStatus, ...(gitRun ? { run: gitRun } : {}), ...(gitHubHosts ? { hosts: gitHubHosts } : {}),
    writeCommitMessage: commitMessageWriter(shortTextWriter, options.writingSettings),
    writePullRequestText: pullRequestTextWriter(shortTextWriter, options.writingSettings),
    followPullRequestTemplates: async () => (await options.writingSettings()).followPullRequestTemplates }) : undefined
  if (gitActions) agentHost.setGitActions(gitActions)
  // Keep main up to date (ADR-0142): this computer's own projects, every 15 minutes and when a pull request merges. A
  // headless host's projects wait for a follow-up that carries the line to its clients.
  const mainCheckout = options.keepMainCurrent && options.runsAs !== 'headless-host' && gitStatus && gitActions
    ? new MainCheckoutKeeper({ host: agentHost, status: gitStatus, actions: gitActions, directory, ...(gitRun ? { run: gitRun } : {}),
      ...(options.keepMainCurrent.log ? { log: options.keepMainCurrent.log } : {}),
      enabled: projectId => {
        const settings = options.settings()
        const own = settings.projectKeepMainCurrent[projectId]
        return own === undefined ? settings.keepMainCurrent : own === 'on'
      } }) : undefined
  if (mainCheckout) agentHost.onPullRequestMerged(url => mainCheckout.pullRequestMerged(url))
  // The branch's pull request as a Tools surface (ADR-0027): read and acted on through the same gh.
  if (gitStatus) agentHost.setGitPullRequests(new GitPullRequests({ ...(gitRun ? { run: gitRun } : {}), ...(gitHubRateLimit ? { rateLimit: gitHubRateLimit } : {}), ...(gitHubHosts ? { hosts: gitHubHosts } : {}) }))
  const turns = new TurnRecorder({ directory, resolveSession: id => { const binding = threadRegistry?.byThread(id); return binding ? { provider: binding.provider, sessionId: binding.sessionId } : undefined },
  })
  const reasoner = options.reasoner ?? new ConfiguredAgentReasoner({
      claude: new ClaudeSubscriptionClient(join(directory, 'reasoning', 'claude')),
      codex: new CodexSubscriptionClient(join(directory, 'reasoning', 'codex')),
      grok: new GrokSubscriptionClient(join(directory, 'reasoning', 'grok')),
    })
  // Next prompts (ADR-0132): when a turn ends, the thread's own provider is asked on the side what the user will type next.
  // Built only for this computer's own threads, while the Owl feature is on; the switch is read for every turn.
  const nextPrompts = options.nextPromptEnabled === true && options.runsAs !== 'headless-host' && !options.host ? new NextPrompts({
    write: nextPromptWriter(shortTextWriter, options.writingSettings),
    thread: id => agentControl.liveThread(id),
    history: thread => agentControl.threadHistory(thread),
    historyEnabled: options.historyEnabled,
    publish: entry => options.nextPromptChanged?.(entry),
    log: event => options.logFailure?.('next-prompt-failed', event === 'next-prompt-failed error' ? 'failed' : 'unreadable'),
  }) : undefined
  // Restart stopped threads retires babysitting (ADR-0144): then no thread has Sotto's pull request tools, and the
  // switch that offers them is never read.
  const babysittingRetired = options.babysitting?.retired === true
  const babysitTool = (threadId: string): boolean => !babysittingRetired && options.babysitting?.agentTool?.() === true && agentHost.admitsBabysitting(threadId)
  const agentControl: AgentControl = new AgentControl({
    directory, host: agentHost, credentials, turns, watcherEnabled: options.watcherEnabled ?? false,
    heldProviders: held, streamingPublishCost: options.streamingPublishCost ?? false, ...(usage ? { usage } : {}),
    ...(restartStopped ? { restartStoppedThreads: true } : {}),
    ...(options.threadStartsEnabled === true ? { threadStartsEnabled: true } : {}),
    ...(options.clearThreadsEnabled === true ? { clearThreadsEnabled: true } : {}),
    ...(babysittingRetired ? { babysittingRetired: true } : {}),
    ...(options.clearLog ? { logClear: options.clearLog } : {}),
    historyEnabled: options.historyEnabled,
    ...(options.observeActiveThread === undefined ? {} : { observeActiveThread: options.observeActiveThread }),
    ...(options.authority ? { authority: options.authority } : {}),
    ...(options.openThreadFolder ? { openThreadFolder: options.openThreadFolder } : {}),
    ...(options.bindRequestDraftDecision ? { bindRequestDraftDecision: options.bindRequestDraftDecision } : {}),
    ...(options.logFailure ? { logFailure: options.logFailure } : {}),
    ...(options.missingAttachment ? { missingAttachment: options.missingAttachment } : {}),
    ...(options.attachAnyFile === true ? { attachAnyFile: true } : {}),
    ...(options.runsAs ? { runsAs: options.runsAs } : {}),
    ...(options.clients ? { clients: options.clients } : {}),
    ...(options.locateClient ? { locateClient: options.locateClient } : {}),
    ...(options.installedProviders ? { installedProviders: options.installedProviders } : {}),
    writeThreadTitle: threadTitleWriter(shortTextWriter, options.writingSettings),
    writeFirstMessageTitle: firstMessageTitleWriter(options.writingSettings),
    ...(nextPrompts ? { nextPrompts } : {}),
    reasoner,
  })
  let watcherTools: WatcherToolServer | undefined
  // Delegation between threads (ADR-0081): this computer's threads, and a headless host's own threads where its Owl answer
  // turns on Work across machines (#1310), each on its own machine, with its own tool tokens.
  let delegation: DelegationService | undefined
  let delegationRelay: DesktopDelegationRelay | undefined
  let delegationRemote: DesktopRemoteDelegations | undefined
  const hostDelegation = options.runsAs === 'headless-host' && options.crossMachineEnabled === true ? options.hostDelegation : undefined
  // The desktop defaults a desktop sent this host: the only new-thread default and roles its delegations use.
  const desktopDefaults = hostDelegation ? new DesktopDefaultsStore(directory) : undefined
  if (desktopDefaults) await desktopDefaults.load()
  // Worker roles (#1041): Settings are read only when a start or a delegation asks for its role.
  const roles = options.workerRolesEnabled === true ? { roles: () => options.settings().workerRoles } : {}
  // Each provider's own sub-agents follow them too (#1042): the table is read when a thread on this computer launches,
  // and offered again when Settings change. A headless host's threads start concretely, as their workers do.
  const workerRoles = options.workerRolesEnabled === true && options.runsAs !== 'headless-host'
    ? new WorkerRoles(() => subagentRoleTable(options.settings().workerRoles, agentControl.watcherSnapshot().models)) : undefined
  if (workerRoles) agentHost.useWorkerRoles(workerRoles)
  // Work across machines (#1032): only the desktop places starts, so only its Watcher reads where new workers start. Every
  // host that has it on, the desktop's own included, reports its projects' origins.
  // Starting a worker from a thread's branch (#1033) moves that branch first: only the desktop places starts, so only it
  // moves branches, asked once here with the Owl answer. Its own bundles wait in its data folder while they cross.
  // The mover reaches hosts through Watcher's view of them, which exists only once Watcher is made below.
  const moving: { watcher?: WatcherService | undefined } = {}
  const branchMoves = desktopBranchMoves(crossMachine && options.runsAs !== 'headless-host', {
    bundles: new BranchBundles({ stagingDirectory: join(directory, 'branch-moves'), recordsPath: join(directory, 'branch-moves.json') }),
    folders: foldersOfSnapshot(() => agentControl.watcherSnapshot()), host: hostId => moving.watcher?.branchMoveHost(hostId),
    hostName: hostId => moving.watcher?.machineName(hostId) ?? 'That machine' })
  // One check queue per machine (#1312): this machine's delegations and Watcher's starts marked as checks wait in the same
  // one, in the order asked. On the desktop it is This computer's; on a headless host, the host's own, which the desktop's
  // Watcher starts there share with the host's own delegations. Only while Work across machines is on. A host names itself
  // as its relay's away words do (#1316): by the name the desktop saved for it, and its own machine name until one is sent.
  const relayed = options.runsAs === 'headless-host' ? options.hostDelegation?.relay : undefined
  const checks = crossMachine ? new CheckQueue(options.runsAs !== 'headless-host' ? 'This computer'
    : () => relayed?.hereName() ?? (hostname().trim().slice(0, 64) || 'this machine')) : undefined
  // A machine with no copy of a start's project gets one (#1690): This computer's set up by the desktop, a host's by the
  // host, each through its own coordinator. Sotto's own data folder, where Watcher works, never says where projects go.
  const projectCopies = crossMachine ? new ProjectCopies({ projects: () => agentControl.watcherSnapshot().projects, projectsDirectory: () => agentControl.projectsDirectory(),
    home: homedir(), ownFolder: directory, addProject: (title, path) => agentControl.addProjectForPlacement(title, path) }) : undefined
  const placing = crossMachine && options.runsAs !== 'headless-host'
    ? { workerMachine: () => options.settings().newWorkerMachine, projectOrigins: () => readProjectOrigins(agentControl.watcherSnapshot().projects),
      ...projectCopies ? { setUpProject: (request: ProjectSetupRequest) => projectCopies.setUp(request) } : {},
      ...branchMoves ? { branchMoves } : {} } : {}
  const watcher = moving.watcher = options.watcherEnabled === true
    ? new WatcherService({ directory, control: agentControl, host: agentHost, historyEnabled: options.historyEnabled, streamingPublishCost: options.streamingPublishCost === true,
      workerHost: options.runsAs === 'headless-host', revoke: id => watcherTools?.revoke(id), machineFacts, crossMachine, ...options.clockTime ? { clockTime: options.clockTime } : {},
      settleFinished: () => options.settings().watcherSettlesFinishedThreads, ...babysittingRetired ? { babysittingRetired: true } : {}, compactAt: () => options.settings().watcherCompactAtTokens, ...options.watcherLog ? { log: options.watcherLog } : {},
      ...roles, ...placing,
      // The desktop's Watcher queues checks where it moves branches; a host's, for the desktop's starts marked as checks.
      ...checks && ('branchMoves' in placing || options.runsAs === 'headless-host') ? { checks } : {} }) : undefined
  if (options.delegationEnabled === true && options.runsAs !== 'headless-host') {
    agentHost.enableDelegation()
    // A delegating thread lists and names machines through Watcher's own reads (#1032), so only while Watcher runs too.
    const placingWatcher = 'workerMachine' in placing ? watcher : undefined
    // The desktop relay (#1316): a host's threads delegate to This computer through this desktop, placed as its own are.
    if (placingWatcher) {
      // This computer's delegations start threads on its paired hosts too (#1316 part 2), each admitted there by that host.
      delegationRemote = new DesktopRemoteDelegations(directory, { machineName: hostId => placingWatcher.machineName(hostId) })
      await delegationRemote.load()
      const remoteStarts = delegationRemote
      placingWatcher.useDelegationStarts(hostId => remoteStarts.pendingStarts(hostId))
      delegationRelay = new DesktopDelegationRelay(directory, { placement: placingWatcher, localHostId: () => agentControl.hostId(), elsewhere: true })
      await delegationRelay.load()
    }
    const relaying = delegationRelay, remote = delegationRemote
    delegation = new DelegationService({ directory, control: agentControl, host: agentHost, historyEnabled: options.historyEnabled,
      tool: threadId => babysitTool(threadId), ...roles,
      ...placingWatcher ? { machines: { list: () => placingWatcher.machines(), place: (ask, project, setting) => placingWatcher.placement(ask, project, setting),
        name: hostId => placingWatcher.machineName(hostId), setting: () => options.settings().newWorkerMachine } } : {},
      // Offered with the machines, as the tool server offers from_my_branch and test_run only with them (#1033). This
      // computer's checks run one at a time, in the order asked (#1312).
      ...placingWatcher && branchMoves && checks ? { branchMoves, checks, ...options.clockTime ? { clockTime: options.clockTime } : {} } : {},
      // A delegated thread's own worktree is made from the delegating thread's branch, so it can bring changes back (#1030).
      ...crossMachine ? { bringBack: true } : {},
      ...remote ? { remote } : {},
      ...relaying ? { relayedCallers: { caller: (threadId: string) => relaying.caller(threadId), tell: (threadId: string, news: DelegationNews, replies: readonly RelayedReply[]) => relaying.tell(threadId, news, replies) } } : {} })
    relaying?.useDelegation(delegation)
  } else if (hostDelegation && desktopDefaults) {
    agentHost.enableDelegation()
    // A thread here delegates on this machine alone until #1316. Its ceiling and roles are the desktop's, never this host's
    // own stored defaults; the four-prompt budget and the warning above ten are this machine's.
    const defaults = desktopDefaults
    delegation = new DelegationService({ directory, control: agentControl, host: agentHost, historyEnabled: options.historyEnabled,
      newThreadCeiling: () => defaults.ceiling(clientId => hostDelegation.counts(clientId), clientId => hostDelegation.revoked?.(clientId) === true),
      ...hostDelegation.roles ? { roles: () => defaults.roles(clientId => hostDelegation.counts(clientId)) } : {},
      warning: count => machineWorkingThreadsWarning(count, 'this machine'),
      // A check here waits in this host's own queue, shared with the desktop's Watcher starts on it (#1312).
      ...checks ? { checks } : {},
      ...hostDelegation.relay ? { relay: hostDelegation.relay } : {},
      // A thread on another machine that delegates here through the desktop (#1316 part 2) is admitted as one of this host's own.
      ...hostDelegation.remote ? { relayedCallers: hostDelegation.remote, hereName: () => relayed?.hereName() ?? (hostname().trim().slice(0, 64) || 'this machine') } : {},
      machines: hostDelegationMachines(() => agentControl.hostId(), facts, () => agentControl.watcherSnapshot().threads, hostDelegation.relay) })
  }
  if (delegation && hostDelegation?.remote) hostDelegation.remote.useDelegation(delegation)
  // A cleared thread's finished delegations and links go with it (ADR-0140 decision 4), on the desktop and on a host alike.
  if (delegation) {
    const record = delegation
    agentControl.onThreadsDeleted(threadIds => { void record.forgetThreads(new Set(threadIds)) })
  }
  // Continuing a thread on another provider (ADR-0089): the desktop's own threads only, so a headless host builds none.
  const continuation = options.continueEnabled === true && options.runsAs !== 'headless-host'
    ? new ContinueService({ control: agentControl, host: agentHost }) : undefined
  if (watcher) {
    agentHost.setWatcherPrObserver(read => watcher.pullRequestObserved(read))
    if (options.runsAs !== 'headless-host') { watcherTools = new WatcherToolServer(watcher, { roles: options.workerRolesEnabled === true, machines: crossMachine }); agentHost.useWatcherTools(watcherTools) }
  }
  agentHost.setPendingThreadWork(threadId => agentControl.hasPendingThreadWork(threadId), threadId => agentControl.pendingThreadWorkReason(threadId))
  // Reclaims worktrees only under the rules the user turned on (ADR-0041); every rule starts off. The desktop's
  // local host and a headless host both own worktrees, so both get it. Its owner starts it once the owner's own
  // checks are wired (the desktop's open terminals), and close drains it before anything it asks is closed.
  // Auto-settle merged threads rides the same sweep: it asks GitHub the way the merged rule does, on the same hour.
  // The merged check spends the same sign-in's points as the status reader, and asks as its timer does (#820).
  const merged = options.worktreeCleanup?.pullRequestMerged
  const openPullRequests = options.worktreeCleanup?.openPullRequestBranches
  const pullRequestState = options.worktreeCleanup?.pullRequestState
  const github = gitHubRateLimit && gitHubHosts ? { rateLimit: gitHubRateLimit, hosts: gitHubHosts } : undefined
  // Clear settled threads after (ADR-0140) rides the same hour, on the computer whose setting it is, and only on Owl:
  // never a headless host's, which has no Settings to choose it in (clearsOnItsOwn).
  const worktreeCleanup = new WorktreeCleanup({ host: agentHost, rules: () => options.settings().worktreeCleanup,
    autoSettleMerged: () => options.settings().autoSettleMergedThreads, ...options.worktreeCleanup,
    removeUnsentThreads: () => agentControl.removeUnsentThreads(),
    ...clearsOnItsOwn(options) ? { clearSettledThreads: { afterDays: () => options.settings().clearSettledThreadsAfterDays,
      clear: (days: number, keep?: (thread: AgentThread) => Promise<ThreadClearKeptReason | null>) => agentControl.clearSettledThreads(days, keep) } } : {},
    ...merged && github ? { pullRequestMerged: (repositoryRoot: string, branch: string) => merged(repositoryRoot, branch, github) } : {},
    ...pullRequestState && github ? { pullRequestState: (url: string) => pullRequestState(url, github) } : {},
    ...openPullRequests && github ? { openPullRequestBranches: (repositoryRoot: string) => openPullRequests(repositoryRoot, github) } : {} })
  // A paired client's Files, Changes and Agents for this host's threads (ADR-0025, October 5 amendment): reads only, over
  // the same working copies the desktop's own tools resolve. The headless host and the desktop's phone listener serve them.
  const toolReads = threadToolReads({ resolveBinding: threadId => agentControl.filesBinding(threadId), subagents: agentHost })
  // Babysitting (ADR-0061): the thread's host reads each babysat pull request every two minutes, whether or not a
  // window is in front, and hands each thread its news as a wake-up through the thread's own send path (decision 8).
  // A quiet ending takes back what a waiting wake-up said of that pull request (decision 9). An ending on its own, or the
  // switch's, is kept on the thread's record with why, for the Pull request surface to say (#825).
  const deliverWakeUp: BabysitDeliver = (threadId, news) => agentControl.deliverWakeUp(threadId, news, { tool: babysitTool(threadId) })
  const QUIET_ENDINGS: ReadonlySet<BabysitEndReason> = new Set(['stopped-by-agent', 'stopped-by-user', 'switched-off', 'settled', 'archived', 'unlinked', 'forgotten'])
  const SAID_ENDINGS: ReadonlySet<BabysitEndReason> = new Set(babysitEndedReasonSchema.options)
  const babysitRun = options.babysitting?.run ?? gitRun
  const babysitter = gitHubRateLimit && options.gitStatus && !babysittingRetired ? new Babysitter({ store: agentHost, deliver: deliverWakeUp, rateLimit: gitHubRateLimit,
    // Each read also brings the threads' links to that pull request to the state GitHub gave (#1147).
    observed: (read: PullRequestObservation) => {
      watcher?.pullRequestObserved(read)
      agentHost.notePullRequestState(read)
      if (read.state === 'merged') mainCheckout?.pullRequestMerged(read.url)
    },
    ...(babysitRun ? { run: babysitRun } : {}), ...(options.gitStatus.log ? { log: options.gitStatus.log } : {}),
    ended: async (threadId, url, reason) => {
      if (reason === 'merged') mainCheckout?.pullRequestMerged(url)
      if (SAID_ENDINGS.has(reason)) await agentHost.recordBabysitEnded(threadId, url, reason as BabysitEndedReason).catch(() => undefined)
      if (QUIET_ENDINGS.has(reason)) await agentControl.withdrawWakeUp(threadId, url, { tool: babysitTool(threadId) }).catch(() => undefined)
    } }) : undefined
  // A part of a wake-up may go only while the babysitting it is news of still stands, and an agent's only while the
  // switch is on, a last one included; a user's last wake-up for an ending goes. Asked as the wake-up goes, whatever
  // withdrawal managed.
  const wakeUpDue = (threadId: string, news: BabysitNews): boolean =>
    babysitter ? wakeUpPartDue(news, babysitter.list(threadId), options.babysitting?.agentTool?.() !== false) : true
  // Restart stopped threads (ADR-0144): babysitting is gone, and Watcher keeps its pull request news from the same reads
  // of the pull requests of the threads it watches, told only to Watcher, the threads' links and Keep main up to date.
  const watchedPullRequests = babysittingRetired && watcher && gitHubRateLimit && options.gitStatus ? new WatchedPullRequestReader({
    pullRequests: () => watcher.watchedThreadIds().flatMap(id => agentHost.openPullRequestUrls(id)), rateLimit: gitHubRateLimit,
    observed: (read: PullRequestObservation) => {
      watcher.pullRequestObserved(read)
      agentHost.notePullRequestState(read)
      if (read.state === 'merged') mainCheckout?.pullRequestMerged(read.url)
    },
    ...(babysitRun ? { run: babysitRun } : {}), ...(options.gitStatus.log ? { log: options.gitStatus.log } : {}) }) : undefined
  // Given before start, so a wake-up restored from the queue is asked about too, even when taking it back failed.
  if (babysitter) agentControl.useBabysitting(babysitter, { due: wakeUpDue, tool: babysitTool, current: (threadId, news) => babysitter.current(threadId, news) })
  // Resuming after a restart (ADR-0076): what was working is read before the coordinator starts, and recorded from then
  // on, so the threads this process's close stops are sent the resume note when it next starts.
  // With restarting stopped threads on, its setting stands in for Resume threads after a restart (ADR-0144).
  const resumeSetting = (): boolean => restartStopped ? options.settings().restartStoppedThreads : options.settings().resumeThreadsAfterRestart
  const restartResume = options.resumeAfterRestart === true
    ? new RestartResume({ directory, control: agentControl, enabled: resumeSetting,
      tool: babysitTool, preservesDormantThread: id => agentHost.preservesDormantThread(id) }) : undefined
  // A note already waiting in a queue goes only while both are still on; without the feature, none goes.
  if (restartResume) agentControl.useRestartResume({ due: resumeSetting,
    sending: threadId => restartResume.noteSending(threadId), unsent: threadId => restartResume.noteUnsent(threadId) })
  // Restarting threads a usage limit stopped (ADR-0144): given before start, so the first snapshot is read for stops and a
  // restart note restored from the queue is asked about. Watcher's own thread goes first, and Watcher hears of the others.
  const watcherThreadHere = (): string | undefined => {
    const target = agentControl.watcherRecordView().current?.target
    return target && target.hostId === agentControl.hostId() ? target.threadId : undefined
  }
  const limitRestart = restartStopped ? new LimitRestart({ directory,
    control: { host: () => agentControl.watcherSnapshot(), thread: id => agentControl.liveThread(id), deliverWakeUp: (id, news, given) => agentControl.deliverWakeUp(id, news, given) },
    enabled: () => options.settings().restartStoppedThreads, watcherThreadId: watcherThreadHere, tool: babysitTool,
    preservesDormantThread: id => agentHost.preservesDormantThread(id),
    restarted: (provider, threadIds) => {
      const hostId = agentControl.hostId(), own = watcherThreadHere()
      if (watcher && hostId) watcher.wakes.threadsRestarted(provider, threadIds.filter(id => id !== own).map(threadId => ({ hostId, threadId })))
    } }) : undefined
  if (limitRestart) agentControl.useLimitRestart(limitRestart)
  // Idle compaction (ADR-0127): a large Claude thread quiet for 54 minutes is compacted while its prompt cache is warm.
  // The switch is read at every sweep, so turning it off stops the next one without a restart. Watcher's own conversation
  // is compacted too, while Watcher rests.
  const idleCompaction = new IdleCompaction({ control: agentControl, enabled: () => options.settings().compactIdleThreads,
    ...watcher ? { watcherAtRest: (threadId: string) => watcher.restsForIdleCompaction(threadId) } : {} })
  let closingWatcherTools: Promise<void> | undefined
  let watcherStopped = false
  const stopWatcher = (): void => {
    if (watcherStopped) return
    watcherStopped = true
    nextPrompts?.close()
    idleCompaction.stop()
    watcher?.close()
    delegation?.close()
    delegationRelay?.close()
    delegationRemote?.close()
    continuation?.close()
    closingWatcherTools = watcherTools?.close()
  }
  let stoppingProviders: Promise<void> | undefined
  const stopProviders = (): Promise<void> => {
    if (stoppingProviders) return stoppingProviders
    stopWatcher()
    // Before anything is stopped: what closing does to a thread is not a turn ending.
    const resumeFrozen = restartResume?.freeze()
    const limitClosed = limitRestart?.close()
    agentControl.dispose()
    stoppingProviders = (async () => {
      // The record's last write runs beside the providers' closing; nothing they do changes it now. A thread title still
      // being written gets up to two seconds before the side calls are stopped, so `closed()` saves it (#980).
      const results = await Promise.allSettled([reasoner.close?.(), agentControl.titleWritesSettled().then(() => shortTextWriter.close()), ...Object.values(providers).map(provider => provider.closed?.()),
        ...(closingWatcherTools ? [closingWatcherTools] : []), ...(resumeFrozen ? [resumeFrozen] : []), ...(limitClosed ? [limitClosed] : [])])
      await agentControl.closed()
      // A connection already starting when stop was requested has now settled. Stop and drain
      // once more so it cannot leave a late child outside the first provider closure snapshot.
      agentHost.disconnect()
      const finalClosures = await Promise.allSettled(Object.values(providers).map(provider => provider.closed?.()))
      results.push(...finalClosures)
      await threadRegistry?.flush()
      usage?.flush()
      const failure = results.find(result => result.status === 'rejected')
      if (failure?.status === 'rejected') throw failure.reason
    })()
    return stoppingProviders
  }
  let preparingForShutdown: Promise<void> | undefined
  /** Linux's delay inhibitor is short: stop providers and save now, retaining stores for a sweep already running. */
  const prepareForShutdown = (): Promise<void> => {
    if (preparingForShutdown) return preparingForShutdown
    worktreeCleanup.dispose()
    projectCopies?.close()
    void mainCheckout?.close()
    void babysitter?.close().catch(() => undefined)
    void watchedPullRequests?.close().catch(() => undefined)
    preparingForShutdown = stopProviders().finally(() => agentHost.flush())
    return preparingForShutdown
  }
  let closing: Promise<void> | undefined
  const close = (): Promise<void> => {
    closing ??= (async () => {
      // A sweep in progress finishes its current worktree, and takes no other, before the host it asks is closed.
      // A babysitting pass finishes the pull request it is on, and records what it told, the same way.
      stopWatcher()
      projectCopies?.close()
      await worktreeCleanup.close()
      if (mainCheckout) await mainCheckout.close()
      if (babysitter) await babysitter.close()
      if (watchedPullRequests) await watchedPullRequests.close()
      toolReads.dispose()
      // Checks that were waiting let go of the branches they would have started from (#1312), alongside the providers'
      // drain rather than ahead of it, and before the store closes.
      try { await stopProviders(); await preparingForShutdown } finally { await delegation?.drained(); await watcher?.drained(); usage?.close(); await agentHost.close() }
    })()
    return closing
  }
  // The switch turned off while Sotto was closed ends what agents started, and takes back the wake-ups they left
  // waiting, before the queue can send anything and before the first pass reads anything (ADR-0061 decision 12); the
  // desktop ends it again whenever the switch is saved off.
  const switchedOff = babysitter && options.babysitting?.agentTool?.() === false ? babysitter : undefined
  try {
    if (restartResume) await agentHost.initialize()
    await restartResume?.start()
    await limitRestart?.start()
    await agentControl.start(switchedOff ? { beforeConnect: async () => { await switchedOff.stop({ startedBy: 'agent' }, 'switch').catch(() => 0) } } : {})
  } catch (error) {
    await restartResume?.freeze()
    await limitRestart?.close()
    idleCompaction.stop()
    watcher?.close()
    delegation?.close()
    continuation?.close()
    const closingWatcherTools = watcherTools?.close()
    void babysitter?.close()
    void watchedPullRequests?.close()
    void mainCheckout?.close()
    agentControl.dispose()
    await Promise.allSettled([reasoner.close?.(), shortTextWriter.close(), ...Object.values(providers).map(provider => provider.closed?.()), ...(closingWatcherTools ? [closingWatcherTools] : [])])
    agentHost.dispose()
    usage?.close()
    throw error
  }
  if (watcher) await watcher.recover()
  if (delegation) await delegation.recover()
  const delegationRecord = delegation
  const hostService = new LocalHostService({ control: agentControl, events: agentHost, tools: toolReads, babysitting: babysitter !== undefined, facts: machineFacts,
    ...(crossMachine ? { projectOrigins: readProjectOrigins } : {}),
    ...(projectCopies ? { setUpProject: (request: ProjectSetupRequest) => projectCopies.setUp(request) } : {}),
    // A headless host that runs delegation for its own threads keeps the desktop defaults a desktop sends it (#1310).
    ...(desktopDefaults ? { desktopDefaults } : {}),
    // And answers the desktop window's read of those threads' delegations, for its Tools › Agents and rows of delegated work (#1310).
    ...(desktopDefaults && delegationRecord ? { delegationViews: delegationRecord } : {}),
    // And sends its own check queue to those desktops' windows, for the machine's panel and Tools › Agents (#1312).
    ...(checks && options.runsAs === 'headless-host' ? { checks } : {}),
    ...(crossMachine && gitStatus ? { bringBack: true } : {}),
    prompts: { threadPrompts: (threadId, beforeMessageId) => agentHost.threadPrompts(threadId, beforeMessageId) },
    ...(options.threadStartsEnabled === true ? { threadStarts: { startHandover: (threadId: string) => agentHost.startHandover(threadId) } } : {}),
    ...(options.pullRequestViewEnabled === true ? { pullRequestView: true } : {}),
    ...(options.clearThreadsEnabled === true ? { threadDelete: true } : {}),
    ...(options.attachAnyFile === true ? { fileStaging: true } : {}),
    // The iPhone's Agents view (ADR-0103): delegated threads only where delegation runs, which on a headless host is only
    // where Work across machines is on (#1310).
    ...(options.agentsViewEnabled === true ? { agentsView: delegationRecord ? { delegations: (threadId, threads) => threadDelegations(delegationRecord, threads, threadId) } : {} } : {}),
    ...(usage ? { usage, mayClearUsage: client => (options.authority?.mayGrant(client) ?? mayGrantLocally(client)).allowed } : {}),
    ...(options.runsAs === 'headless-host' && watcher ? { watcher } : {}),
    ...(options.runsAs !== 'headless-host' && watcher ? { watcherPhone: new WatcherPhoneService(agentControl, watcher, crossMachine) } : {}) })
  babysitter?.begin()
  watchedPullRequests?.begin()
  mainCheckout?.start()
  // Signing Sotto's OpenCode in to model sources (#1104): only where its adapter runs, so a held OpenCode has none.
  const opencodeSignIn = providers.opencode instanceof OpenCodeHost ? providers.opencode.signIn : undefined
  // The user's own model servers reach the same OpenCode (ADR-0124), only where it runs and they were asked for.
  const ownServersOpenCode = options.ownServers && providers.opencode instanceof OpenCodeHost ? openCodeForOwnServers(providers.opencode) : undefined
  // And the same record reaches DeepSeek Harness (ADR-0138), only where its adapter runs.
  const deepseekHost = providers.deepseek instanceof DeepSeekAcpHost ? providers.deepseek : undefined
  const ownServersDeepSeek = options.ownServers && deepseekHost ? { changed: () => deepseekHost.ownServersChanged() } : undefined
  // Signing Cursor in from its tile on this computer (ADR-0128): only where its adapter runs, and never on a headless host, whose
  // Cursor a desktop signs in through the provider sign-in request instead.
  const cursorHost = providers.cursor instanceof CursorAcpHost ? providers.cursor : undefined
  const cursorSignIn = cursorHost && options.runsAs !== 'headless-host' ? new CursorSignIn({
    configDirectory: cursorHost.folder, program: () => cursorHost.clientProgram(), openExternal: async url => { await options.openExternal(url) },
    connect: async () => {
      const state = await agentControl.command({ type: 'connect', provider: 'cursor' })
      const status = state.host.providers?.find(item => item.id === 'cursor')
      return status?.connection === 'connected' ? undefined : status?.error ?? state.error ?? 'It did not confirm the connection.'
    },
    signedOut: async () => { await agentControl.command({ type: 'disconnect', provider: 'cursor' }) },
  }) : undefined
  idleCompaction.start()
  return { agentHost, agentControl, threadRegistry, turns, hostService, usage, shortTextWriter, nextPrompts, worktreeCleanup, babysitter, mainCheckout, watcher, watcherTools, delegation, delegationRelay, delegationRemote, continuation, workerRoles, opencodeSignIn, ownServersOpenCode, ownServersDeepSeek, cursorSignIn, branchMoves, checks, prepareForShutdown, close }
}
