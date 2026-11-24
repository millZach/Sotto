import { t } from '@lingui/core/macro'
import { appendFile, writeFile } from 'node:fs/promises'
import { hostname as osHostname } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { PictureMaker, BUILT_PICTURE_WORKER, formatPictureWorkerLog } from '../../host/pictureMaker'
import { AGENT_E2E, AGENT_STATE, AGENT_THREAD_DETAIL, PROVIDER_LABELS } from '../../shared/agents'
import type { AgentActivity } from '../../shared/agentActivity'
import { isAgentThreadDetailDelta } from '../../shared/agentThreadDetail'
import { BROWSER_EVENT, BROWSER_FRAME_EVENT } from '../../shared/browser'
import { hostEntityKey, parseHostEntityKey } from '../../shared/clientIdentity'
import { E2E_COMPUTER_NAME, E2E_DELEGATION_TOOL_CHANNEL, E2E_HOST_SETUP_TOOL_CHANNEL, E2E_MEDIA_TOOL_CHANNEL, E2E_PLUGIN_TOOL_CHANNEL, E2E_VISUAL_TOOL_CHANNEL, e2eAgentEventSchema, e2eDelegationToolSchema, e2eHostSetupToolSchema, e2ePluginToolSchema, e2eVisualToolSchema } from '../../shared/e2e'
import { FILES_DOWNLOAD_PROGRESS } from '../../shared/files'
import { GIT_CHANGES_EVENT } from '../../shared/gitChanges'
import { heldProvidersOf, releasesHeldProvider } from '../../shared/heldProviders'
import { HOSTS_CHANGED } from '../../shared/hosts'
import { LOCAL_APPS_CHANGED } from '../../shared/localApps'
import { MAIN_CHECKOUT_CHANGED } from '../../shared/mainCheckout'
import { MEMORY_CHANGED } from '../../shared/memory'
import { MODEL_VISUAL_KIND, MODELS_3D_LISTED_MAX, PLUGINS_MODEL_3D_CHANGED, PLUGINS_MODELS_3D_REMOVED } from '../../shared/models3d'
import { NEXT_PROMPT_CHANGED } from '../../shared/nextPrompt'
import { PHONES_CHANGED } from '../../shared/phones'
import { isMailPlugin, PLUGIN_USE_THREAD_TITLE_MAX, PLUGINS_COPIES_CHANGED, PLUGINS_ELEVENLABS_SPENT_CHANGED, PLUGINS_MAIL_GRANTS_CHANGED, PLUGINS_MESHY_CREDITS_CHANGED } from '../../shared/plugins'
import { POPUP_THREAD } from '../../shared/popup'
import { getReleaseTrack } from '../../shared/releaseTrack'
import { REQUEST_DRAFT_CHANGED } from '../../shared/requestDrafts'
import type { AppSettings } from '../../shared/settings'
import { PLUGINS_SOUND_CHANGED, SOUND_VISUAL_KIND } from '../../shared/sounds'
import { SUBAGENTS_CHANGED } from '../../shared/subagents'
import { TEAMS_CHANGED } from '../../shared/teams'
import { isThreadClosed } from '../../shared/threadActivity'
import { WATCHER_CHANGED } from '../../shared/watcherRoom'
import { isImmutableActivities } from '../agents/activitySnapshots'
import { AgentStateBroadcaster } from '../agents/agentStateBroadcast'
import { BranchBundles } from '../agents/branchBundles'
import { registerCheckQueueIpc } from '../agents/checkQueueIpc'
import { registerContinueIpc } from '../agents/continueThreadIpc'
import { CouncilToolServer, councilUserMessage } from '../agents/councilTools'
import { CursorAcpHost } from '../agents/cursor'
import { registerCursorSignInIpc } from '../agents/cursorSignInIpc'
import { registerAntigravityAccountIpc } from '../agents/antigravityAccountIpc'
import { registerDelegationIpc } from '../agents/delegationIpc'
import { DelegationToolServer } from '../agents/delegationTools'
import { CoordinationToolServer } from '../agents/threadCoordinationTools'
import { registerThreadCoordinationIpc } from '../agents/threadCoordinationIpc'
import { DesktopCoordinationRelay } from '../agents/threadCoordinationRelay'
import { DevinAcpHost } from '../agents/devin'
import { DynamicRecord } from '../agents/dynamicRecord'
import { registerDynamicRecordIpc } from '../agents/dynamicRecordIpc'
import { resetGhLookup } from '../agents/git/ghCommand'
import { GitUnavailableError, runGitStatusCommand, runWithGhStandIn, type RunGitCommand } from '../agents/git/gitStatus'
import { HermesKeys, forgetHermesKey } from '../agents/hermesRuntime'
import { detectInstalledProviders } from '../agents/installedProviders'
import { registerAgentIpcCore } from '../agents/ipcCore'
import { registerLocalProviderSignInIpc } from '../agents/localProviderSignInIpc'
import { registerMainCheckoutIpc } from '../agents/mainCheckoutIpc'
import { MediaToolServer, SHOW_IN_THREAD_TOOL } from '../agents/mediaTools'
import { KeptThumbnails, MEDIA_TILE_SIZE, ReducedPictures } from '../agents/mediaThumbnail'
import { MuseMspHost } from '../agents/muse'
import { registerNextPromptIpc, windowNextPrompt } from '../agents/nextPromptIpc'
import { nextPromptWatcherFacts } from '../agents/nextPromptProject'
import { OpenCodeHost } from '../agents/opencode'
import { registerOpenCodeSignInIpc } from '../agents/opencodeSignInIpc'
import { ClaudeStreamJsonHost } from '../agents/providers/claude/claude'
import { CodexAppServerHost } from '../agents/providers/codex/codex'
import { PullRequestToolServer } from '../agents/pullRequestTools'
import { registerRequestDraftIpc } from '../agents/requestDraftIpc'
import { requestDraftOwnerState, requestDraftWatcherOwnerIds } from '../agents/requestDraftOwners'
import { RequestDraftService } from '../agents/requestDrafts'
import { RetainedDraftStore } from '../agents/retainedDraftStore'
import { createAgentRuntime } from '../agents/runtime'
import { SIDE_WRITING_TIMEOUT_MS } from '../agents/sideWriting'
import { combinedSottoRequests } from '../agents/sottoRequests'
import { coalesceAgentStatePublishes, coalesceAgentThreadDetailPublishes } from '../agents/statePublishers'
import { registerSubagentIpc } from '../agents/subagentIpc'
import { DesktopTellWatcherRelay } from '../agents/tellWatcherRelay'
import { tellWatcherTools } from '../agents/tellWatcherTools'
import { ThreadMediaStore, agentCaptures } from '../agents/threadMedia'
import { moveTargetsOf } from '../agents/threadMoves'
import { registerThreadMoveIpc } from '../agents/threadMovesIpc'
import { registerUsageIpc } from '../agents/usageIpc'
import { VISUALIZE_TOOL, VisualToolServer } from '../agents/visualTools'
import { createWatcherRoomDesktop } from '../agents/watcherRoomDesktop'
import { windowHistories } from '../agents/windowActivityBodies'
import { githubBaseBranchChecks, githubOpenPullRequestBranches, githubPullRequestMerged, githubPullRequestState } from '../agents/worktreeCleanup'
import { registerCouncilIpc } from '../council/councilIpc'
import { CouncilService } from '../council/councilService'
import { E2EAgentHost, e2eAgentReasoner } from '../e2e/agentEffects'
import { installBabysitPassE2E } from '../e2e/babysitPass'
import { e2eHostsTailscale } from '../e2e/hostsTailscale'
import { installRemoteHostE2E } from '../e2e/remoteHost'
import { e2eSshStandIn } from '../e2e/sshStandIn'
import { e2eTailnetMap } from '../e2e/tailnetStandIn'
import { e2eTailscale } from '../e2e/tailscale'
import { e2eTeamFetch } from '../e2e/teamFetch'
import { FileDownloads } from '../files/downloads'
import { registerFilesIpc } from '../files/ipc'
import { FilesService } from '../files/service'
import { routerBusyThreads } from '../hosts/busyHost'
import { CascadedSettles } from '../hosts/crossMachineCascade'
import { DesktopDefaultsPush, followDesktopDefaults } from '../hosts/desktopDefaults'
import { DesktopHostRouter } from '../hosts/desktopHostRouter'
import { DesktopHosts } from '../hosts/desktopHosts'
import { HostBootChanges } from '../hosts/hostBootStart'
import { HostModels3d } from '../hosts/hostModels3d'
import { HostPhones } from '../hosts/hostPhones'
import { HostProviderJobs } from '../hosts/hostProviderJob'
import { hostReleaseVersion } from '../hosts/hostReleaseVersion'
import { HostSetup, hostSetupRequests } from '../hosts/hostSetup'
import { coordinatorSetupThreads } from '../hosts/hostSetupThreads'
import { HostSetupToolServer, agentJobTools } from '../hosts/hostSetupTools'
import { HostSounds } from '../hosts/hostSounds'
import { HostUpdates } from '../hosts/hostUpdate'
import { emptyDesktopState, inactiveLocalHost } from '../hosts/inactiveLocalHost'
import { registerHostsIpc } from '../hosts/ipc'
import type { DesktopLocalRuntime } from '../hosts/localRuntime'
import { SshHostLauncher } from '../hosts/sshLauncher'
import { discoverSshHosts } from '../hosts/sshSuggestions'
import { HostTailscale } from '../hosts/tailscale'
import { interfaceClockTime } from '../interfaceClock'
import { isAuthorizedIpcSender } from '../ipc/registerIpc'
import { nextPromptWatcherRequest, parseNextPrompt } from '../llm/nextPrompt'
import { OwnCleanupMeasures } from '../llm/ownServerCleanup'
import { registerOwnServerCleanupIpc } from '../llm/ownServerCleanupIpc'
import { registerMemoryIpc } from '../memory/ipc'
import { PolicyStore } from '../memory/policies'
import { MemoryProfile } from '../memory/profile'
import { openRuntimeMemory } from '../memory/runtime'
import { openNotificationThread } from '../notifications/openNotificationThread'
import { ThreadAlerts } from '../notifications/threadAlerts'
import { ModelCatalogue } from '../ownModelServers/catalogue'
import { registerOwnServersIpc } from '../ownModelServers/ipc'
import { OwnServers, type OwnServersDeepSeek, type OwnServersHermes, type OwnServersOpenCode } from '../ownModelServers/service'
import { registerLocalAppsIpc, registerPhonesIpc } from '../phones/ipc'
import { LocalApps } from '../phones/localApps'
import { PhoneAccess } from '../phones/phoneAccess'
import { phoneSendsFor } from '../../host/phoneSends'
import { TailscaleCli, tailscaleInvoker } from '../phones/tailscale'
import { PluginAccounts } from '../plugins/accounts'
import { wordPluginChange } from '../plugins/changeWords'
import { PluginAccountCopySync } from '../plugins/copySync'
import { checkElevenLabsKey, type ElevenLabsFetch } from '../plugins/elevenlabs/account'
import { readGitHubSignIn, sharedGitHubSignIn } from '../plugins/github/signIn'
import { readHostGitHubSignIns } from '../plugins/hostSignIns'
import { registerPluginsIpc } from '../plugins/ipc'
import { bridgeStatus, checkMailAccount } from '../plugins/mail/accounts'
import type { MailOptions } from '../plugins/mail/read'
import { mailOnThisComputer } from '../plugins/mail/standIn'
import { MailGrants, mailGrantsShown, mailThreadOpen, ownThreadId } from '../plugins/mailGrants'
import { checkMeshyKey, type MeshyFetch } from '../plugins/meshy/account'
import { PluginChangeRequests } from '../plugins/pendingChanges'
import { PluginToolServer } from '../plugins/pluginTools'
import { pluginFolderOfThread, pluginProjects } from '../plugins/projectFolders'
import { PluginSpendingSync, centsByAccount } from '../plugins/spendingSync'
import { pluginToolHandlers } from '../plugins/toolHandlers'
import { PluginUseRecord } from '../plugins/useRecord'
import { checkVercelToken, type VercelFetch } from '../plugins/vercel/read'
import { PopupFeed } from '../popup/popupFeed'
import { registerProductEventsIpc } from '../productEvents/ipc'
import { createProductEvents, productEventsOffBy, productEventsPermission } from '../productEvents/productEvents'
import { cleanSettingsHistory } from '../settings/privacyCleanup'
import { RetiredChatHistory } from '../settings/retiredChats'
import { registerTeamsIpc } from '../teams/ipc'
import { TeamService } from '../teams/teams'
import { connectCheckpoints } from '../tools/checkpointIntegration'
import type { ElevenLabsApiFetch } from '../tools/elevenlabs/api'
import { SoundRecords } from '../tools/elevenlabs/records'
import { ElevenLabsSounds, type SoundRequest } from '../tools/elevenlabs/service'
import { revealSoundFile, soundBytes, soundViewOf, soundViewPush, type SoundViewSource } from '../tools/elevenlabs/view'
import { GitChangesService } from '../tools/gitChanges'
import type { MeshyApiFetch } from '../tools/meshy/api'
import { hostModelViews, type HostModelViewsWithNews } from '../tools/meshy/hostViews'
import { listModels, removeGoneModel, revealModelFile, type ModelListSource } from '../tools/meshy/page'
import { checkPhoto, photoToSend, type RedrawPhoto } from '../tools/meshy/photo'
import { ModelRecords } from '../tools/meshy/records'
import { MeshyModels } from '../tools/meshy/service'
import { modelBytes, modelView, modelViewOf } from '../tools/meshy/view'
import { FilesBindingsTracker } from './filesBindingsMirror'
import { EngineIpcRegistry } from './ipcRegistry'
import { startRustLocalEngine } from './rustLocalEngineClient'
import type { DesktopEngine, DesktopEngineOptions, EngineShellBridge, EngineWindowFocus, GitChangesMethod, HostedGitChangesMethod } from './types'

/**
 * Builds the entire Electron-free desktop engine behind one boundary (ADR-0210).
 * Runs in-process when `out-of-process-engine` is off and inside a dedicated child process when it is on.
 */
