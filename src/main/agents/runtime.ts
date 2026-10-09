import { join } from 'node:path'
import type { ProviderId } from '../../shared/agents'
import type { AppSettings } from '../../shared/settings'
import { ShortTextWriter } from '../llm/shortTextWriter'
import { firstMessageTitleWriter, threadTitleWriter } from '../llm/threadTitle'
import { threadBranchWriter } from '../llm/threadBranch'
import { CodexAppServerHost } from './codex'
import { ClaudeStreamJsonHost, type ClaudeAdapterEvent } from './claude'
import { GrokAcpHost } from './grok'
import { DevinAcpHost } from './devin'
import { ConfiguredProviderHost } from './providerSwitch'
import { SottoThreadHost, ThreadRegistry } from './threads'
import { WorkspaceHost } from './workspace'
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
import { GitPullRequests } from './gitPullRequests'
import { commitMessageWriter } from '../llm/commitMessage'
import { pullRequestTextWriter } from '../llm/pullRequestText'
import { WorktreeCleanup, type WorktreeCleanupDependencies } from './worktreeCleanup'
import type { AgentHost } from './host'

type ControlDependencies = ConstructorParameters<typeof AgentControl>[0]
type NativeHost = AgentHost & { closed?: () => Promise<void> }

export interface AgentRuntimeOptions {
  directory: string
  claudeHistoryModulePath?: string
  credentials: ControlDependencies['credentials']
  settings: () => AppSettings
  /** What the short-writing switches read (ADR-0026). No key is needed: each thread's own provider writes. */
  writingSettings: () => Promise<AppSettings>
  historyEnabled: () => boolean
  coordinatorEnabled: () => boolean
  observeActiveThread?: boolean
  openExternal: (url: string) => Promise<unknown>
  openThreadFolder?: ControlDependencies['openThreadFolder']
  authority?: ControlDependencies['authority']
  preferences?: ControlDependencies['preferences']
  bindRequestDraftDecision?: ControlDependencies['bindRequestDraftDecision']
  logFailure?: ControlDependencies['logFailure']
  /** How a Claude settings change reached its CLI, as stable event names; never a model, a level or a mode. */
  claudeSettingsLog?: (event: ClaudeAdapterEvent) => void
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
  gitStatus?: { fetchIntervalMs: () => number; foreground?: () => boolean
    /** A scripted `gh` for a journey in the running app; development only. */
    ghStandIn?: { executable: string; args: readonly string[] }
    /** When GitHub's rate limit holds Sotto's questions back (#820), and what babysitting did (ADR-0061), as stable
     * event names; never gh's words, a pull request or a login. */
    log?: (event: GitHubRateLimitEvent | BabysitEvent) => void }
  /** What the worktree cleanup (ADR-0041) may reach beyond the workspace: GitHub for the merged rule and Auto-settle
   * merged threads, and a log of stable event names. Without `pullRequestMerged` neither fires; the other rules read only the repository. */
  worktreeCleanup?: Pick<WorktreeCleanupDependencies, 'pullRequestMerged' | 'log'>
  /**
   * Babysitting (ADR-0061). `agentTool` is the desktop's switch, read live: while it is on, this computer's Claude Code,
   * Codex and Grok Build threads have Sotto's pull request tools, so a wake-up tells the agent to stop with them. A
   * headless host has none, and its wake-ups say the user stops babysitting from the Pull request surface (decision 11).
   * `run` stands a test's scripted gh in for babysitting's reads alone.
   */
  babysitting?: { agentTool?: () => boolean; run?: RunGitCommand }
}

