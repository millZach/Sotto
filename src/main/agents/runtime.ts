import { join } from 'node:path'
import type { ProviderId } from '../../shared/agents'
import type { AppSettings } from '../../shared/settings'
import { ShortTextWriter } from '../llm/shortTextWriter'
import { threadTitleWriter } from '../llm/threadTitle'
import { threadBranchWriter } from '../llm/threadBranch'
import { CodexAppServerHost } from './codex'
import { ClaudeStreamJsonHost } from './claude'
import { GrokAcpHost } from './grok'
import { DevinAcpHost } from './devin'
import { ConfiguredProviderHost } from './providerSwitch'
import { SottoThreadHost, ThreadRegistry } from './threads'
import { WorkspaceHost } from './workspace'
import { AgentControl } from './control'
import { TurnRecorder } from './turns'
import { AgentMembershipClient } from './membership'
import { ConfiguredAgentReasoner } from './reasoning'
import { ClaudeSubscriptionClient } from './subscriptionClaude'
import { CodexSubscriptionClient } from './subscriptionCodex'
import { GrokSubscriptionClient } from './subscriptionGrok'
import { LocalHostService } from './hostService'
import { GitStatusReader, runWithGhStandIn, type RunGitCommand } from './gitStatus'
import { GitActions } from './gitActions'
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
  releaseClient?: ControlDependencies['releaseClient']
  /** Desktop design fixtures replace the whole provider boundary. */
  host?: AgentHost
  /** Native process overrides keep tests on the production coordinator path. */
  providers?: Partial<Record<ProviderId, NativeHost>>
  reasoner?: ControlDependencies['reasoner']
  /**
   * Git status the way T3 reads it: how often a project's origin may be fetched in the background, and
   * whether a window is in front to read for. Absent, thread records carry no Git status.
   */
  gitStatus?: { fetchIntervalMs: () => number; foreground?: () => boolean
    /** A scripted `gh` for a journey in the running app; development only. */
    ghStandIn?: { executable: string; args: readonly string[] } }
  /** What the worktree cleanup (ADR-0019) may reach beyond the workspace: GitHub for the merged rule and Auto-settle
   * merged threads, and a log of stable event names. Without `pullRequestMerged` neither fires; the other rules read only the repository. */
  worktreeCleanup?: Pick<WorktreeCleanupDependencies, 'pullRequestMerged' | 'log'>
}