export async function createDesktopEngine(options: DesktopEngineOptions, shellBridge: EngineShellBridge): Promise<DesktopEngine> {
  const {
    userDataPath,
    appRunningVersion,
    appVersion,
    isPackaged,
    owlFeatures,
    startupSettings,
    phoneCompression,
    desktopNotificationsEnabled,
    e2eConfiguration,
    claudeHistoryModulePath,
    env,
  } = options

  const log = (code: string): void => shellBridge.log(code)
  const memoryStore = openRuntimeMemory(join(userDataPath, 'memory.sqlite'), log)
  const memoryProfile = memoryStore === undefined ? undefined : new MemoryProfile(memoryStore)
  const authority = memoryStore === undefined ? undefined : new PolicyStore(memoryStore)

  const watcherEnabled = owlFeatures.watcher
  const heldProviders = heldProvidersOf(owlFeatures)
  const usageEnabled = owlFeatures.usage
  const cleanupModelEnabled = owlFeatures['cleanup-model']
  const delegationEnabled = owlFeatures['thread-delegation']
  const parentCoordinationEnabled = owlFeatures['parent-thread-coordination']
  const councilEnabled = owlFeatures.council
  const localAppsEnabled = owlFeatures['local-apps']
  const pluginsEnabled = owlFeatures.plugins
  const workerRolesEnabled = owlFeatures['worker-roles']
  const threadStartsEnabled = owlFeatures['continue-agent-thread']
  const agentsViewEnabled = owlFeatures['iphone-agents-view']
  const continueEnabled = owlFeatures['continue-on-provider']
  const crossMachineEnabled = owlFeatures['cross-machine-work']
  const pairedHostBrowser = owlFeatures['paired-host-browser'] && owlFeatures['quiet-browser']
  const nextPromptEnabled = owlFeatures['next-prompt']
  const babysittingRetired = owlFeatures['restart-stopped-threads']
  const keepMainCurrentEnabled = owlFeatures['keep-main-current'] && startupSettings.localHostEnabled && env['SOTTO_DESIGN_CAPTURE'] !== '1'
  const hostVersion = hostReleaseVersion(appRunningVersion, appVersion, usageEnabled || releasesHeldProvider(heldProviders))
  const releaseTrack = getReleaseTrack(appRunningVersion)

  let workingCopySettings: AppSettings = startupSettings
  let agentHistoryEnabled = startupSettings.historyEnabled
  let waitingHostVersion: string | undefined
  let windowFocus: EngineWindowFocus = { focused: false, showing: false, blurredAt: 0 }
  let popupShown = false
  let runningTerminalThreads = new Set<string>()
  const terminalLeases = new Map<string, () => void>()

  const productEvents = createProductEvents({
    released: isPackaged,
    dataDirectory: userDataPath,
    holdWhileWaiting: false,
    version: appRunningVersion,
    channel: releaseTrack,
    surface: 'desktop',
    log: event => console.warn(event),
  })
  productEvents.setPermission(productEventsPermission(workingCopySettings))

  const ownServers: OwnServers | undefined = owlFeatures['own-model-servers'] && (!heldProviders.has('opencode') || !heldProviders.has('deepseek') || !heldProviders.has('hermes')) && startupSettings.localHostEnabled
    ? new OwnServers({
        directory: userDataPath,
        ...(e2eConfiguration ? { catalogue: new ModelCatalogue(async () => { throw new Error('E2E_NETWORK_DISABLED') }) } : {}),
        openCode: (): OwnServersOpenCode | undefined => localRuntime?.ownServersOpenCode,
        deepSeek: (): OwnServersDeepSeek | undefined => localRuntime?.ownServersDeepSeek,
        hermes: (): OwnServersHermes | undefined => localRuntime?.ownServersHermes,
        readKey: async id => (await new HermesKeys(join(userDataPath, 'hermes', 'own-server-keys.json')).read())[id],
        replaceHeldHermesKey: async (id, key) => {
          const keys = new HermesKeys(join(userDataPath, 'hermes', 'own-server-keys.json'))
          if ((await keys.read())[id] !== undefined) await keys.keep(id, key)
        },
        forgetHermesKey: id => forgetHermesKey(join(userDataPath, 'hermes'), id),
        log,
      })
    : undefined

  const ownServerCleanup: OwnCleanupMeasures | undefined = ownServers && cleanupModelEnabled && owlFeatures['own-server-cleanup']
    ? new OwnCleanupMeasures({
        directory: userDataPath,
        servers: () => ownServers.list(),
        log,
        ...(e2eConfiguration === null ? {} : { fetchFn: () => Promise.reject(new Error('E2E_NETWORK_DISABLED')) }),
      })
    : undefined

  const retiredChatHistory = new RetiredChatHistory(userDataPath, () => agentHistoryEnabled)

  // E2E development provider stand-ins (never read in packaged builds).
  const devinFixtureRoot = e2eConfiguration !== null && !isPackaged ? env['SOTTO_E2E_DEVIN_ROOT'] : undefined
  const devinFixtureExecutable = env['SOTTO_E2E_DEVIN_EXECUTABLE']
  if (devinFixtureRoot && (!isAbsolute(devinFixtureRoot) || !devinFixtureExecutable || !isAbsolute(devinFixtureExecutable))) {
    throw new Error('The Devin test fixture requires absolute paths.')
  }
  const museFixtureRoot = e2eConfiguration !== null && !isPackaged ? env['SOTTO_E2E_MUSE_ROOT'] : undefined
  const museFixtureExecutable = env['SOTTO_E2E_MUSE_EXECUTABLE']
  if (museFixtureRoot && (!isAbsolute(museFixtureRoot) || !museFixtureExecutable || !isAbsolute(museFixtureExecutable))) {
    throw new Error('The Muse test fixture requires absolute paths.')
  }
  const opencodeFixtureRoot = e2eConfiguration !== null && !isPackaged ? env['SOTTO_E2E_OPENCODE_ROOT'] : undefined
  const opencodeFixtureExecutable = env['SOTTO_E2E_OPENCODE_EXECUTABLE']
  if (opencodeFixtureRoot && (!isAbsolute(opencodeFixtureRoot) || !opencodeFixtureExecutable || !isAbsolute(opencodeFixtureExecutable))) {
    throw new Error('The OpenCode test fixture requires absolute paths.')
  }
  const cursorFixtureRoot = e2eConfiguration !== null && !isPackaged ? env['SOTTO_E2E_CURSOR_ROOT'] : undefined
  const cursorFixtureExecutable = env['SOTTO_E2E_CURSOR_EXECUTABLE']
  if (cursorFixtureRoot && (!isAbsolute(cursorFixtureRoot) || !cursorFixtureExecutable || !isAbsolute(cursorFixtureExecutable))) {
    throw new Error('The Cursor test fixture requires absolute paths.')
  }
  // Antigravity's real adapter over the fake `agy`, the same way; the runtime builds it, so its sign-in reads Settings as in use.
  const antigravityFixtureRoot = e2eConfiguration !== null && !isPackaged ? env['SOTTO_E2E_ANTIGRAVITY_ROOT'] : undefined
  const antigravityFixtureExecutable = env['SOTTO_E2E_ANTIGRAVITY_EXECUTABLE']
  if (antigravityFixtureRoot && (!isAbsolute(antigravityFixtureRoot) || !antigravityFixtureExecutable || !isAbsolute(antigravityFixtureExecutable))) {
    throw new Error('The Antigravity test fixture requires absolute paths.')
  }
  const nativeFixtureRoot = e2eConfiguration !== null && !isPackaged && !devinFixtureRoot && !museFixtureRoot && !opencodeFixtureRoot && !cursorFixtureRoot && !antigravityFixtureRoot ? env['SOTTO_E2E_NATIVE_FIXTURE_ROOT'] : undefined
  const nativeFixtureExecutable = env['SOTTO_E2E_NATIVE_FIXTURE_EXECUTABLE']
  if (nativeFixtureRoot && (!isAbsolute(nativeFixtureRoot) || !nativeFixtureExecutable || !isAbsolute(nativeFixtureExecutable))) {
    throw new Error('The native test fixture requires absolute paths.')
  }
  const testAgentHost = e2eConfiguration === null || devinFixtureRoot || museFixtureRoot || opencodeFixtureRoot || cursorFixtureRoot || antigravityFixtureRoot || nativeFixtureRoot ? null : new E2EAgentHost(e2eConfiguration.scenario)
  const ghStandInScript = e2eConfiguration !== null && !isPackaged ? env['SOTTO_E2E_GH_SCRIPT'] : undefined
  const ghStandInExecutable = env['SOTTO_E2E_GH_EXECUTABLE']
  if (ghStandInScript && (!isAbsolute(ghStandInScript) || !ghStandInExecutable || !isAbsolute(ghStandInExecutable))) throw new Error('The gh test stand-in requires absolute paths.')
  const ghStandIn = ghStandInScript && ghStandInExecutable ? { executable: ghStandInExecutable, args: [ghStandInScript] } : undefined
  if (testAgentHost !== null && env['SOTTO_DESIGN_CAPTURE'] !== '1') {
    await testAgentHost.initializeWorkingFolders(join(userDataPath, 'agent-workspaces'))
  }

  // Pictures in threads and Meshy photo redraws run in the pure-Node picture worker (ADR-0203, ADR-0210).
  const pictureWorkerPath = options.pictureWorkerPath ?? BUILT_PICTURE_WORKER
  const pictureMaker = PictureMaker.available(pictureWorkerPath)
    ? new PictureMaker(pictureWorkerPath, { log: (event, detail) => log(formatPictureWorkerLog(event, detail)) })
    : undefined
  if (!pictureMaker && options.isPackaged) log('picture-worker-missing')
  const threadMedia = owlFeatures['inline-media'] ? new ThreadMediaStore(userDataPath, { historyEnabled: () => agentHistoryEnabled }) : undefined
  const showEveryAgentPicture = (): boolean => workingCopySettings.showEveryAgentPicture
  const fixtureCaptures = threadMedia ? agentCaptures(threadMedia, showEveryAgentPicture) : {}
  const keptThumbnails = new KeptThumbnails()

  let teamReads: { readonly watcher: import('../agents/watcher').WatcherService | undefined; readonly host: { writeShortTextOn?: import('../agents/host').AgentHost['writeShortTextOn'] } } | undefined
  const teams: TeamService | undefined = owlFeatures.teams && watcherEnabled && startupSettings.localHostEnabled ? new TeamService({
    directory: userDataPath,
    credentials: shellBridge.credentials as import('../agents/credentials').AgentCredentials,
    tailscale: e2eConfiguration === null ? new TailscaleCli() : e2eTailscale(userDataPath),
    threads: leftOut => teamReads?.watcher?.teamThreadFacts(leftOut) ?? { threads: [], beyondCap: 0 },
    projects: () => teamReads?.watcher?.teamProjectFacts() ?? [],
    anchor: () => teamReads?.watcher?.teamAnchor() ?? null,
    keepHistory: () => agentHistoryEnabled,
    write: async prompt => {
      const modelId = teamReads?.watcher?.teamModel()
      if (!modelId) return null
      return await teamReads?.host.writeShortTextOn?.({ modelId }, prompt, AbortSignal.timeout(SIDE_WRITING_TIMEOUT_MS)) ?? null
    },
    openExternal: async url => { if (e2eConfiguration === null) await shellBridge.openExternal(url) },
    hostname: () => osHostname(),
    log,
    ...e2eConfiguration ? { fetch: e2eTeamFetch(userDataPath) } : {},
  }) : undefined

  const fixtureScript = (name: string): string => join(process.cwd(), 'tests', 'fixtures', name)
  const localRuntime: DesktopLocalRuntime = startupSettings.localHostEnabled ? await createAgentRuntime({
    ...teams ? { teams } : {},
    directory: userDataPath,
    credentials: shellBridge.credentials as import('../agents/credentials').AgentCredentials,
    watcherEnabled,
    councilEnabled,
    threadSnoozeEnabled: owlFeatures['thread-snooze'],
    dynamicThreadsEnabled: owlFeatures['dynamic-threads'],
    modelRouterEnabled: owlFeatures['model-router'],
    owletsEnabled: owlFeatures.owlets,
    heldProviders,
    usageEnabled,
    productEvents,
    resumeAfterRestart: owlFeatures['resume-after-restart'],
    restartStoppedThreads: owlFeatures['restart-stopped-threads'],
    streamingPublishCost: owlFeatures['streaming-publish-cost'],
    delegationEnabled,
    parentCoordinationEnabled,
    workerRolesEnabled,
    workerSwarmsEnabled: owlFeatures['worker-swarms'],
    continueEnabled,
    threadStartsEnabled,
    ...(keepMainCurrentEnabled ? { keepMainCurrent: { log } } : {}),
    pullRequestViewEnabled: owlFeatures['iphone-pull-request-view'],
    agentsViewEnabled,
    crossMachineEnabled,
    clockTime: interfaceClockTime,
    attachAnyFile: owlFeatures['attach-any-file'],
    markdownSidePanel: owlFeatures['markdown-side-panel'],
    revealLinkedFiles: owlFeatures['reveal-linked-files'],
    answerImages: owlFeatures['answer-images'],
    nextTurnChoice: owlFeatures['next-turn-choice'],
    inlineMedia: owlFeatures['inline-media'],
    showEveryAgentPicture,
    detachedRuns: e2eConfiguration === null || env['SOTTO_E2E_DETACHED_RUNS'] === '1',
    ...threadMedia ? { threadMedia } : {},
    ...(pictureMaker ? { reducedPictures: new ReducedPictures((url, edge) => pictureMaker.reduce(url, edge), keptThumbnails) } : {}),
    clearThreadsEnabled: owlFeatures['clear-threads'],
    clearLog: (event, detail) => { console.error(`[Sotto] ${event} ${detail}`) },
    ...(ownServers ? { ownServers: () => ownServers.list() } : {}),
    ...(nextPromptEnabled ? { nextPromptEnabled, nextPromptChanged: entry => { shellBridge.sendToMain(NEXT_PROMPT_CHANGED, windowNextPrompt(localRuntime?.agentControl.hostId(), entry)) } } : {}),
    ...(claudeHistoryModulePath ? { claudeHistoryModulePath } : {}),
    settings: () => workingCopySettings,
    writingSettings: () => shellBridge.readWritingSettings(),
    historyEnabled: () => agentHistoryEnabled,
    gitStatus: {
      fetchIntervalMs: () => workingCopySettings.gitFetchIntervalSeconds * 1000,
      foreground: () => windowFocus.showing && (windowFocus.focused || (windowFocus.blurredAt !== 0 && Date.now() - windowFocus.blurredAt < 45_000)),
      visible: () => windowFocus.showing,
      ...(ghStandIn ? { ghStandIn } : {}),
      log,
    },
    babysitting: babysittingRetired ? { retired: true } : { agentTool: () => workingCopySettings.babysitPullRequests },
    ...(e2eConfiguration !== null ? { signInCommand: async () => undefined } : {}),
    openExternal: url => cursorFixtureRoot ? appendFile(join(cursorFixtureRoot, 'opened-pages.txt'), `${url}\n`, 'utf8') : shellBridge.openExternal(url),
    openThreadFolder: async path => {
      if (e2eConfiguration !== null) { shellBridge.onE2EThreadFolder?.(path); return }
      const error = await shellBridge.openPath(path)
      if (error) throw new Error(error)
    },
    ...(authority === undefined ? {} : { authority }),
    logFailure: (code, detail) => { console.error(`[Sotto] ${code} ${detail}`) },
    bindRequestDraftDecision: (target, decisionId, answers) => requestDrafts.bindDecision(target, decisionId, answers),
    ...(e2eConfiguration === null ? { installedProviders: () => detectInstalledProviders({ heldProviders, directory: userDataPath }) } : {}),
    ...(testAgentHost === null ? {} : { host: testAgentHost }),
    ...(devinFixtureRoot ? { providers: {
      codex: new E2EAgentHost(), claude: new E2EAgentHost(), grok: new E2EAgentHost(), opencode: new E2EAgentHost(), cursor: new E2EAgentHost(),
      devin: new DevinAcpHost(userDataPath, {
        executable: devinFixtureExecutable!, args: [fixtureScript('fakeDevinAgent.mjs'), devinFixtureRoot],
        nativeConfigDirectory: join(devinFixtureRoot, 'native-config'), pollIntervalMs: 50,
      }),
    } } : {}),
    ...(museFixtureRoot ? { providers: {
      codex: new E2EAgentHost(), claude: new E2EAgentHost(), grok: new E2EAgentHost(), devin: new E2EAgentHost(), opencode: new E2EAgentHost(), cursor: new E2EAgentHost(),
      ...(!heldProviders.has('muse') ? { muse: new MuseMspHost(userDataPath, {
        executable: museFixtureExecutable!, args: [fixtureScript('fakeMuseAgent.mjs'), museFixtureRoot],
        disableSandbox: (): boolean => localRuntime?.agentControl.configuration().museDisableSandbox === true,
      }) } : {}),
    } } : {}),
    ...(opencodeFixtureRoot ? { providers: {
      codex: new E2EAgentHost(), claude: new E2EAgentHost(), grok: new E2EAgentHost(), devin: new E2EAgentHost(), muse: new E2EAgentHost(), cursor: new E2EAgentHost(),
      ...(!heldProviders.has('opencode') ? { opencode: new OpenCodeHost(userDataPath, {
        executable: opencodeFixtureExecutable!, args: [fixtureScript('fakeOpenCodeServer.mjs'), opencodeFixtureRoot], heldProviders,
        ...(ownServers ? { ownServers: () => ownServers.list() } : {}),
        openExternal: url => appendFile(join(opencodeFixtureRoot, 'opened-pages.txt'), `${url}\n`, 'utf8'),
      }) } : {}),
    } } : {}),
    ...(cursorFixtureRoot ? { providers: {
      codex: new E2EAgentHost(), claude: new E2EAgentHost(), grok: new E2EAgentHost(), devin: new E2EAgentHost(), muse: new E2EAgentHost(), opencode: new E2EAgentHost(),
      ...(!heldProviders.has('cursor') ? { cursor: new CursorAcpHost(userDataPath, {
        program: { executable: cursorFixtureExecutable!, args: [fixtureScript('fakeCursorAgent.mjs'), cursorFixtureRoot] },
        ...fixtureCaptures,
      }) } : {}),
    } } : {}),
    // Antigravity is left out of `providers`, so the runtime's own host starts the fake `agy` in its place.
    ...(antigravityFixtureRoot ? {
      providers: { codex: new E2EAgentHost(), claude: new E2EAgentHost(), grok: new E2EAgentHost(), devin: new E2EAgentHost(), muse: new E2EAgentHost(), opencode: new E2EAgentHost(), cursor: new E2EAgentHost() },
      antigravity: { program: { executable: antigravityFixtureExecutable!, args: [fixtureScript('fakeAntigravityAgent.mjs'), antigravityFixtureRoot] } },
    } : {}),
    ...(nativeFixtureRoot ? { providers: {
      claude: new ClaudeStreamJsonHost({ userDataPath, executable: nativeFixtureExecutable!,
        args: [fixtureScript('fakeClaudeThread.mjs'), join(nativeFixtureRoot, 'claude')], claudeHome: join(nativeFixtureRoot, 'claude', 'home'), limitStops: owlFeatures['restart-stopped-threads'], ...fixtureCaptures }),
      codex: new CodexAppServerHost({ userDataPath, executable: nativeFixtureExecutable!,
        args: [fixtureScript('fakeCodexAppServer.mjs'), join(nativeFixtureRoot, 'codex')], codexHome: join(nativeFixtureRoot, 'codex', 'home'), limitStops: owlFeatures['restart-stopped-threads'], ...fixtureCaptures }),
      grok: new E2EAgentHost(), devin: new E2EAgentHost(), opencode: new E2EAgentHost(), cursor: new E2EAgentHost(),
    } } : {}),
    ...(e2eConfiguration === null ? {} : { reasoner: e2eAgentReasoner }),
    worktreeCleanup: {
      ...(e2eConfiguration === null ? { pullRequestMerged: githubPullRequestMerged, pullRequestState: githubPullRequestState, openPullRequestBranches: githubOpenPullRequestBranches, baseBranchChecks: githubBaseBranchChecks } : {}),
      log,
    },
    claudeSettingsLog: log,
    modelRouterLog: log,
    codexLog: log,
  }) : await inactiveLocalHost(userDataPath)

  const { agentHost, agentControl, threadRegistry, turns, hostService } = localRuntime
  if (e2eConfiguration !== null && !isPackaged && localRuntime.babysitter) installBabysitPassE2E(localRuntime.babysitter)
  agentHost.useBrowserTools(shellBridge.browserTools)
  const worktreeCleanup = startupSettings.localHostEnabled ? localRuntime.worktreeCleanup : null

  const cascadedSettles = crossMachineEnabled ? new CascadedSettles(userDataPath) : undefined
  await cascadedSettles?.load()
  const agentStateBroadcaster = new AgentStateBroadcaster()
  const hostRouter = new DesktopHostRouter(() => emptyDesktopState(agentControl.hostId()), {
    replyBuilt: agentStateBroadcaster.replyBuilt,
    watcherEnabled,
    owletsEnabled: owlFeatures.owlets,
    heldProviders,
    crossMachineWork: crossMachineEnabled,
    streamingPublishCost: owlFeatures['streaming-publish-cost'],
    ...babysittingRetired ? { babysittingRetired: true } : {},
    ...crossMachineEnabled && 'delegation' in localRuntime && localRuntime.delegation ? { stopsLeft: (threadId: string) => localRuntime.delegation?.stopsLeft(threadId) } : {},
    ...cascadedSettles ? { cascadedSettles } : {},
    attachAnyFile: owlFeatures['attach-any-file'],
    ...owlFeatures['inline-media'] ? {
      mediaThumbnail: shellBridge.mediaThumbnail
        ? (url: string, scale: number) => shellBridge.mediaThumbnail!(url, scale)
        : pictureMaker
          ? (url: string, scale: number) => pictureMaker.thumbnail(url, Math.ceil(MEDIA_TILE_SIZE.width * scale), Math.ceil(MEDIA_TILE_SIZE.height * scale))
          : () => null,
      mediaTiles: keptThumbnails,
    } : {},
    bindRequestDraftDecision: (target, decisionId, answers) => requestDrafts.bindDecision(target, decisionId, answers),
    threadsDeleted: threadIds => { void requestDrafts.forgetThreads(new Set(threadIds)).catch(() => undefined) },
  })
  // Detached runs a thread here started on a paired host, as over ssh (#2749): that host reports the runs it found with marks
  // it does not own, this computer's watch claims the ones its own threads' marks name, a turn ending here asks each host to
  // look again, and Stop on one goes to the host that found it.
  const detachedRunWatch = localRuntime.detachedRuns
  if (detachedRunWatch) {
    detachedRunWatch.useElsewhere({ look: () => hostRouter.lookForDetachedRunsElsewhere(), stop: (hostId, runId, mark) => hostRouter.stopDetachedRunElsewhere(hostId, runId, mark) })
    hostRouter.subscribeDetachedRunsElsewhere((hostId, machine, runs) => detachedRunWatch.setElsewhere(hostId, machine, runs))
  }

  localRuntime.watcher?.useRemoteHosts(hostRouter.watcherHosts())
  const threadMoves = 'threadMoves' in localRuntime ? localRuntime.threadMoves : undefined
  if (threadMoves && localRuntime.watcher) threadMoves.useTargets(moveTargetsOf(hostRouter.watcherHosts(), localRuntime.watcher, listener => hostRouter.subscribeChanges(listener)))
  const localWatcher = localRuntime.watcher
  const watcherTells = localWatcher ? new DesktopTellWatcherRelay((target, ask) => localWatcher.threadTold(target, ask), (target, ready) => localWatcher.threadReady(target, ready)) : undefined
  watcherTells?.useHosts(hostRouter)
  const delegationRelay = 'delegationRelay' in localRuntime ? localRuntime.delegationRelay : undefined
  delegationRelay?.useHosts(hostRouter)
  if ('delegationRemote' in localRuntime) localRuntime.delegationRemote?.useHosts(hostRouter)
  if (localRuntime.branchMoves) hostRouter.useBranchMoves(localRuntime.branchMoves)

  const desktopDefaultsPush = crossMachineEnabled ? new DesktopDefaultsPush({ connections: () => hostRouter.remoteConnections(), log }) : undefined
  const desktopDefaultsFollow = desktopDefaultsPush
    ? followDesktopDefaults(
        desktopDefaultsPush,
        hostRouter,
        () => workerRolesEnabled ? workingCopySettings.workerRoles : undefined,
        () => owlFeatures['worker-swarms'] ? { workerCeiling: workingCopySettings.workerCeiling, workerMachineCeilings: workingCopySettings.workerMachineCeilings } : undefined,
        () => owlFeatures['inline-media'] ? workingCopySettings.showEveryAgentPicture : undefined,
      )
    : undefined

  // This computer's histories reach the window with their long bodies cut, as a paired host's do, and a record is read
  // whole when its row opens (#2737).
  const localHistories = windowHistories(agentControl)
  // On Owl builds, start the native Rust `sotto-engine` sidecar in read-only `--accelerator` mode over the
  // ADR-0210 OS IPC transport (ADR-0215) to offload read-only SQLite, Git, Files, and host-facts sampling off
  // the Node event loop. Each offload runs behind TS authority/workspace/settle guards and falls back transparently
  // to TypeScript if the binary is absent, times out, or exits.
  const rustLocalEngine = owlFeatures['rust-local-engine'] && startupSettings.localHostEnabled && e2eConfiguration === null && env['SOTTO_DESIGN_CAPTURE'] !== '1'
    ? await startRustLocalEngine({ userDataPath, isPackaged, log })
    : undefined
  const rustFilesAccelerator = rustLocalEngine ? {
    list: (workspace: Parameters<typeof rustLocalEngine.threadFiles>[0], path: string) => rustLocalEngine.threadFiles(workspace, path),
    preview: (workspace: Parameters<typeof rustLocalEngine.threadFilePreview>[0], path: string) => rustLocalEngine.threadFilePreview(workspace, path),
  } : undefined
  const rustGitChangesAccelerator = rustLocalEngine ? {
    list: (workspace: Parameters<typeof rustLocalEngine.threadChanges>[0]) => rustLocalEngine.threadChanges(workspace),
    review: (workspace: Parameters<typeof rustLocalEngine.threadChangesReview>[0], scope: Parameters<typeof rustLocalEngine.threadChangesReview>[1], ignoreWhitespace: boolean) =>
      rustLocalEngine.threadChangesReview(workspace, scope, ignoreWhitespace),
  } : undefined
  if (rustLocalEngine) {
    agentHost.useThreadWordsAccelerator?.(query => agentHistoryEnabled ? rustLocalEngine.searchThreadWords(query) : Promise.resolve(undefined))
    agentHost.useGitRefsAccelerator?.((folder, options) => rustLocalEngine.gitRefs(folder, options))
    agentHost.useGitChangedFilesAccelerator?.(folder => rustLocalEngine.gitChangedFiles(folder))
    localRuntime.useHostFactsAccelerator?.(live => rustLocalEngine.hostFacts(0, live))
    localRuntime.useToolReadsAccelerator?.({ files: rustFilesAccelerator, gitChanges: rustGitChangesAccelerator })
    localRuntime.useUsageQueryAccelerator?.(query => rustLocalEngine.usageQuery(query))
  }
  if (startupSettings.localHostEnabled) hostRouter.add({
    hostId: agentControl.hostId()!, name: 'This computer', kind: 'local', service: hostService,
    detail: localHistories.detail,
    activityBody: localHistories.activityBody,
    preview: request => agentControl.attachmentPreview(request),
    media: request => agentControl.threadMedia(request),
    mediaPart: async request => { const found = await agentControl.threadMediaVideo(request); return found && { mimeType: found.handle.mimeType, sizeBytes: found.handle.sizeBytes, bytes: found.bytes } },
    stage: image => agentControl.stageAttachment(image),
    stageFile: file => agentControl.stageAttachmentFile(file),
    content: digest => agentControl.attachmentContent(digest),
    gitRefs: request => agentControl.gitRefs(request),
    gitChangedFiles: request => agentControl.gitChangedFiles(request),
    gitPullRequest: request => agentControl.gitPullRequest(request),
    gitPullRequestList: request => agentControl.gitPullRequestList(request),
    offersBabysitting: () => hostService.supportsBabysitting === true,
    hostFolders: request => hostService.hostFolders(request),
    // The main window applies appends; an append to a record it holds cut goes as the record cut again (#2737).
    subscribeDetail: localHistories.subscribeDetail,
    questionPage: token => agentControl.questionPage(token),
    questionPageOpened: token => agentControl.questionPageOpened(token),
  })

  const sshStandInScript = e2eConfiguration !== null && !isPackaged ? env['SOTTO_E2E_SSH_SCRIPT'] : undefined
  const sshStandInExecutable = env['SOTTO_E2E_SSH_EXECUTABLE']
  if (sshStandInScript && (!isAbsolute(sshStandInScript) || !sshStandInExecutable || !isAbsolute(sshStandInExecutable))) throw new Error('The ssh test stand-in requires absolute paths.')
  const sshStandIn = sshStandInScript && sshStandInExecutable ? e2eSshStandIn(sshStandInExecutable, sshStandInScript) : undefined
  const tailnetStandIn = e2eConfiguration !== null && !isPackaged ? e2eTailnetMap(env['SOTTO_E2E_TAILNET_MAP']) : undefined

  const retainedDrafts = new RetainedDraftStore({
    directory: userDataPath,
    watcherEnabled,
    heldProviders,
    historyEnabled: () => agentHistoryEnabled,
    onRecovery: () => shellBridge.publishRecoveryNotice({ code: 'REMOTE_DRAFTS_UNREADABLE' }),
    onWriteFailure: () => shellBridge.publishRecoveryNotice({ code: 'REMOTE_DRAFT_STORAGE_NOT_UPDATED' }),
  })

  const desktopHosts = new DesktopHosts({
    featureUsed: feature => productEvents.featureUsed(feature),
    directory: userDataPath,
    credentials: shellBridge.credentials as import('../agents/credentials').AgentCredentials,
    router: hostRouter,
    retainedDrafts,
    watcherEnabled,
    crossMachineEnabled,
    pairedHostBrowser,
    meshyModels: pluginsEnabled,
    elevenLabsSounds: pluginsEnabled,
    ...owlFeatures['paired-host-terminal'] ? { onHostLeft: (hostId: string) => { void shellBridge.endHostTerminals(hostId).catch(() => log('host-terminals-end-failed')) } } : {},
    ...(nextPromptEnabled ? { nextPromptsWanted: () => workingCopySettings.nextPromptSuggestions } : {}),
    productEventAnswer: () => productEventsPermission(workingCopySettings),
    relaysDelegation: delegationRelay !== undefined,
    parentCoordinationEnabled: owlFeatures['parent-thread-coordination'],
    heldProviders,
    streamingPublishCost: owlFeatures['streaming-publish-cost'],
    clientVersion: hostVersion,
    waitingClientVersion: () => waitingHostVersion,
    localHostRunning: startupSettings.localHostEnabled,
    localHostEnabled: () => workingCopySettings.localHostEnabled,
    restart: () => shellBridge.relaunchApp(),
    useRustHost: owlFeatures['rust-remote-host'],
    ...(sshStandIn ? { launcher: () => new SshHostLauncher({ spawn: sshStandIn }) } : {}),
    ...(tailnetStandIn ? { resolveTailnet: tailnetStandIn } : {}),
    openExternal: async url => { if (e2eConfiguration === null) await shellBridge.openExternal(url); else shellBridge.onE2EExternalLink?.(url) },
  })
  await desktopHosts.start()
  productEvents.record('app.started', { pairedHosts: desktopHosts.get().hosts.length })
  await retainedDrafts.load()

  const agentJobThreads = coordinatorSetupThreads({ coordinator: agentControl, folder: join(userDataPath, 'host-setup'), localHostRunning: startupSettings.localHostEnabled })
  const providerJobs: HostProviderJobs = new HostProviderJobs({
    threads: agentJobThreads,
    hosts: {
      host: id => desktopHosts.jobHost(id),
      provider: (id, provider) => desktopHosts.providerStatus(id, provider),
      refresh: (id, provider) => desktopHosts.refreshProvider(id, provider),
      subscribe: listener => { const off = [hostRouter.subscribeChanges(listener), desktopHosts.subscribe(() => listener())]; return () => { for (const item of off) item() } },
    },
    busy: (): string | undefined => { const setup = hostSetup.state(); return setup && (setup.phase === 'starting' || setup.phase === 'running') ? t`An agent is setting up ${{ host: setup.name }} now. Stop that setup first. Nothing was started.` : undefined },
  })
  const hostSetup: HostSetup = new HostSetup({
    version: hostVersion,
    hosts: {
      check: connection => desktopHosts.check(connection),
      add: connection => desktopHosts.setupAdd(connection),
      forget: id => desktopHosts.forgetSaved(id),
      attempt: id => desktopHosts.attempt(id),
      attemptInEnglish: id => desktopHosts.attemptInEnglish(id),
      cancelAttempt: id => desktopHosts.cancelAttempt(id),
      savedAs: (target, port) => desktopHosts.savedAs(target, port),
    },
    threads: agentJobThreads,
    busy: (): string | undefined => providerJobs.busySentence(),
  })
  const hostSetupTools = new HostSetupToolServer(agentJobTools(hostSetup, providerJobs))
  hostSetup.useTools(threadId => hostSetupTools.revoke(threadId))
  providerJobs.useTools(threadId => hostSetupTools.revoke(threadId))

  const visualTools = new VisualToolServer({
    enabled: () => workingCopySettings.visualsInThreads,
    admits: threadId => agentHost.admitsVisuals(threadId),
    add: (threadId, input) => agentHost.addVisual(threadId, input),
  })
  const mediaTools = owlFeatures['inline-media'] ? new MediaToolServer({
    admits: threadId => agentHost.admitsShownMedia(threadId),
    show: (threadId, input) => agentHost.showMedia(threadId, input),
  }) : undefined

  const pluginsGh: RunGitCommand = ghStandIn ? runWithGhStandIn(ghStandIn) : e2eConfiguration ? async () => { throw new GitUnavailableError('gh is not installed') } : runGitStatusCommand
  const pluginsStop = new AbortController()
  const pluginsGitHubSignIn = sharedGitHubSignIn(() => { resetGhLookup(); return readGitHubSignIn(pluginsGh, pluginsStop.signal) })
  const pluginUse = pluginsEnabled ? new PluginUseRecord(userDataPath, { historyEnabled: () => agentHistoryEnabled }) : undefined
  const meshyBase = e2eConfiguration !== null && !isPackaged ? env['SOTTO_E2E_MESHY_API_URL'] : undefined
  const meshyFetch: MeshyFetch = e2eConfiguration !== null && !meshyBase ? async () => { throw new Error('E2E_NETWORK_DISABLED') } : (url, init) => fetch(url, init)
  const meshyOptions = { ...(meshyBase ? { base: meshyBase } : {}), signal: pluginsStop.signal }
  const elevenLabsBase = e2eConfiguration !== null && !isPackaged ? env['SOTTO_E2E_ELEVENLABS_API_URL'] : undefined
  const elevenLabsFetch: ElevenLabsFetch = e2eConfiguration !== null && !elevenLabsBase ? async () => { throw new Error('E2E_NETWORK_DISABLED') } : (url, init) => fetch(url, init)
  const elevenLabsOptions = { ...(elevenLabsBase ? { base: elevenLabsBase } : {}), signal: pluginsStop.signal }
  const vercelBase = e2eConfiguration !== null && !isPackaged ? env['SOTTO_E2E_VERCEL_API_URL'] : undefined
  const vercelFetch: VercelFetch = e2eConfiguration !== null && !vercelBase ? async () => { throw new Error('E2E_NETWORK_DISABLED') } : (url, init) => fetch(url, init)
  const vercelOptions = { ...(vercelBase ? { base: vercelBase } : {}), signal: pluginsStop.signal }
  const standInPort = (name: string): number | undefined => {
    const port = e2eConfiguration !== null && !isPackaged ? Number(env[name]) : Number.NaN
    return Number.isInteger(port) && port > 0 ? port : undefined
  }
  const mailStandIn = standInPort('SOTTO_E2E_MAIL_PORT')
  const mailOptions: MailOptions = {
    signal: pluginsStop.signal,
    ...(e2eConfiguration === null ? {} : { connect: mailStandIn !== undefined ? mailOnThisComputer(mailStandIn, standInPort('SOTTO_E2E_SMTP_PORT')) : async () => { throw new Error('E2E_NETWORK_DISABLED') } }),
  }
  const pluginAccounts = pluginsEnabled ? new PluginAccounts(userDataPath, {
    credentials: shellBridge.credentials as import('../agents/credentials').AgentCredentials,
    check: (plugin, secret, address, bridge) => isMailPlugin(plugin) ? checkMailAccount(plugin, address ?? '', secret, mailOptions, bridge)
      : plugin === 'meshy' ? checkMeshyKey(meshyFetch, secret, meshyOptions)
      : plugin === 'elevenlabs' ? checkElevenLabsKey(elevenLabsFetch, secret, elevenLabsOptions)
      : checkVercelToken(vercelFetch, secret, vercelOptions),
  }) : undefined

  const meshyApiFetch: MeshyApiFetch = e2eConfiguration === null ? (url, init) => fetch(url, init)
    : async (url, init) => { if (!meshyBase || !url.startsWith(`${meshyBase}/`)) throw new Error('E2E_NETWORK_DISABLED'); return fetch(url, init) }
  const modelRecords = pluginsEnabled ? new ModelRecords(userDataPath, { historyEnabled: () => agentHistoryEnabled }) : undefined
  const meshySpending = modelRecords && pluginAccounts ? new PluginSpendingSync(userDataPath, {
    plugin: 'meshy',
    own: () => modelRecords.monthCredits(),
    accounts: () => pluginAccounts.list(),
    connections: () => hostRouter.remoteConnections(),
    changed: () => { shellBridge.sendToMain(PLUGINS_MESHY_CREDITS_CHANGED, null) },
  }) : undefined
  let modelViewsSent: Promise<void> = Promise.resolve()
  let phoneModelViews: HostModelViewsWithNews | undefined = undefined
  const meshyModels = modelRecords && pluginAccounts ? new MeshyModels({
    records: modelRecords,
    fetch: meshyApiFetch,
    signal: pluginsStop.signal,
    ...(meshyBase ? { base: meshyBase, assets: meshyBase } : {}),
    keyOf: async accountId => (await pluginAccounts.list()).some(account => account.id === accountId && account.plugin === 'meshy') ? pluginAccounts.secret(accountId) || undefined : undefined,
    changed: (model, progress) => {
      meshySpending?.ownChanged()
      const shape = meshyModels?.hasShape(model.id) ?? false
      modelViewsSent = modelViewsSent.then(async () => await modelRecords.model(model.id) ? await modelView(model, progress, shape) : null)
        .then(view => { if (view) shellBridge.sendToMain(PLUGINS_MODEL_3D_CHANGED, view) }, () => undefined)
      phoneModelViews?.changed(model, progress)
    },
  }) : undefined
  void meshyModels?.resume().catch(() => undefined)
  const modelViews: ModelListSource | undefined = meshyModels && modelRecords ? {
    model: id => modelRecords.model(id),
    progressOf: (id, stage) => meshyModels.progressOf(id, stage),
    hasShape: id => meshyModels.hasShape(id),
    shapeBytes: id => meshyModels.shapeBytes(id),
    list: () => modelRecords.list(),
    accountNames: async () => new Map((await pluginAccounts?.list() ?? []).filter(account => account.plugin === 'meshy').map(account => [account.id, account.name])),
    remove: (id, may) => modelRecords.remove(id, may),
  } : undefined
  phoneModelViews = modelViews ? hostModelViews(modelViews) : undefined
  const hostModels = pluginsEnabled ? new HostModels3d({
    connections: () => hostRouter.remoteConnections(),
    subscribeConnected: listener => hostRouter.subscribeConnected(listener),
    subscribeRemoved: listener => hostRouter.subscribeRemoved(listener),
    localHostId: () => agentControl.hostId(),
    changed: view => { shellBridge.sendToMain(PLUGINS_MODEL_3D_CHANGED, view) },
    removed: keys => { shellBridge.sendToMain(PLUGINS_MODELS_3D_REMOVED, keys) },
  }) : undefined
  pluginsStop.signal.addEventListener('abort', () => { hostModels?.close() }, { once: true })

  // Meshy photo redraw delegates to the shell's nativeImage when available (supporting interlaced PNGs identically
  // to in-process mode), falling back to the pure-Node picture worker when running without a shell image bridge.
  const redrawPhoto: RedrawPhoto = async (bytes, kind) => shellBridge.redrawPhoto
    ? shellBridge.redrawPhoto(bytes, kind)
    : pictureMaker ? pictureMaker.redraw(bytes, kind) : null

  const elevenLabsApiFetch: ElevenLabsApiFetch = e2eConfiguration === null ? (url, init) => fetch(url, init)
    : async (url, init) => { if (!elevenLabsBase || !url.startsWith(`${elevenLabsBase}/`)) throw new Error('E2E_NETWORK_DISABLED'); return fetch(url, init) }
  const soundRecords = pluginsEnabled ? new SoundRecords(userDataPath, { historyEnabled: () => agentHistoryEnabled }) : undefined
  void soundRecords?.settleUnfinished().catch(() => undefined)
  const elevenLabsSpending = soundRecords && pluginAccounts ? new PluginSpendingSync(userDataPath, {
    plugin: 'elevenlabs',
    own: async () => centsByAccount(await soundRecords.monthSpent()),
    accounts: () => pluginAccounts.list(),
    connections: () => hostRouter.remoteConnections(),
    changed: () => { shellBridge.sendToMain(PLUGINS_ELEVENLABS_SPENT_CHANGED, null) },
  }) : undefined

  const files = new FilesService({
    resolveBinding: threadId => agentControl.filesBinding(threadId),
    copyPath: path => shellBridge.clipboardWrite(path),
    reveal: path => { if (e2eConfiguration !== null) shellBridge.onE2EFileAction?.('show', path); else shellBridge.revealInFolder(path) },
    open: async path => {
      if (e2eConfiguration !== null) { shellBridge.onE2EFileAction?.('open', path); return }
      const error = await shellBridge.openPath(path)
      if (error) throw new Error('No app opened this file.')
    },
    accelerator: rustFilesAccelerator,
  })
  const fileDownloads = new FileDownloads({
    part: request => hostRouter.threadLinkedFile(request),
    folder: () => shellBridge.downloadsFolder(),
    progress: progress => { shellBridge.sendToMain(FILES_DOWNLOAD_PROGRESS, progress) },
  })

  const soundViews: SoundViewSource | undefined = soundRecords ? {
    sound: id => soundRecords.sound(id),
    folderOf: async threadId => { const found = await files.resolveWorkspace(threadId); return found.ok ? found.value.workingDirectory : found.error.code === 'busy' ? 'busy' : null },
  } : undefined
  const pushSoundView = soundViews ? soundViewPush(soundViews, view => { shellBridge.sendToMain(PLUGINS_SOUND_CHANGED, view) }) : undefined
  const hostSounds = pluginsEnabled ? new HostSounds({
    connections: () => hostRouter.remoteConnections(),
    subscribeConnected: listener => hostRouter.subscribeConnected(listener),
    subscribeRemoved: listener => hostRouter.subscribeRemoved(listener),
    localHostId: () => agentControl.hostId(),
    changed: view => { shellBridge.sendToMain(PLUGINS_SOUND_CHANGED, view) },
  }) : undefined
  pluginsStop.signal.addEventListener('abort', () => { hostSounds?.close() }, { once: true })
  const elevenLabsSounds = soundRecords && pluginAccounts ? new ElevenLabsSounds({
    records: soundRecords,
    fetch: elevenLabsApiFetch,
    signal: pluginsStop.signal,
    ...(elevenLabsBase ? { base: elevenLabsBase } : {}),
    keyOf: async accountId => (await pluginAccounts.list()).some(account => account.id === accountId && account.plugin === 'elevenlabs') ? pluginAccounts.secret(accountId) || undefined : undefined,
    changed: sound => {
      shellBridge.sendToMain(PLUGINS_ELEVENLABS_SPENT_CHANGED, null)
      elevenLabsSpending?.ownChanged()
      void pushSoundView?.(sound)
    },
  }) : undefined
  const elevenLabsTools = elevenLabsSounds && soundRecords ? {
    folderOf: async (threadId: string) => { const found = await files.resolveWorkspace(threadId); return found.ok ? found.value.workingDirectory : null },
    monthSpent: async (accountId: string): Promise<number | 'unreadable'> => {
      const here = (await soundRecords.monthSpent()).get(accountId) ?? 0
      const others = elevenLabsSpending ? await elevenLabsSpending.others(accountId).catch(() => 'unreadable' as const) : 0
      return typeof others === 'string' ? others : here + others / 100
    },
    voices: (accountId: string) => elevenLabsSounds.voices(accountId),
    make: (request: SoundRequest) => elevenLabsSounds.make(request),
    showInThread: async (threadId: string, sound: { readonly id: string; readonly name: string }) =>
      (await agentHost.addVisual(threadId, { kind: SOUND_VISUAL_KIND, title: sound.name, source: sound.id }).catch(() => ({ added: false as const }))).added,
  } : undefined
  const meshyTools = meshyModels && modelRecords ? {
    folderOf: async (threadId: string) => { const found = await files.resolveWorkspace(threadId); return found.ok ? found.value.workingDirectory : null },
    monthCredits: async (accountId: string) => meshySpending ? await meshySpending.monthTotal(accountId).catch(() => 'unreadable' as const) : (await modelRecords.monthCredits()).get(accountId) ?? 0,
    checkPhoto,
    photoToSend: (root: string, checked: Parameters<typeof photoToSend>[1], path: string) => photoToSend(root, checked, path, redrawPhoto),
    make: (request: Parameters<MeshyModels['make']>[0]) => meshyModels.make(request),
    showInThread: async (threadId: string, model: { readonly id: string; readonly name: string }) =>
      (await agentHost.addVisual(threadId, { kind: MODEL_VISUAL_KIND, title: model.name, source: model.id }).catch(() => ({ added: false as const }))).added,
  } : undefined

  const pluginCopySync = pluginsEnabled && pluginAccounts ? new PluginAccountCopySync(userDataPath, {
    accounts: pluginAccounts,
    computers: () => desktopHosts.get().hosts.map(host => ({ id: host.id, name: host.name, hostId: host.hostId, connected: host.phase === 'connected' })),
    connections: () => hostRouter.remoteConnections(),
    changed: () => { shellBridge.sendToMain(PLUGINS_COPIES_CHANGED, null) },
    log: event => { log(event); if (event === 'plugin-account-copies-reconciled') { meshySpending?.tellAll(); elevenLabsSpending?.tellAll() } },
  }) : undefined
  const stopFollowingConnections = pluginCopySync ? hostRouter.subscribeConnected(connection => { pluginCopySync.connected(connection); meshySpending?.connected(connection); elevenLabsSpending?.connected(connection) }) : undefined
  const stopFollowingHosts = pluginCopySync ? desktopHosts.subscribe(() => { pluginCopySync.computersChanged() }) : undefined
  const stopFollowingCopies = (): void => { stopFollowingConnections?.(); stopFollowingHosts?.() }

  const pluginThreadOpen = (threadId: string): boolean => {
    const thread = agentControl.watcherSnapshot().threads.find(item => item.id === threadId)
    return thread !== undefined && !isThreadClosed(thread)
  }
  const mailGrants = pluginsEnabled ? new MailGrants(userDataPath, {
    open: threadId => mailThreadOpen(agentControl.watcherSnapshot(), threadId),
    changed: () => { shellBridge.sendToMain(PLUGINS_MAIL_GRANTS_CHANGED, null) },
  }) : undefined
  const pluginChanges = pluginsEnabled ? new PluginChangeRequests({ open: pluginThreadOpen, noticed: () => { mailGrants?.noticed() } }) : undefined
  const pluginProjectOf = (threadId: string): string | null => pluginFolderOfThread(agentControl.watcherSnapshot(), threadId)
  const pluginTools = pluginUse && pluginAccounts ? new PluginToolServer(pluginToolHandlers({
    admits: threadId => agentHost.admitsPluginTools(threadId),
    accounts: pluginAccounts,
    projectOf: pluginProjectOf,
    gitHubSignIn: pluginsGitHubSignIn,
    gh: pluginsGh,
    vercelFetch,
    vercelOptions,
    record: use => pluginUse.add(use),
    isWatcher: threadId => {
      const thread = agentControl.watcherSnapshot().threads.find(item => item.id === threadId)
      return thread === undefined || thread.kind === 'watcher' || thread.kind === 'watcher-history'
    },
    askChange: async (threadId, change, wait) => await pluginChanges?.ask(threadId, wordPluginChange(change), wait) ?? 'stopped',
    ...(meshyTools ? { meshy: meshyTools } : {}),
    ...(elevenLabsTools ? { elevenlabs: elevenLabsTools } : {}),
    ...(mailGrants ? { mail: {
      grants: mailGrants,
      options: mailOptions,
      keepsBridgeAccounts: true,
      folderOf: async (threadId: string) => { const found = await files.resolveWorkspace(threadId); return found.ok ? found.value.workingDirectory : null },
      providerOf: (threadId: string) => {
        const thread = agentControl.watcherSnapshot().threads.find(item => item.id === threadId)
        return thread?.providerId ? PROVIDER_LABELS[thread.providerId] : ''
      },
    } } : {}),
  })) : undefined

  const pullRequestTools = babysittingRetired ? undefined : new PullRequestToolServer({
    enabled: () => workingCopySettings.babysitPullRequests,
    host: agentHost,
    babysitter: 'babysitter' in localRuntime ? localRuntime.babysitter : undefined,
    watcherEnabled,
  })
  const delegationService = 'delegation' in localRuntime ? localRuntime.delegation : undefined
  const threadCoordinationService = 'threadCoordination' in localRuntime ? localRuntime.threadCoordination : undefined
  const coordinationRelay = threadCoordinationService
    ? new DesktopCoordinationRelay({
      service: threadCoordinationService,
      localHostId: () => agentControl.hostId(),
      localMachineName: () => (e2eConfiguration === null ? osHostname().trim().slice(0, 64) : E2E_COMPUTER_NAME) || 'Desktop',
    })
    : undefined
  coordinationRelay?.useHosts(hostRouter)
  const councilService = councilEnabled && startupSettings.localHostEnabled ? new CouncilService({
    directory: userDataPath,
    control: agentControl,
    host: agentHost,
    historyEnabled: () => agentHistoryEnabled,
    stageDeadline: () => workingCopySettings.councilStageDeadline,
    panel: () => ({ panelists: workingCopySettings.councilPanelists, chair: workingCopySettings.councilChair }),
    bundles: ('branchBundles' in localRuntime ? localRuntime.branchBundles : undefined)
      ?? new BranchBundles({ stagingDirectory: join(userDataPath, 'council-staging'), recordsPath: join(userDataPath, 'council-staging', 'records.json') }),
  }) : undefined
  if (councilService) await councilService.recover()
  const continueService = 'continuation' in localRuntime ? localRuntime.continuation : undefined
  const delegationTools = delegationService ? new DelegationToolServer(delegationService, { dynamic: owlFeatures['dynamic-threads'], roles: workerRolesEnabled, machines: crossMachineEnabled && watcherEnabled, swarms: owlFeatures['worker-swarms'] }) : undefined
  const coordinationTools = threadCoordinationService ? new CoordinationToolServer(threadCoordinationService) : undefined
  const tellTools = localWatcher ? tellWatcherTools(agentHost, localWatcher, async (threadId, words, userMessage) => {
    const hostId = agentControl.hostId()
    return hostId ? await localWatcher.threadTold({ hostId, threadId }, { words, ...userMessage ? { userMessage } : {} }) : { status: 'refused', reason: 'no-watcher' }
  }, async (threadId, ready) => {
    const hostId = agentControl.hostId()
    return hostId ? await localWatcher.threadReady({ hostId, threadId }, ready) : { status: 'refused', reason: 'no-watcher' }
  }) : undefined
  const councilTools = councilService ? new CouncilToolServer({
    admits: threadId => {
      if (!agentHost.admitsTellWatcher(threadId)) return false
      const thread = agentControl.watcherSnapshot().threads.find(item => item.id === threadId)
      return thread !== undefined && thread.delegatedBy === undefined && thread.councilJudge !== true && thread.remoteHost !== true
        && (thread.hostId === undefined || thread.hostId === agentControl.hostId())
    },
    userMessage: async threadId => {
      const thread = agentControl.watcherSnapshot().threads.find(item => item.id === threadId)
      return thread ? councilUserMessage(thread, { message: messageId => agentHost.threadMessage(threadId, messageId), newest: () => agentHost.threadMessages(threadId) },
        messageId => agentControl.delegationMessage(messageId) || localWatcher?.sentToThread(threadId, messageId) === true) : undefined
    },
    ask: (threadId, input, user) => councilService.askFromThread(threadId, input.question, user),
    climb: (threadId, input, user) => councilService.climbFromThread(threadId, input, user),
    read: (threadId, council) => councilService.readForThread(threadId, council),
  }) : undefined

  agentHost.useThreadTools([
    hostSetupTools,
    visualTools,
    ...(mediaTools ? [mediaTools] : []),
    ...(pluginTools ? [pluginTools] : []),
    ...(pullRequestTools ? [pullRequestTools] : []),
    ...(delegationTools ? [delegationTools] : []),
    ...(coordinationTools ? [coordinationTools] : []),
    ...(tellTools ? [tellTools] : []),
    ...(councilTools ? [councilTools] : []),
  ])
  agentControl.useSottoRequests(pluginChanges ? combinedSottoRequests([hostSetupRequests(hostSetup), pluginChanges]) : hostSetupRequests(hostSetup))
  desktopHosts.useSetup(hostSetup)
  desktopHosts.useProviderJob(providerJobs)

  const busyThreads = routerBusyThreads(hostRouter)
  const releasesStandIn = e2eConfiguration !== null && !isPackaged ? env['SOTTO_E2E_HOST_RELEASES_URL'] : undefined
  const hostUpdates = new HostUpdates({
    version: hostVersion,
    ...(releasesStandIn ? { releasesUrl: releasesStandIn } : {}),
    requiresManagementUpdate: hostId => hostRouter.requiresManagementUpdate(hostId),
    hosts: {
      candidates: () => desktopHosts.updateCandidates(),
      run: (id, operation, runOptions) => desktopHosts.runUpdate(id, operation, runOptions),
      restart: (id, version, restartOptions) => desktopHosts.restartForUpdate(id, version, restartOptions),
      subscribe: listener => desktopHosts.subscribe(() => listener()),
    },
    threads: busyThreads,
    clients: { updating: hostId => hostRouter.clientLineRunning(hostId) },
  })
  desktopHosts.useUpdates(hostUpdates)

  const hostBoot = new HostBootChanges({
    threads: busyThreads,
    hosts: {
      candidate: id => desktopHosts.bootCandidate(id),
      keeps: id => desktopHosts.bootKeeps(id),
      setBootStart: (id, action) => desktopHosts.setBootStart(id, action),
      subscribe: listener => desktopHosts.subscribe(() => listener()),
    },
  })
  desktopHosts.useBoot(hostBoot)

  const hostPhones = new HostPhones({
    hosts: { links: () => desktopHosts.phonesLinks(), subscribe: listener => desktopHosts.subscribe(() => listener()) },
    openExternal: async url => { if (e2eConfiguration === null) await shellBridge.openExternal(url) },
    log,
  })
  desktopHosts.usePhones(hostPhones)

  const remoteHostE2E = e2eConfiguration !== null && !isPackaged ? installRemoteHostE2E(hostRouter, retainedDrafts, watcherEnabled, heldProviders, crossMachineEnabled, pairedHostBrowser) : undefined

  const phoneAccess = new PhoneAccess({
    featureUsed: feature => productEvents.featureUsed(feature),
    directory: userDataPath,
    listener: { sottoVersion: hostVersion, delegation: delegationEnabled, phoneSends: phoneSendsFor(userDataPath), ...(phoneCompression ? {} : { compressPhones: false }), ...(phoneModelViews ? { phoneModels: phoneModelViews } : {}) },
    service: startupSettings.localHostEnabled ? hostService : undefined,
    tailscale: e2eConfiguration === null ? new TailscaleCli() : e2eTailscale(userDataPath),
    ...(e2eConfiguration === null ? {} : { hostname: () => E2E_COMPUTER_NAME }),
    settings: () => workingCopySettings,
    policy: authority,
    openExternal: async url => { if (e2eConfiguration === null) await shellBridge.openExternal(url) },
    log,
  })
  void phoneAccess.start().catch(() => log('phone-access-start-failed'))

  const localApps = localAppsEnabled ? new LocalApps({
    directory: userDataPath,
    listener: { sottoVersion: hostVersion, delegation: delegationEnabled },
    service: startupSettings.localHostEnabled ? hostService : undefined,
    settings: () => workingCopySettings,
    policy: authority,
    log,
  }) : undefined
  if (localApps) void localApps.start().catch(() => log('local-apps-failed'))
  if (teams) { teamReads = { watcher: localRuntime.watcher, host: localRuntime.agentHost }; void teams.start().catch(() => log('teams-start-failed')) }

  const requestDrafts: RequestDraftService = new RequestDraftService(
    userDataPath,
    owner => requestDraftOwnerState(owner, agentControl, hostRouter),
    async (target, decisionId) => {
      if (target.kind !== 'thread') throw new Error(t`Standalone chats are no longer available.`)
      const key = parseHostEntityKey(target.ownerId)
      if (key && key.hostId !== agentControl.hostId()) await hostRouter.refreshRequestDraft(target, decisionId)
      else await agentControl.refreshRequestDraft(key?.id ?? target.ownerId, target.requestId)
    },
    undefined,
    watcherEnabled && !heldProviders.size ? undefined : owner => {
      if (owner.kind !== 'thread') return false
      const key = parseHostEntityKey(owner.ownerId)
      if (key && key.hostId !== agentControl.hostId()) return hostRouter.preservesDormantThread(owner.ownerId)
      return localRuntime?.agentHost.dormantThreadIds?.().includes(key?.id ?? owner.ownerId) ?? false
    },
    () => requestDraftWatcherOwnerIds(agentControl, () => localRuntime?.agentHost.dormantThreadIds?.(), hostRouter),
  )
  await requestDrafts.start()

  localRuntime?.agentControl.onThreadsDeleted(threadIds => {
    const hostId = agentControl.hostId()
    void pluginUse?.forgetThreads(threadIds).catch(() => undefined)
    void modelRecords?.forgetThreads(threadIds).then(ids => { if (ids.length > 0) { shellBridge.sendToMain(PLUGINS_MODELS_3D_REMOVED, ids); phoneModelViews?.removed(ids) } }, () => undefined)
    void soundRecords?.forgetThreads(threadIds).catch(() => undefined)
    pluginChanges?.forgetThreads(threadIds)
    void mailGrants?.forgetThreads(threadIds).catch(() => undefined)
    void requestDrafts.forgetThreads(new Set(threadIds.flatMap(id => [id, hostEntityKey(hostId, id)]))).catch(() => undefined)
    void cascadedSettles?.forgetAll(threadIds.map(id => hostEntityKey(hostId, id))).catch(() => undefined)
  })
  const unsubscribeRequestDrafts = requestDrafts.onChanged(owner => shellBridge.sendToMain(REQUEST_DRAFT_CHANGED, owner))

  const cleanRetiredHistory = async (): Promise<void> => {
    teams?.privacyChanged()
    delegationService?.privacyChanged()
    const [chats, answers, remoteDrafts, pluginUses, modelWords, soundWords] = await Promise.allSettled([
      Promise.resolve().then(() => retiredChatHistory.privacyChanged()),
      Promise.resolve().then(() => requestDrafts.privacyChanged(agentHistoryEnabled)),
      Promise.resolve().then(() => retainedDrafts.privacyChanged()),
      Promise.resolve().then(() => agentHistoryEnabled ? undefined : pluginUse?.clear()),
      Promise.resolve().then(() => modelRecords?.privacyChanged()),
      Promise.resolve().then(() => soundRecords?.privacyChanged()),
    ])
    if (chats.status === 'rejected') shellBridge.publishRecoveryNotice({ code: 'RETIRED_CHAT_HISTORY_NOT_CLEARED' })
    if (answers.status === 'rejected') shellBridge.publishRecoveryNotice({ code: 'ANSWER_HISTORY_NOT_CLEARED' })
    if (remoteDrafts.status === 'rejected') shellBridge.publishRecoveryNotice({ code: 'REMOTE_DRAFT_STORAGE_NOT_UPDATED' })
    if (pluginUses.status === 'rejected') shellBridge.publishRecoveryNotice({ code: 'PLUGIN_USE_NOT_CLEARED' })
    if (modelWords.status === 'rejected') shellBridge.publishRecoveryNotice({ code: 'MODEL_WORDS_NOT_CLEARED' })
    if (soundWords.status === 'rejected') shellBridge.publishRecoveryNotice({ code: 'SOUND_WORDS_NOT_CLEARED' })
    if (chats.status === 'rejected') throw chats.reason
    if (answers.status === 'rejected') throw answers.reason
    if (remoteDrafts.status === 'rejected') throw remoteDrafts.reason
    if (pluginUses.status === 'rejected') throw pluginUses.reason
    if (modelWords.status === 'rejected') throw modelWords.reason
    if (soundWords.status === 'rejected') throw soundWords.reason
  }
  await cleanRetiredHistory().catch(() => undefined)
  await hostRouter.reconcileRequestDrafts(requestDrafts).catch(() => undefined)

  // Cached FilesBinding mirror synchronization (ADR-0210): keeps shell-owned BrowserService, CloudIphoneService
  // and TerminalService resolving thread folders locally with zero blocking round-trips.
  const filesBindingsTracker = new FilesBindingsTracker()
  const pushLocalBindings = (): void => {
    const delta = filesBindingsTracker.syncLocal(agentControl.watcherSnapshot())
    if (delta) shellBridge.onFilesBindingsDelta(delta)
  }
  const pushHostedBindings = (): void => {
    const localId = agentControl.hostId()
    const remoteThreadIds: string[] = []
    for (const thread of hostRouter.view().host.threads) {
      const parsed = parseHostEntityKey(thread.id)
      if (parsed && parsed.hostId !== localId) remoteThreadIds.push(thread.id)
    }
    const terminalHostPairs: (readonly [string, import('../hosts/sshTerminal').SshTerminalHost])[] = []
    for (const host of desktopHosts.get().hosts) {
      if (!host.hostId) continue
      const terminalHost = desktopHosts.terminalHost(host.hostId)
      if (terminalHost) terminalHostPairs.push([host.hostId, terminalHost])
    }
    const delta = filesBindingsTracker.syncHosted(remoteThreadIds, id => hostRouter.hostedThreadFolders(id), terminalHostPairs)
    if (delta) shellBridge.onFilesBindingsDelta(delta)
  }
  pushLocalBindings()
  pushHostedBindings()
  let lastRestartHold = hostUpdates.restartHold()
  shellBridge.onRestartHoldChanged?.(lastRestartHold)
  const syncRestartHold = (): void => {
    const next = hostUpdates.restartHold()
    if (next !== lastRestartHold) {
      lastRestartHold = next
      shellBridge.onRestartHoldChanged?.(next)
    }
  }
  const unsubscribeBindingsRouter = hostRouter.subscribeChanges(() => { pushLocalBindings(); pushHostedBindings(); syncRestartHold() })
  const unsubscribeBindingsHosts = desktopHosts.subscribe(() => { pushHostedBindings(); syncRestartHold() })

  // Popup feed lives in the engine so full AgentState snapshots never cross the boundary when the popup is hidden.
  const popupDetailPublisher = owlFeatures.popup ? coalesceAgentThreadDetailPublishes(update => shellBridge.sendToPopup(AGENT_THREAD_DETAIL, update)) : undefined
  const popupFeed = owlFeatures.popup && popupDetailPublisher ? new PopupFeed(
    thread => shellBridge.sendToPopup(POPUP_THREAD, thread),
    update => popupDetailPublisher.publish(isAgentThreadDetailDelta(update)
      ? { threadId: update.threadId, baseRevision: update.baseRevision, revision: update.revision, messageDeltas: update.messageDeltas, activityDeltas: [] }
      : { threadId: update.threadId, revision: update.revision, messages: update.messages }),
  ) : undefined

  const agentStatePublisher = coalesceAgentStatePublishes(state => {
    pushLocalBindings()
    hostRouter.scheduleRequestDraftReconcile(requestDrafts)
    agentStateBroadcaster.send(state, payload => shellBridge.sendToMain(AGENT_STATE, payload))
    popupFeed?.published(state)
  })
  const agentDetailPublisher = coalesceAgentThreadDetailPublishes(detail => shellBridge.sendToMain(AGENT_THREAD_DETAIL, detail),
    { beforeOpening: () => agentStatePublisher.flush() })
  const unsubscribeAgents = hostRouter.subscribe(state => agentStatePublisher.publish(state))
  const unsubscribeAgentDetail = hostRouter.subscribeThreadDetail(detail => { agentDetailPublisher.publish(detail); popupFeed?.detail(detail) })

  const threadAlerts = desktopNotificationsEnabled && shellBridge.notify ? new ThreadAlerts({
    shows: threadId => hostRouter.windowShows(threadId),
    ...(localRuntime.watcher ? { watched: (threadId: string) => {
      const key = parseHostEntityKey(threadId)
      return key !== null && localRuntime.watcher?.watches({ hostId: key.hostId, threadId: key.id }) === true
    } } : {}),
    ...babysittingRetired ? { babysittingRetired: true } : {},
    emit: alert => { shellBridge.notify?.(alert) },
  }) : null
  const stopAlerts = threadAlerts ? hostRouter.subscribe(state => threadAlerts.track(state)) : undefined

  const checkpointIntegration = connectCheckpoints({
    historyEnabled: () => agentHistoryEnabled,
    files,
    directory: userDataPath,
    host: agentHost,
    control: agentControl,
    registry: threadRegistry,
    report: () => { log('checkpoint-unavailable') },
    ...(rustLocalEngine ? { inspectAccelerator: (blobsDir, pairs) => rustLocalEngine.checkpointInspectBlobs(blobsDir, pairs) } : {}),
  })
  agentHost.setMutationGuard(checkpointIntegration.canMutate)

  const gitChanges = new GitChangesService({
    files,
    checkpoints: checkpointIntegration.checkpoints,
    canMutate: checkpointIntegration.canMutate,
    acted: threadId => { void agentHost.gitActionFinished(threadId).catch(() => undefined) },
    copyPath: path => shellBridge.clipboardWrite(path),
    reveal: path => shellBridge.revealInFolder(path),
    emit: event => { shellBridge.sendToMain(GIT_CHANGES_EVENT, event) },
    accelerator: rustGitChangesAccelerator,
  })

  if (worktreeCleanup) {
    agentHost.setWorktreeInUse(threadId => runningTerminalThreads.has(threadId))
    worktreeCleanup.start()
  }

  const stopHostBrowser = pairedHostBrowser ? [
    hostRouter.subscribeBrowser(event => { shellBridge.sendToMain(BROWSER_EVENT, event) }),
    hostRouter.subscribeBrowserFrames(frame => { shellBridge.sendToMain(BROWSER_FRAME_EVENT, frame) }),
    hostRouter.subscribeConnected(connection => { void hostRouter.tellBrowserSetting(connection, workingCopySettings.browserWithoutAsking).catch(() => log('host-browser-setting-failed')) }),
  ] : []
  if (pairedHostBrowser) for (const connection of hostRouter.remoteConnections()) void hostRouter.tellBrowserSetting(connection, workingCopySettings.browserWithoutAsking).catch(() => log('host-browser-setting-failed'))

  // Register every engine-owned IPC channel on the Electron-free registry.
  const ipc = new EngineIpcRegistry()
  const senders = () => ipc.senders()
  const copyHostPath = async <T extends { ok: true; value: { absolutePath: string } } | { ok: false }>(result: T): Promise<T> => {
    if (result.ok) await shellBridge.clipboardWrite(result.value.absolutePath)
    return result
  }

  const cleanupRequestDrafts = registerRequestDraftIpc(ipc, requestDrafts, senders)
  const cleanupFiles = registerFilesIpc(ipc, files, senders, {
    list: request => hostRouter.threadFiles(request),
    preview: request => hostRouter.threadFilePreview(request),
    previewLink: request => hostRouter.threadFileLink(request),
    linkedFile: request => hostRouter.threadLinkedFile(request),
    copyPath: async request => copyHostPath(await hostRouter.threadFilePath(request)),
  }, owlFeatures['reveal-linked-files'], owlFeatures['markdown-side-panel'], {
    downloads: fileDownloads,
    reveal: path => { if (e2eConfiguration !== null) shellBridge.onE2EFileAction?.('show', path); else shellBridge.revealInFolder(path) },
  })
  const cleanupSubagents = registerSubagentIpc(ipc, agentHost, senders, change => shellBridge.sendToMain(SUBAGENTS_CHANGED, change), hostRouter)
  const cleanupProductEvents = registerProductEventsIpc(ipc, { featureUsed: tool => productEvents.featureUsed(tool), state: { canSend: productEvents.canSend, offBy: productEventsOffBy(env) } }, senders)
  const cleanupUsage = registerUsageIpc(ipc, {
    read: query => { productEvents.featureUsed('usage'); return hostRouter.usageRead(query) },
    refresh: query => hostRouter.usageRefresh(query),
    clear: query => hostRouter.usageClear(query),
  }, senders, usageEnabled)
  const cleanupDelegations = registerDelegationIpc(ipc, delegationService, senders, () => agentControl.hostId(),
    (channel, payload) => { shellBridge.sendToMain(channel, payload) }, crossMachineEnabled ? hostRouter : undefined, watcherEnabled && crossMachineEnabled, owlFeatures['dynamic-threads'])
  const cleanupCoordination = registerThreadCoordinationIpc(ipc, threadCoordinationService, senders, () => agentControl.hostId(),
    (channel, payload) => { shellBridge.sendToMain(channel, payload) }, owlFeatures['parent-thread-coordination'] ? hostRouter : undefined)
  const dynamicRecord = 'dynamicRecord' in localRuntime && localRuntime.dynamicRecord ? localRuntime.dynamicRecord : owlFeatures['dynamic-threads'] ? new DynamicRecord(userDataPath) : undefined
  const cleanupDynamicRecord = registerDynamicRecordIpc(ipc, owlFeatures['dynamic-threads'], dynamicRecord, senders)
  const cleanupCheckQueues = registerCheckQueueIpc(ipc, watcherEnabled && crossMachineEnabled, 'checks' in localRuntime ? localRuntime.checks : undefined,
    senders, () => agentControl.hostId(), (channel, payload) => { shellBridge.sendToMain(channel, payload) }, hostRouter)
  const cleanupContinue = registerContinueIpc(ipc, continueService, senders)
  const cleanupCouncil = registerCouncilIpc(ipc, councilService, senders, () => agentControl.hostId(), (channel, payload) => { shellBridge.sendToMain(channel, payload) })
  const cleanupThreadMoves = registerThreadMoveIpc(ipc, watcherEnabled && crossMachineEnabled ? threadMoves : undefined, senders,
    (channel, payload) => { shellBridge.sendToMain(channel, payload) })
  const cleanupNextPrompts = registerNextPromptIpc(ipc, nextPromptEnabled, localRuntime.nextPrompts, () => agentControl.hostId(), senders, hostRouter,
    async (modelId, signal) => {
      if (!workingCopySettings.nextPromptSuggestions || !agentHistoryEnabled) return null
      const facts = nextPromptWatcherFacts(hostRouter.view().host)
      if (facts.threads.length === 0) return null
      const { instruction, material, purpose } = nextPromptWatcherRequest(facts)
      return parseNextPrompt(await agentHost.writeShortTextOn({ modelId }, { instruction, material, purpose }, signal))
    })
  const unsubscribeHostNextPrompts = nextPromptEnabled ? hostRouter.subscribeNextPrompts(entry => shellBridge.sendToMain(NEXT_PROMPT_CHANGED, entry)) : undefined
  const cleanupMainCheckout = registerMainCheckoutIpc(ipc, localRuntime.mainCheckout, senders,
    async path => { const error = await shellBridge.openPath(path); if (error) throw new Error('Sotto could not open that folder.') })
  const unsubscribeMainCheckout = localRuntime.mainCheckout?.subscribe(state => { shellBridge.sendToMain(MAIN_CHECKOUT_CHANGED, state) })
  const cleanupOpenCodeSignIn = registerOpenCodeSignInIpc(ipc, heldProviders.has('opencode') ? undefined : localRuntime.opencodeSignIn, senders)
  const cleanupProviderSignIn = registerLocalProviderSignInIpc(ipc, localRuntime.providerSignIn, senders)
  const cleanupCursorSignIn = registerCursorSignInIpc(ipc, heldProviders.has('cursor') ? undefined : localRuntime.cursorSignIn, senders)
  // Antigravity's Gemini Enterprise sign-in, Sign out and its own download from its row (ADR-0212).
  const cleanupAntigravityAccount = registerAntigravityAccountIpc(ipc, localRuntime.antigravityAccount, senders)
  const cleanupOwnServers = registerOwnServersIpc(ipc, ownServers, senders)
  const cleanupOwnServerCleanup = registerOwnServerCleanupIpc(ipc, ownServerCleanup, senders)
  const cleanupMemory = registerMemoryIpc(ipc, startupSettings.memoryEnabled ? memoryProfile : undefined, senders, snapshot => shellBridge.sendToMain(MEMORY_CHANGED, snapshot))

  const hostTailscale = new HostTailscale({
    ...(e2eConfiguration ? { invoke: tailscaleInvoker(e2eHostsTailscale(userDataPath), ['tailscale']) } : {}),
    suggestions: () => discoverSshHosts(e2eConfiguration ? { home: join(userDataPath, 'e2e-home') } : {}),
    openExternal: async url => { if (e2eConfiguration === null) await shellBridge.openExternal(url) },
  })
  const cleanupHosts = registerHostsIpc(ipc, desktopHosts, senders, state => shellBridge.sendToMain(HOSTS_CHANGED, state), hostTailscale, { opencode: !heldProviders.has('opencode') })
  const cleanupPhones = registerPhonesIpc(ipc, phoneAccess, senders, state => shellBridge.sendToMain(PHONES_CHANGED, state))
  const cleanupTeams = teams ? registerTeamsIpc(ipc, teams, senders, state => shellBridge.sendToMain(TEAMS_CHANGED, state)) : undefined
  const cleanupLocalApps = localApps ? registerLocalAppsIpc(ipc, localApps, senders, state => shellBridge.sendToMain(LOCAL_APPS_CHANGED, state)) : undefined

  const cleanupPlugins = pluginsEnabled ? registerPluginsIpc(ipc, {
    gitHubSignIn: pluginsGitHubSignIn,
    gitHubSignInElsewhere: () => readHostGitHubSignIns(
      desktopHosts.get().hosts.map(host => ({ id: host.id, name: host.name, hostId: host.hostId, connected: host.phase === 'connected' })), () => hostRouter.remoteConnections()),
    accounts: async () => await pluginAccounts?.list() ?? [],
    addAccount: async request => { const result = await pluginAccounts?.add(request) ?? { ok: false as const, problem: 'store' as const }; if (result.ok) pluginCopySync?.accountsChanged(); return result },
    replaceSecret: async request => { const result = await pluginAccounts?.replace(request) ?? { ok: false as const, problem: 'store' as const }; if (result.ok) pluginCopySync?.accountsChanged(); return result },
    updateAccount: async request => {
      const result = await pluginAccounts?.update(request) ?? { ok: false as const, problem: 'store' as const }
      if (result.ok) pluginCopySync?.accountsChanged()
      if (result.ok) shellBridge.sendToMain(PLUGINS_MAIL_GRANTS_CHANGED, null)
      return result
    },
    trustCertificate: async request => await pluginAccounts?.trustCertificate(request) ?? { ok: false as const, problem: 'store' as const },
    bridgeStatus: async request => {
      const account = (await pluginAccounts?.list().catch(() => []) ?? []).find(entry => entry.id === request.id)
      return account ? bridgeStatus(account, mailOptions) : 'unknown'
    },
    meshyCredits: async () => {
      const here = await modelRecords?.monthCredits() ?? new Map<string, number>()
      const names = new Map(desktopHosts.get().hosts.flatMap(host => host.hostId ? [[host.hostId, host.name] as const] : []))
      const ids = new Set([...(await pluginAccounts?.list() ?? []).filter(account => account.plugin === 'meshy').map(account => account.id), ...here.keys()])
      return Object.fromEntries(await Promise.all([...ids].map(async id => [id, {
        here: here.get(id) ?? 0,
        credits: await meshySpending?.monthTotal(id).catch(() => undefined) ?? here.get(id) ?? 0,
        across: (await meshySpending?.reportedBy(id).catch(() => []) ?? []).flatMap(hostId => { const name = names.get(hostId); return name ? [name] : [] }),
      }] as const)))
    },
    elevenLabsSpent: async () => {
      const here = await soundRecords?.monthSpent() ?? new Map<string, number>()
      const names = new Map(desktopHosts.get().hosts.flatMap(host => host.hostId ? [[host.hostId, host.name] as const] : []))
      const ids = new Set([...(await pluginAccounts?.list() ?? []).filter(account => account.plugin === 'elevenlabs').map(account => account.id), ...here.keys()])
      return Object.fromEntries(await Promise.all([...ids].map(async id => [id, {
        spent: (here.get(id) ?? 0) + (await elevenLabsSpending?.others(id).catch(() => 0) ?? 0) / 100,
        across: (await elevenLabsSpending?.reportedBy(id).catch(() => []) ?? []).flatMap(hostId => { const name = names.get(hostId); return name ? [name] : [] }),
      }] as const)))
    },
    model3d: async id => hostModels?.onHost(id) ? await hostModels.view(id) : modelViews ? await modelViewOf(modelViews, id) : null,
    model3dBytes: async request => hostModels?.onHost(request.id) ? await hostModels.bytes(request) : modelViews ? await modelBytes(modelViews, request) : null,
    models3d: async threadKey => {
      if (threadKey !== undefined && hostModels?.onHost(threadKey)) return await hostModels.list(threadKey)
      const threadId = threadKey === undefined ? undefined : ownThreadId(threadKey, agentControl.hostId())
      if (threadId === null) return []
      const [own, hosts] = await Promise.all([modelViews ? listModels(modelViews, threadId) : [], threadKey === undefined ? hostModels?.list() ?? [] : []])
      return hosts.length === 0 ? own : [...own, ...hosts].sort((a, b) => Date.parse(b.askedAt) - Date.parse(a.askedAt)).slice(0, MODELS_3D_LISTED_MAX)
    },
    removeModel3d: async id => {
      const onHost = hostModels?.onHost(id) ? await hostModels.remove(id) : undefined
      if (onHost === 'away') throw new Error('host-away')
      const removal = onHost ?? (modelViews ? await removeGoneModel(modelViews, id) : 'no-record')
      if (removal === 'removed') { shellBridge.sendToMain(PLUGINS_MODELS_3D_REMOVED, [id]); phoneModelViews?.removed([id]) }
      return removal
    },
    revealModel3d: async request => !hostModels?.onHost(request.id) && modelViews ? await revealModelFile(modelViews, request, path => { if (e2eConfiguration !== null) shellBridge.onE2EFileAction?.('show', path); else shellBridge.revealInFolder(path) }) : false,
    sound: async id => hostSounds?.onHost(id) ? await hostSounds.view(id) : soundViews ? await soundViewOf(soundViews, id) : null,
    soundBytes: async id => hostSounds?.onHost(id) ? await hostSounds.bytes(id) : soundViews ? await soundBytes(soundViews, id) : null,
    revealSound: async id => !hostSounds?.onHost(id) && soundViews ? await revealSoundFile(soundViews, id, path => { if (e2eConfiguration !== null) shellBridge.onE2EFileAction?.('show', path); else shellBridge.revealInFolder(path) }) : false,
    copies: async () => await pluginCopySync?.view() ?? { copyNew: true, readable: true, computers: [], copies: [] },
    setCopy: async request => { await pluginCopySync?.setCopy(request.accountId, request.computerId, request.on); return await pluginCopySync?.view() ?? { copyNew: true, readable: true, computers: [], copies: [] } },
    setCopyNew: async copyNew => { await pluginCopySync?.setCopyNew(copyNew); return await pluginCopySync?.view() ?? { copyNew: true, readable: true, computers: [], copies: [] } },
    mailGrants: async threadKey => {
      const threadId = ownThreadId(threadKey, agentControl.hostId())
      if (threadId === null || !mailGrants || !pluginAccounts || !mailGrants.open(threadId)) return []
      const held = await mailGrants.list()
      if (!held.some(grant => grant.threadId === threadId)) return []
      return mailGrantsShown(held, await pluginAccounts.list(), threadId, pluginProjectOf(threadId))
    },
    stopMailGrant: async request => {
      const threadId = ownThreadId(request.threadId, agentControl.hostId())
      return threadId === null ? false : await mailGrants?.stop(threadId, request.accountId) ?? false
    },
    projects: () => {
      if (!localRuntime) throw new Error('PLUGIN_PROJECTS_UNAVAILABLE')
      return pluginProjects(localRuntime.agentControl.watcherSnapshot().projects)
    },
    removeAccount: async request => {
      const result = await pluginAccounts?.remove(request) ?? { ok: false as const, problem: 'store' as const }
      if (result.ok) void pluginUse?.forgetAccount(request.id).catch(() => undefined)
      if (result.ok) void mailGrants?.forgetAccount(request.id).catch(() => undefined)
      if (result.ok) pluginCopySync?.accountsChanged()
      return result
    },
    recentUse: async () => {
      const uses = await pluginUse?.list() ?? []
      if (uses.length === 0) return []
      const titles = new Map(localRuntime?.agentControl.watcherSnapshot().threads.map(thread => [thread.id, thread.title]))
      return uses.map(use => ({ ...use, threadTitle: titles.get(use.threadId)?.slice(0, PLUGIN_USE_THREAD_TITLE_MAX) ?? null }))
    },
  }, senders) : undefined

  // Wrap hostRouter.command so any command that mutates threads/projects refreshes the shell's FilesBindingsMirror
  // before the command receipt returns to the window.
  const hostRouterCommandWrapper = {
    command: async (command: Parameters<typeof hostRouter.command>[0], client: Parameters<typeof hostRouter.command>[1]) => {
      const result = await hostRouter.command(command, client)
      pushLocalBindings()
      pushHostedBindings()
      return result
    },
  }
  const cleanupAgents = registerAgentIpcCore(ipc, hostRouter, hostRouterCommandWrapper, senders, {
    encodeReceipt: agentStateBroadcaster.encodeReceipt,
    encodeChangedThreadRecordsReceipt: agentStateBroadcaster.encodeChangedThreadRecordsReceipt,
    windowRead: agentStateBroadcaster.windowRead,
    readWhole: agentStateBroadcaster.readWhole,
    popupObserves: threadIds => { popupFeed?.observe(threadIds); shellBridge.onPopupObserved?.(threadIds) },
    popupShown: () => popupShown,
    workingCopyOptions: projectId => {
      const key = parseHostEntityKey(projectId)
      if (key && key.hostId !== agentControl.hostId()) throw new Error('Working-copy choices are on the host machine. Use the existing project folder or create its worktree there.')
      return agentHost.workingCopyOptions(key?.id ?? projectId)
    },
  })

  const desktopWatcher = createWatcherRoomDesktop({
    watcherEnabled,
    streamingPublishCost: owlFeatures['streaming-publish-cost'],
    machinesEnabled: crossMachineEnabled,
    holdEnabled: owlFeatures['restart-stopped-threads'],
    watcher: localRuntime?.watcher,
    send: state => shellBridge.sendToMain(WATCHER_CHANGED, state),
  })

  // E2E tool channels (only registered in development E2E runs).
  const cleanupE2ETools: (() => void)[] = []
  if (e2eConfiguration !== null) {
    ipc.handle(E2E_HOST_SETUP_TOOL_CHANNEL, (event, payload: unknown) => {
      if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error('E2E_SENDER_REJECTED')
      const request = e2eHostSetupToolSchema.parse(payload)
      return hostSetupTools.call(hostSetup.threadId() ?? providerJobs.threadId() ?? '', request.name, {})
    })
    ipc.handle(E2E_VISUAL_TOOL_CHANNEL, (event, payload: unknown) => {
      if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error('E2E_SENDER_REJECTED')
      const request = e2eVisualToolSchema.parse(payload)
      return visualTools.call(parseHostEntityKey(request.threadId)?.id ?? request.threadId, VISUALIZE_TOOL, request.arguments)
    })
    ipc.handle(E2E_MEDIA_TOOL_CHANNEL, (event, payload: unknown) => {
      if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error('E2E_SENDER_REJECTED')
      const request = e2eVisualToolSchema.parse(payload)
      if (!mediaTools) throw new Error('E2E_MEDIA_TOOL_OFF')
      return mediaTools.call(parseHostEntityKey(request.threadId)?.id ?? request.threadId, SHOW_IN_THREAD_TOOL, request.arguments)
    })
    ipc.handle(E2E_DELEGATION_TOOL_CHANNEL, (event, payload: unknown) => {
      if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error('E2E_SENDER_REJECTED')
      const request = e2eDelegationToolSchema.parse(payload)
      if (!delegationTools) throw new Error('Delegation is off in this build.')
      return delegationTools.call(parseHostEntityKey(request.threadId)?.id ?? request.threadId, request.name, request.arguments)
    })
    ipc.handle(E2E_PLUGIN_TOOL_CHANNEL, (event, payload: unknown) => {
      if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error('E2E_SENDER_REJECTED')
      const request = e2ePluginToolSchema.parse(payload)
      if (!pluginTools) throw new Error('Plugins are off in this build.')
      return pluginTools.call(parseHostEntityKey(request.threadId)?.id ?? request.threadId, request.name, request.arguments)
    })
    ipc.handle(AGENT_E2E, (event, payload: unknown) => {
      if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error('E2E_SENDER_REJECTED')
      const parsed = e2eAgentEventSchema.parse(payload)
      testAgentHost?.event(parsed)
    })
    cleanupE2ETools.push(() => {
      ipc.removeHandler(E2E_HOST_SETUP_TOOL_CHANNEL)
      ipc.removeHandler(E2E_VISUAL_TOOL_CHANNEL)
      ipc.removeHandler(E2E_MEDIA_TOOL_CHANNEL)
      ipc.removeHandler(E2E_DELEGATION_TOOL_CHANNEL)
      ipc.removeHandler(E2E_PLUGIN_TOOL_CHANNEL)
      ipc.removeHandler(AGENT_E2E)
    })
  }

  const observedCertifiedDetails = new Map<string, readonly AgentActivity[]>()

  let publishingStopped = false
  const stopPublishing = (): void => {
    if (publishingStopped) return
    publishingStopped = true
    unsubscribeRequestDrafts()
    unsubscribeAgents()
    unsubscribeAgentDetail()
    unsubscribeBindingsRouter()
    unsubscribeBindingsHosts()
    agentStatePublisher.dispose()
    agentDetailPublisher.dispose()
    popupDetailPublisher?.dispose()
  }

  let ipcDisposed = false
  const disposeIpc = (): void => {
    if (ipcDisposed) return
    ipcDisposed = true
    for (const stop of cleanupE2ETools) stop()
    cleanupAgents()
    cleanupHosts()
    cleanupPhones()
    cleanupTeams?.()
    cleanupLocalApps?.()
    pluginsStop.abort()
    pluginChanges?.close()
    mailGrants?.close()
    cleanupPlugins?.()
    stopFollowingCopies()
    pluginCopySync?.close()
    meshySpending?.close()
    elevenLabsSpending?.close()
    checkpointIntegration.dispose()
    cleanupRequestDrafts()
    cleanupFiles()
    cleanupSubagents()
    cleanupUsage()
    cleanupProductEvents()
    cleanupDelegations()
    cleanupCoordination()
    coordinationRelay?.close()
    cleanupDynamicRecord()
    cleanupCheckQueues()
    cleanupContinue()
    cleanupCouncil()
    cleanupThreadMoves()
    cleanupNextPrompts()
    unsubscribeHostNextPrompts?.()
    cleanupMainCheckout()
    unsubscribeMainCheckout?.()
    cleanupOpenCodeSignIn()
    cleanupCursorSignIn()
    cleanupAntigravityAccount()
    cleanupProviderSignIn()
    cleanupOwnServers()
    cleanupOwnServerCleanup()
    worktreeCleanup?.dispose()
    gitChanges.dispose()
    for (const stop of stopHostBrowser) stop()
    cleanupMemory()
    desktopWatcher?.dispose()
  }

  let localClosing: Promise<void> | undefined
  const closeLocal = (): Promise<void> => localClosing ??= localRuntime.close()
  let closing: Promise<void> | undefined

  const prepareForShutdown = (): void => {
    stopPublishing()
    const local = localRuntime.prepareForShutdown?.() ?? closeLocal()
    void local.catch(() => undefined)
  }

  const close = (): Promise<void> => closing ??= (async () => {
    stopPublishing()
    stopAlerts?.()
    threadAlerts?.dispose()
    for (const release of terminalLeases.values()) release()
    terminalLeases.clear()
    await Promise.all([
      phoneAccess.close().catch(() => log('phone-access-close-failed')),
      localApps?.close().catch(() => undefined),
      teams?.close().catch(() => undefined),
    ])
    await hostSetup.close().catch(() => undefined)
    providerJobs.close()
    hostUpdates.dispose()
    hostBoot.dispose()
    hostPhones.close()
    const councilResults = await Promise.allSettled([councilService?.close()])
    const closeDesktopHosts = async (): Promise<void> => {
      if (!remoteHostE2E) { await desktopHosts.close(); return }
      try { await desktopHosts.close() }
      finally { try { await remoteHostE2E.close() } finally { await retainedDrafts.close() } }
    }
    const results = await Promise.allSettled([
      councilService?.settled(),
      closeDesktopHosts(),
      closeLocal(),
      hostSetupTools.close(),
      visualTools.close(),
      mediaTools?.close(),
      pluginTools?.close(),
      pullRequestTools?.close(),
      delegationTools?.close(),
      coordinationTools?.close(),
      tellTools?.close(),
      councilTools?.close(),
      pictureMaker?.close(),
      rustLocalEngine?.close(),
    ])
    hostRouter.dispose()
    disposeIpc()
    productEvents.stop()
    memoryStore?.close()
    const failure = [...councilResults, ...results].find(result => result.status === 'rejected')
    if (failure?.status === 'rejected') throw failure.reason
  })()

  return {
    metadata: {
      localHostId: agentControl.hostId(),
      hasOwnServers: ownServers !== undefined,
      hasOwnServerCleanup: ownServerCleanup !== undefined,
      hasCouncil: councilService !== undefined,
      hasWatcher: watcherEnabled,
      keepMainCurrentEnabled,
    },
    channels: () => ipc.channels(),
    invokeIpc: (channel, role, args) => ipc.invoke(channel, role, args),
    watcherBridge: desktopWatcher?.bridge,

    setWindowFocus(state) {
      windowFocus = state
      hostService.setWindowFocused(state.focused)
      hostRouter.setWindowFocused(state.focused)
    },
    setPopupShown(shown) { popupShown = shown },
    setPopupObserved(threadIds) { popupFeed?.observe(threadIds) },
    setRunningTerminals(threadIds) { runningTerminalThreads = new Set(threadIds) },
    async acquireTerminalStart(workingDirectory) {
      const release = await agentHost.acquireTerminalStart(workingDirectory)
      const leaseId = randomUUID()
      terminalLeases.set(leaseId, release)
      return leaseId
    },
    releaseTerminalStart(leaseId) {
      const release = terminalLeases.get(leaseId)
      if (!release) return
      terminalLeases.delete(leaseId)
      release()
    },

    async onSettingsChanged(settings, previous) {
      const grantDefaultChanged = settings.browserWithoutAsking !== previous.browserWithoutAsking
      const babysittingChanged = !babysittingRetired && settings.babysitPullRequests !== previous.babysitPullRequests
      const workerRolesChanged = JSON.stringify(settings.workerRoles) !== JSON.stringify(previous.workerRoles)
      workingCopySettings = settings
      const productEventAnswer = productEventsPermission(settings)
      productEvents.setPermission(productEventAnswer)
      if (productEventAnswer !== productEventsPermission(previous)) {
        hostRouter.tellProductEventAnswer()
        if (productEventAnswer === 'on') productEvents.record('app.started', { pairedHosts: desktopHosts.get().hosts.length })
      }
      if (nextPromptEnabled && settings.nextPromptSuggestions !== previous.nextPromptSuggestions) hostRouter.setNextPromptsWanted(settings.nextPromptSuggestions)
      if (workerRolesChanged && 'workerRoles' in localRuntime) localRuntime.workerRoles?.changed()
      if (workerRolesChanged || settings.workerCeiling !== previous.workerCeiling || settings.workerMachineCeilings !== previous.workerMachineCeilings || settings.showEveryAgentPicture !== previous.showEveryAgentPicture) desktopDefaultsFollow?.defaultsChanged()
      worktreeCleanup?.settingsChanged()
      if (settings.keepMainCurrent !== previous.keepMainCurrent || JSON.stringify(settings.projectKeepMainCurrent) !== JSON.stringify(previous.projectKeepMainCurrent)) localRuntime.mainCheckout?.settingsChanged()
      localRuntime.watcher?.settingsChanged()
      localRuntime.workerAdmission?.refresh()
      phoneAccess.settingsChanged()
      if (settings.localApps !== previous.localApps) localApps?.settingsChanged()
      if (grantDefaultChanged && pairedHostBrowser) for (const connection of hostRouter.remoteConnections()) void hostRouter.tellBrowserSetting(connection, settings.browserWithoutAsking).catch(() => log('host-browser-setting-failed'))
      if (babysittingChanged) void pullRequestTools?.settingChanged().catch(() => undefined)
      agentHistoryEnabled = settings.historyEnabled
    },
    cleanSettingsHistory(afterClean) {
      return cleanSettingsHistory(agentControl, afterClean, [cleanRetiredHistory])
    },
    async onInterfaceLanguageChanged() {
      desktopHosts.languageChanged()
      hostUpdates.languageChanged()
      hostSetup.languageChanged()
    },
    onAppUpdatePhaseChanged(version) {
      waitingHostVersion = version
      hostUpdates.pending(waitingHostVersion)
    },
    checkClientsAfresh() {
      void agentControl.checkClientsAfresh().catch(() => undefined)
      void hostRouter.checkHostClientsAfresh()
    },
    restartHold: () => hostUpdates.restartHold(),
    featureUsed: feature => productEvents.featureUsed(feature),

    readVisual: (threadId, visualId) => Promise.resolve(agentHost.visual(threadId, visualId)),
    threadMediaPart: part => hostRouter.threadMediaPart(part),
    resolveOwnCleanupServer: async choice => ownServerCleanup ? ownServerCleanup.resolve(choice) : { status: 'gone' },
    questionPageOpening: input => hostRouter.questionPageOpening(input),
    questionPageOpened: input => hostRouter.questionPageOpened(input),
    phoneAccessPagePort: () => phoneAccess.pagePort() ?? null,
    openNotificationThread: threadId => {
      const watcher = localRuntime.watcher ? agentControl.watcherRecords.view().current : null
      return openNotificationThread(hostRouter, threadId, watcher ? hostEntityKey(watcher.target.hostId, watcher.target.threadId) : undefined)
    },
    popupCommand: async (command, client) => {
      if (command.type === 'observe-threads') popupFeed?.observe(command.threadIds)
      const state = await hostRouter.command(command, client)
      pushLocalBindings()
      pushHostedBindings()
      return state
    },
    gitChangesCall: (method: GitChangesMethod, payload: unknown) => Promise.resolve(gitChanges[method](payload)),
    hostedGitChangesCall: async (method: HostedGitChangesMethod, payload: unknown) => {
      if (method === 'list') return hostRouter.gitChanges(payload as Parameters<typeof hostRouter.gitChanges>[0])
      if (method === 'review') return hostRouter.gitReview(payload as Parameters<typeof hostRouter.gitReview>[0])
      return copyHostPath(await hostRouter.gitChangesPath(payload as Parameters<typeof hostRouter.gitChangesPath>[0]))
    },
    hostedBrowserCall: request => hostRouter.hostedBrowser(request),
    hostedBrowserAddress: hostId => desktopHosts.browserAddress(hostId),
    async turnRecordsInfo() {
      await writeFile(turns.path(), '', { flag: 'wx' }).catch(() => undefined)
      return { path: turns.path(), recentCount: (await turns.recent(20)).length }
    },

    e2eAgentEvent(payload) {
      const parsed = e2eAgentEventSchema.parse(payload)
      testAgentHost?.event(parsed)
    },
    e2eCertifiedDetailObservation() {
      if (!nativeFixtureRoot || env['SOTTO_E2E_CERTIFIED_DETAIL_OBSERVATION'] !== '1') return undefined
      const tracked = (agentControl as unknown as { revisions: { certifiedDetailRevisions: ReadonlyMap<string, { activities: readonly AgentActivity[] }> } }).revisions.certifiedDetailRevisions
      let ownedThreads = 0, reusedRecords = 0
      for (const [threadId, detail] of tracked) {
        if (isImmutableActivities(detail.activities)) ownedThreads++
        const previous = new Set(observedCertifiedDetails.get(threadId))
        reusedRecords += detail.activities.filter(record => previous.has(record)).length
        observedCertifiedDetails.set(threadId, detail.activities)
      }
      for (const id of observedCertifiedDetails.keys()) if (!tracked.has(id)) observedCertifiedDetails.delete(id)
      return { trackedThreads: tracked.size, ownedThreads, reusedRecords }
    },

    resetWindowBroadcast: () => agentStateBroadcaster.windowRead(),

    prepareForShutdown,
    disposeIpc,
    close,
  }
}