/** The provider stack both Electron main and a plain Node host own. No client transport lives here. */
export async function createAgentRuntime(options: AgentRuntimeOptions) {
  const { directory, credentials } = options
  const threadRegistry = options.host ? null : new ThreadRegistry(directory)
  const providers: Partial<Record<ProviderId, NativeHost>> = options.host ? {} : {
    codex: options.providers?.codex ?? new CodexAppServerHost({ userDataPath: directory }),
    claude: options.providers?.claude ?? new ClaudeStreamJsonHost({ userDataPath: directory, ...(options.claudeHistoryModulePath ? { historyModulePath: options.claudeHistoryModulePath } : {}),
      ...(options.claudeSettingsLog ? { logEvent: options.claudeSettingsLog } : {}) }),
    grok: options.providers?.grok ?? new GrokAcpHost(directory),
    devin: options.providers?.devin ?? new DevinAcpHost(directory),
  }
  const agentHost = new WorkspaceHost(options.host ?? new ConfiguredProviderHost({
    directory,
    hosts: {
      codex: new SottoThreadHost('codex', providers.codex!, threadRegistry!),
      claude: new SottoThreadHost('claude', providers.claude!, threadRegistry!),
      grok: new SottoThreadHost('grok', providers.grok!, threadRegistry!),
      devin: new SottoThreadHost('devin', providers.devin!, threadRegistry!),
    },
    provider: () => agentControl.configuration().provider,
    enabledProviders: () => { const configuration = agentControl.configuration(); return configuration.enabledProviders ?? [configuration.provider] },
    threadProvider: threadId => threadRegistry?.byThread(threadId)?.provider,
  }), directory, options.historyEnabled)
  agentHost.setWorkingCopyDefaults(projectId => options.settings().projectThreadWorkingCopyDefaults[projectId] ?? options.settings().threadWorkingCopyDefault)
  let gitStatus: GitStatusReader | undefined
  let gitHubRateLimit: GitHubRateLimit | undefined
  let gitHubHosts: GitHubHosts | undefined
  /** How Git and gh are run; only a journey's stand-in changes it. */
  let gitRun: RunGitCommand | undefined
  if (options.gitStatus) {
    const { fetchIntervalMs, foreground, ghStandIn, log } = options.gitStatus
    if (ghStandIn) gitRun = runWithGhStandIn(ghStandIn)
    // One rate limit for the process: the status reader and the Pull request surface spend the same gh sign-in's points.
    gitHubRateLimit = new GitHubRateLimit(log ? { log } : {})
    // One answer, too, to which hosts gh asks as GitHub, so `gh auth status` and `ssh -G` run once for everything that asks.
    gitHubHosts = new GitHubHosts({ run: gitRun ?? runGitStatusCommand })
    gitStatus = new GitStatusReader({ fetchIntervalMs, rateLimit: gitHubRateLimit, hosts: gitHubHosts, ...(gitRun ? { run: gitRun } : {}) })
    // Automatically pull is read at every remote read, so turning it on or off applies without a restart on the desktop.
    agentHost.setGitStatus(gitStatus, { pollIntervalMs: fetchIntervalMs, autoPull: () => options.settings().gitAutoPull, ...(foreground ? { foreground } : {}) })
  }
  // Sotto's own short writing (ADR-0026): thread titles, branch names, commit and pull request drafts, each a
  // side call to the thread's own provider client. A design fixture host offers none, so its titles stay the stand-in.
  const shortTextWriter = new ShortTextWriter({
    write: (threadId, prompt, signal) => agentHost.writeShortText(threadId, prompt, signal),
    onFailure: failure => options.logFailure?.('short-writing-failed', `${failure.purpose} ${failure.reason}`),
  })
  agentHost.setBranchNameWriter(threadBranchWriter(shortTextWriter, options.writingSettings))
  // T3's Git actions (ADR-0027): the commit message and pull request text are the same side calls the forms use.
  if (gitStatus) agentHost.setGitActions(new GitActions({ status: gitStatus, ...(gitRun ? { run: gitRun } : {}), ...(gitHubHosts ? { hosts: gitHubHosts } : {}),
    writeCommitMessage: commitMessageWriter(shortTextWriter, options.writingSettings),
    writePullRequestText: pullRequestTextWriter(shortTextWriter, options.writingSettings),
    followPullRequestTemplates: async () => (await options.writingSettings()).followPullRequestTemplates }))
  // The branch's pull request as a Tools surface (ADR-0027): read and acted on through the same gh.
  if (gitStatus) agentHost.setGitPullRequests(new GitPullRequests({ ...(gitRun ? { run: gitRun } : {}), ...(gitHubRateLimit ? { rateLimit: gitHubRateLimit } : {}), ...(gitHubHosts ? { hosts: gitHubHosts } : {}) }))
  const turns = new TurnRecorder({ directory, resolveSession: id => { const binding = threadRegistry?.byThread(id); return binding ? { provider: binding.provider, sessionId: binding.sessionId } : undefined },
  })
  const reasoner = options.reasoner ?? new ConfiguredAgentReasoner(() => agentControl.configuration(), credentials, {
      claude: new ClaudeSubscriptionClient(join(directory, 'reasoning', 'claude')),
      codex: new CodexSubscriptionClient(join(directory, 'reasoning', 'codex')),
      grok: new GrokSubscriptionClient(join(directory, 'reasoning', 'grok')),
    })
  const agentControl: AgentControl = new AgentControl({
    directory, host: agentHost, credentials, turns,
    historyEnabled: options.historyEnabled, coordinatorEnabled: options.coordinatorEnabled, removalMode: true,
    ...(options.observeActiveThread === undefined ? {} : { observeActiveThread: options.observeActiveThread }),
    ...(options.authority ? { authority: options.authority } : {}),
    ...(options.preferences ? { preferences: options.preferences } : {}),
    ...(options.openThreadFolder ? { openThreadFolder: options.openThreadFolder } : {}),
    ...(options.bindRequestDraftDecision ? { bindRequestDraftDecision: options.bindRequestDraftDecision } : {}),
    ...(options.logFailure ? { logFailure: options.logFailure } : {}),
    ...(options.missingAttachment ? { missingAttachment: options.missingAttachment } : {}),
    ...(options.runsAs ? { runsAs: options.runsAs } : {}),
    ...(options.clients ? { clients: options.clients } : {}),
    ...(options.locateClient ? { locateClient: options.locateClient } : {}),
    ...(options.installedProviders ? { installedProviders: options.installedProviders } : {}),
    writeThreadTitle: threadTitleWriter(shortTextWriter, options.writingSettings),
    writeFirstMessageTitle: firstMessageTitleWriter(options.writingSettings),
    reasoner,
  })
  agentHost.setPendingThreadWork(threadId => agentControl.hasPendingThreadWork(threadId), threadId => agentControl.pendingThreadWorkReason(threadId))
  // Reclaims worktrees only under the rules the user turned on (ADR-0041); every rule starts off. The desktop's
  // local host and a headless host both own worktrees, so both get it. Its owner starts it once the owner's own
  // checks are wired (the desktop's open terminals), and close drains it before anything it asks is closed.
  // Auto-settle merged threads rides the same sweep: it asks GitHub the way the merged rule does, on the same hour.
  // The merged check spends the same sign-in's points as the status reader, and asks as its timer does (#820).
  const merged = options.worktreeCleanup?.pullRequestMerged
  const github = gitHubRateLimit && gitHubHosts ? { rateLimit: gitHubRateLimit, hosts: gitHubHosts } : undefined
  const worktreeCleanup = new WorktreeCleanup({ host: agentHost, rules: () => options.settings().worktreeCleanup,
    autoSettleMerged: () => options.settings().autoSettleMergedThreads, ...options.worktreeCleanup,
    ...merged && github ? { pullRequestMerged: (repositoryRoot: string, branch: string) => merged(repositoryRoot, branch, github) } : {} })
  // A paired client's Files, Changes and Agents for this host's threads (ADR-0025, October 5 amendment): reads only, over
  // the same working copies the desktop's own tools resolve. The headless host and the desktop's phone listener serve them.
  const toolReads = threadToolReads({ resolveBinding: threadId => agentControl.filesBinding(threadId), subagents: agentHost })
  // Babysitting (ADR-0061): the thread's host reads each babysat pull request every two minutes, whether or not a
  // window is in front, and hands each thread its news as a wake-up through the thread's own send path (decision 8).
  // A quiet ending takes back what a waiting wake-up said of that pull request (decision 9).
  const babysitTool = (threadId: string): boolean => options.babysitting?.agentTool?.() === true && agentHost.admitsBabysitting(threadId)
  const deliverWakeUp: BabysitDeliver = (threadId, news) => agentControl.deliverWakeUp(threadId, news, { tool: babysitTool(threadId) })
  const QUIET_ENDINGS: ReadonlySet<BabysitEndReason> = new Set(['stopped-by-agent', 'stopped-by-user', 'switched-off', 'settled', 'archived', 'unlinked', 'forgotten'])
  const babysitRun = options.babysitting?.run ?? gitRun
  const babysitter = gitHubRateLimit && options.gitStatus ? new Babysitter({ store: agentHost, deliver: deliverWakeUp, rateLimit: gitHubRateLimit,
    ...(babysitRun ? { run: babysitRun } : {}), ...(options.gitStatus.log ? { log: options.gitStatus.log } : {}),
    ended: async (threadId, url, reason) => { if (QUIET_ENDINGS.has(reason)) await agentControl.withdrawWakeUp(threadId, url, { tool: babysitTool(threadId) }).catch(() => undefined) } }) : undefined
  // A part of a wake-up may go only while the babysitting it is news of still stands, and an agent's only while the
  // switch is on, a last one included; a user's last wake-up for an ending goes. Asked as the wake-up goes, whatever
  // withdrawal managed.
  const wakeUpDue = (threadId: string, news: BabysitNews): boolean =>
    babysitter ? wakeUpPartDue(news, babysitter.list(threadId), options.babysitting?.agentTool?.() !== false) : true
  // Given before start, so a wake-up restored from the queue is asked about too, even when taking it back failed.
  if (babysitter) agentControl.useBabysitting(babysitter, { due: wakeUpDue, tool: babysitTool })
  let closing: Promise<void> | undefined
  const close = (): Promise<void> => {
    closing ??= (async () => {
      // A sweep in progress finishes its current worktree, and takes no other, before the host it asks is closed.
      // A babysitting pass finishes the pull request it is on, and records what it told, the same way.
      await worktreeCleanup.close()
      if (babysitter) await babysitter.close()
      toolReads.dispose()
      agentControl.dispose()
      try {
        const results = await Promise.allSettled([reasoner.close?.(), shortTextWriter.close(), ...Object.values(providers).map(provider => provider.closed?.())])
        await agentControl.closed()
        // A connection already starting when stop was requested has now settled. Stop and drain
        // once more so it cannot leave a late child outside the first provider closure snapshot.
        agentHost.disconnect()
        const finalClosures = await Promise.allSettled(Object.values(providers).map(provider => provider.closed?.()))
        results.push(...finalClosures)
        await threadRegistry?.flush()
        const failure = results.find(result => result.status === 'rejected')
        if (failure?.status === 'rejected') throw failure.reason
      } finally { await agentHost.close() }
    })()
    return closing
  }
  // The switch turned off while Sotto was closed ends what agents started, and takes back the wake-ups they left
  // waiting, before the queue can send anything and before the first pass reads anything (ADR-0061 decision 12); the
  // desktop ends it again whenever the switch is saved off.
  const switchedOff = babysitter && options.babysitting?.agentTool?.() === false ? babysitter : undefined
  try {
    await agentControl.start(switchedOff ? { beforeConnect: async () => { await switchedOff.stop({ startedBy: 'agent' }, 'switch').catch(() => 0) } } : {})
  } catch (error) {
    void babysitter?.close()
    agentControl.dispose()
    await Promise.allSettled([reasoner.close?.(), shortTextWriter.close(), ...Object.values(providers).map(provider => provider.closed?.())])
    agentHost.dispose()
    throw error
  }
  const hostService = new LocalHostService({ control: agentControl, events: agentHost, tools: toolReads, babysitting: babysitter !== undefined })
  babysitter?.begin()
  return { agentHost, agentControl, threadRegistry, turns, hostService, shortTextWriter, worktreeCleanup, babysitter, close }
}