/** The provider stack both Electron main and a plain Node host own. No client transport lives here. */
export async function createAgentRuntime(options: AgentRuntimeOptions) {
  const { directory, credentials } = options
  const threadRegistry = options.host ? null : new ThreadRegistry(directory)
  const providers: Partial<Record<ProviderId, NativeHost>> = options.host ? {} : {
    codex: options.providers?.codex ?? new CodexAppServerHost({ userDataPath: directory }),
    claude: options.providers?.claude ?? new ClaudeStreamJsonHost({ userDataPath: directory, ...(options.claudeHistoryModulePath ? { historyModulePath: options.claudeHistoryModulePath } : {}) }),
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
  /** How Git and gh are run; only a journey's stand-in changes it. */
  let gitRun: RunGitCommand | undefined
  if (options.gitStatus) {
    const { fetchIntervalMs, foreground, ghStandIn } = options.gitStatus
    if (ghStandIn) gitRun = runWithGhStandIn(ghStandIn)
    gitStatus = new GitStatusReader({ fetchIntervalMs, ...(gitRun ? { run: gitRun } : {}) })
    // Automatically pull is read at every remote read, so turning it on or off applies without a restart on the desktop.
    agentHost.setGitStatus(gitStatus, { pollIntervalMs: fetchIntervalMs, autoPull: () => options.settings().gitAutoPull, ...(foreground ? { foreground } : {}) })
  }
  // Sotto's own short writing (ADR-0026): thread titles, branch names, commit and pull request drafts, each a
  // side call to the thread's own provider client. A design fixture host offers none, so its titles stay the stand-in.
  const shortTextWriter = new ShortTextWriter({
    write: (threadId, prompt, signal) => agentHost.writeShortText(threadId, prompt, signal),
    onFailure: failure => options.logFailure?.('short-writing-failed', failure.purpose + ' ' + failure.reason),
  })
  agentHost.setBranchNameWriter(threadBranchWriter(shortTextWriter, options.writingSettings))
  // T3's Git actions (ADR-0027): the commit message and pull request text are the same side calls the forms use.
  if (gitStatus) agentHost.setGitActions(new GitActions({ status: gitStatus, ...(gitRun ? { run: gitRun } : {}),
    writeCommitMessage: commitMessageWriter(shortTextWriter, options.writingSettings),
    writePullRequestText: pullRequestTextWriter(shortTextWriter, options.writingSettings),
    followPullRequestTemplates: async () => (await options.writingSettings()).followPullRequestTemplates }))
  // The branch's pull request as a Tools surface (ADR-0027): read and acted on through the same gh.
  if (gitStatus) agentHost.setGitPullRequests(new GitPullRequests(gitRun ? { run: gitRun } : {}))
  const turns = new TurnRecorder({ directory, historyEnabled: options.historyEnabled,
    resolveSession: id => { const binding = threadRegistry?.byThread(id); return binding ? { provider: binding.provider, sessionId: binding.sessionId } : undefined },
  })
  const membership = new AgentMembershipClient({ configuration: () => agentControl.configuration(),
    credentials, directory, openExternal: options.openExternal,
  })
  const reasoner = options.reasoner ?? new ConfiguredAgentReasoner(() => agentControl.configuration(), credentials, {
      claude: new ClaudeSubscriptionClient(join(directory, 'reasoning', 'claude')),
      codex: new CodexSubscriptionClient(join(directory, 'reasoning', 'codex')),
      grok: new GrokSubscriptionClient(join(directory, 'reasoning', 'grok')),
    })
  const agentControl: AgentControl = new AgentControl({
    directory, host: agentHost, credentials, membership, turns,
    historyEnabled: options.historyEnabled, coordinatorEnabled: options.coordinatorEnabled,
    ...(options.observeActiveThread === undefined ? {} : { observeActiveThread: options.observeActiveThread }),
    ...(options.authority ? { authority: options.authority } : {}),
    ...(options.preferences ? { preferences: options.preferences } : {}),
    ...(options.openThreadFolder ? { openThreadFolder: options.openThreadFolder } : {}),
    ...(options.bindRequestDraftDecision ? { bindRequestDraftDecision: options.bindRequestDraftDecision } : {}),
    ...(options.logFailure ? { logFailure: options.logFailure } : {}),
    ...(options.releaseClient ? { releaseClient: options.releaseClient } : {}),
    writeThreadTitle: threadTitleWriter(shortTextWriter, options.writingSettings),
    reasoner,
  })
  // Reclaims worktrees only under the rules the user turned on (ADR-0019); every rule starts off. The desktop's
  // local host and a headless host both own worktrees, so both get it. Its owner starts it once the owner's own
  // checks are wired (the desktop's open terminals), and close drains it before anything it asks is closed.
  // Auto-settle merged threads rides the same sweep: it asks GitHub the way the merged rule does, on the same hour.
  const worktreeCleanup = new WorktreeCleanup({ host: agentHost, rules: () => options.settings().worktreeCleanup,
    autoSettleMerged: () => options.settings().autoSettleMergedThreads, ...options.worktreeCleanup })
  let closing: Promise<void> | undefined
  const close = (): Promise<void> => {
    closing ??= (async () => {
      // A sweep in progress finishes its current worktree, and takes no other, before the host it asks is closed.
      await worktreeCleanup.close()
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
  try { await agentControl.start() } catch (error) {
    agentControl.dispose()
    await Promise.allSettled([reasoner.close?.(), shortTextWriter.close(), ...Object.values(providers).map(provider => provider.closed?.())])
    agentHost.dispose()
    throw error
  }
  const hostService = new LocalHostService({ control: agentControl, events: agentHost })
  return { agentHost, agentControl, threadRegistry, turns, membership, hostService, shortTextWriter, worktreeCleanup, close }
}
