import type { createAgentRuntime } from '../agents/runtime'
import type { LocalHostControl, HostService } from '../agents/hostService'
import type { WatcherRecords } from '../agents/watcherRecords'

type RunningRuntime = Awaited<ReturnType<typeof createAgentRuntime>>

/** The desktop integrations shared by a running local host and its disabled state. */
export type DesktopLocalRuntime = Omit<Partial<RunningRuntime>, 'agentControl' | 'agentHost' | 'hostService' | 'turns' | 'worktreeCleanup' | 'close' | 'threadRegistry'> & {
  agentControl: LocalHostControl & Pick<RunningRuntime['agentControl'],
    'attachmentPreview' | 'stageAttachment' | 'stageAttachmentFile' | 'attachmentContent' | 'gitRefs' | 'gitChangedFiles' | 'gitPullRequest' | 'gitPullRequestList' |
    'subscribeThreadDetail' | 'questionPage' | 'questionPageOpened' | 'useCouncil' | 'commandFromCouncil' | 'refreshCouncilObservation' |
    'hostId' | 'configuration' | 'command' | 'onThreadsDeleted' | 'checkClientsAfresh' | 'privacyChanged' |
    'dispose' | 'closed' | 'hasPendingThreadWork' | 'watcherObservationsEnabled' | 'useSottoRequests' |
    'refreshRequestDraft' | 'requestDraftView' | 'requestAnswerRecovery' | 'threadMedia' | 'threadMediaVideo' |
    'filesBinding' | 'projects' | 'watcherSnapshot' | 'delegationMessage' | 'checkpointObserved' | 'restoreCheckpoint'> & {
      watcherRecords: Pick<WatcherRecords, 'view'>
    }
  agentHost: Pick<RunningRuntime['agentHost'],
    'watcherThreadIds' | 'dormantThreadIds' | 'workspaceSnapshot' | 'snapshot' | 'subscribe' | 'subscribeSubagents' |
    'setCheckpointHooks' | 'useBrowserTools' | 'useThreadTools' | 'setMutationGuard' | 'gitActionFinished' |
    'dispose' | 'disconnect' | 'close' | 'admitsVisuals' | 'addVisual' | 'admitsShownMedia' | 'showMedia' | 'admitsPluginTools' |
    'admitsTellWatcher' | 'threadMessage' | 'threadMessages' | 'visual' | 'acquireTerminalStart' | 'setWorktreeInUse' |
    'workingCopyOptions' | 'writeShortTextOn' | 'subagentPage' | 'subagentAssignments' | 'admitsBabysitting' |
    'threadPullRequests' | 'linkThreadPullRequest' | 'preservesDormantThread' | 'rollbackCapability' |
    'setDelegatedBy' | 'recordSottoMessage' | 'isCheckoutMutating' | 'acquireCheckoutRead' | 'acquireCheckoutMutation' | 'rollbackThread' | 'refreshThread'>
  threadRegistry: RunningRuntime['threadRegistry']
  hostService: HostService & Pick<RunningRuntime['hostService'], 'setWindowFocused' | 'hostFolders'>
  turns: Pick<RunningRuntime['turns'], 'path' | 'recent'>
  worktreeCleanup: Pick<RunningRuntime['worktreeCleanup'], 'start' | 'settingsChanged' | 'dispose' | 'request' | 'close'>
  close: RunningRuntime['close']
}
