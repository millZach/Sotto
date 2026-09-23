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
import type { AgentHost } from './host'

type ControlDependencies = ConstructorParameters<typeof AgentControl>[0]
type NativeHost = AgentHost & { closed?: () => Promise<void> }

export interface AgentRuntimeOptions {
  directory: string
  claudeHistoryModulePath?: string
  credentials: ControlDependencies['credentials']
  settings: () => AppSettings
  formattingSettings: () => Promise<AppSettings>
  historyEnabled: () => boolean
  coordinatorEnabled: () => boolean
  observeActiveThread?: boolean
  openExternal: (url: string) => Promise<unknown>
  openThreadFolder?: ControlDependencies['openThreadFolder']
  authority?: ControlDependencies['authority']
  preferences?: ControlDependencies['preferences']
  bindRequestDraftDecision?: ControlDependencies['bindRequestDraftDecision']
  logFailure?: ControlDependencies['logFailure']
  shortTextWriter?: ShortTextWriter
  /** Desktop design fixtures replace the whole provider boundary. */
  host?: AgentHost
  /** Native process overrides keep tests on the production coordinator path. */
  providers?: Partial<Record<ProviderId, NativeHost>>
  reasoner?: ControlDependencies['reasoner']
}

/** The provider stack both Electron main and a plain Node host own. No client transport lives here. */
export async function createAgentRuntime(options: AgentRuntimeOptions) {
  const { directory, credentials } = options
  const shortTextWriter = options.shortTextWriter ?? new ShortTextWriter({
    getSettings: options.formattingSettings,
    onFailure: failure => options.logFailure?.('writing-model-failed', failure.purpose + ' ' + failure.reason),
  })
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
  agentHost.setBranchNameWriter(threadBranchWriter(shortTextWriter, options.formattingSettings))
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
    writeThreadTitle: threadTitleWriter(shortTextWriter, options.formattingSettings),
    reasoner,
  })
  let closing: Promise<void> | undefined
  const close = (): Promise<void> => {
    closing ??= (async () => {
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
  return { agentHost, agentControl, threadRegistry, turns, membership, hostService, close }
}
