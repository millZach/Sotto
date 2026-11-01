import { HOSTS_GET, HOSTS_COMMAND, HOSTS_CHANGED, hostsCommandSchema, type HostsState } from '../shared/hosts'
import { HOSTS_DEVICES, HOSTS_TAILSCALE, HOSTS_TAILSCALE_CONNECT, HOSTS_TAILSCALE_DOWNLOAD, type HostDeviceList, type TailscaleConnectOutcome, type TailscaleSummary } from '../shared/hostDevices'
import { HOST_OPENCODE_ANSWERS, HOSTS_OPENCODE_SIGN_IN, HOSTS_PROVIDER_ACTION, HOSTS_SIGN_IN, HOSTS_UPDATE_CLIENTS, hostOpenCodeSignInRequestSchema, hostClientUpdateRequestSchema, hostProviderActionSchema, hostSignInRequestSchema, type HostProviderActionResult, type ProviderSignInView } from '../shared/hostProviders'
import { PHONES_GET, PHONES_COMMAND, PHONES_CHANGED, phonesCommandSchema, type PhonesState } from '../shared/phones'
import { mapHostReferences, parseHostEntityKey } from '../shared/clientIdentity'

import { WATCHER_GET, WATCHER_OPEN, WATCHER_PREPARE_STOP_ALL, WATCHER_STOP_ALL, WATCHER_SET_PERMISSION, WATCHER_WATCH_THREAD, WATCHER_UNWATCH_THREAD,
  WATCHER_READ_HANDOVER, WATCHER_CONTINUE_HANDOVER, WATCHER_DISMISS_HANDOVER, WATCHER_START_NEW, watcherContinueHandoverRequestSchema, watcherHandoverReadSchema,
  WATCHER_READ_MACHINES, WATCHER_MACHINES_RENDERER_ARGUMENT, watcherMachinesReadSchema, WATCHER_RENDERER_ARGUMENT, watcherOpenRequestSchema, watcherRoomResultSchema,
  watcherPrepareStopAllResultSchema, watcherStopAllRequestSchema, watcherStopAllResultSchema,
  watcherSetPermissionRequestSchema, watcherWatchThreadRequestSchema, type WatcherBridge } from '../shared/watcherRoom'
import { watcherRoomForwarding } from './watcherRoomForwarding'
import { hostClientBridge } from './hostClientBridge'
import { REQUEST_DRAFT_GET, REQUEST_DRAFT_STATUS, REQUEST_DRAFT_SAVE, REQUEST_DRAFT_CHECK, REQUEST_DRAFT_CHANGED, REQUEST_DRAFT_LIST, REQUEST_DRAFT_DISCARD, requestDraftSchema, requestDraftCheckResultSchema, requestDraftStatusSchema, requestDraftTargetSchema, requestDraftOwnerSchema, requestDraftDiscardSchema, type RequestDraftBridge } from '../shared/requestDrafts'
import { contextBridge, ipcRenderer } from 'electron'
import { VISUAL_PAGE_OPEN, visualPageRequestSchema, visualPageResultSchema, type VisualPagesBridge } from '../shared/visualPages'
import { SUBAGENTS_PAGE, SUBAGENTS_ASSIGNMENTS, SUBAGENTS_CHANGED, subagentPageRequestSchema, subagentAssignmentsRequestSchema, subagentPageSchema, subagentAssignmentsPageSchema, subagentChangeSchema, type SubagentsBridge } from '../shared/subagents'
import { CHECK_QUEUES_CHANGED, CHECK_QUEUES_READ, checkQueuesViewSchema, type CheckQueuesBridge } from '../shared/checkQueue'
import { DELEGATION_BRIEF_READ, DELEGATION_CHECK_REPLY_READ, DELEGATIONS_READ, DELEGATIONS_CHANGED, DELEGATION_RENDERER_ARGUMENT, delegationBriefRequestSchema, delegationBriefSchema, delegationCheckReplyRequestSchema, delegationCheckReplySchema,
  delegationsReadSchema, delegationsRequestSchema, delegationsChangedSchema, type DelegationsBridge } from '../shared/delegation'
import {
  OPENCODE_HOSTS_RENDERER_ARGUMENT, OPENCODE_RENDERER_ARGUMENT, OPENCODE_SIGN_IN_BROWSER, OPENCODE_SIGN_IN_CANCEL, OPENCODE_SIGN_IN_EXTERNAL, OPENCODE_SIGN_IN_FINISH, OPENCODE_SIGN_IN_KEY,
  OPENCODE_SIGN_IN_REOPEN, OPENCODE_SIGN_IN_WAIT, OPENCODE_SIGN_OUT, OPENCODE_SOURCES_READ, modelSourcesSchema, signInAttemptRequestSchema, signInDoneSchema,
  signInFinishRequestSchema, signInKeyRequestSchema, signInMethodRequestSchema, signInResultSchema, signInStartSchema, signInWaitSchema, signOutRequestSchema,
  type OpenCodeSignInBridge,
} from '../shared/opencodeSignIn'
import { CURSOR_RENDERER_ARGUMENT, CURSOR_SIGN_IN_CANCEL, CURSOR_SIGN_IN_READ, CURSOR_SIGN_IN_REOPEN, CURSOR_SIGN_IN_START, CURSOR_SIGN_OUT, cursorSignInDoneSchema,
  cursorSignInRequestSchema, cursorSignInStartSchema, cursorSignInViewSchema, type CursorSignInBridge } from '../shared/cursorSignIn'
import {
  addRequestSchema, addResultSchema, checkRequestSchema, checkResultSchema, checkSavedRequestSchema, OWN_SERVERS_ADD, OWN_SERVERS_CHECK, OWN_SERVERS_CHECK_SAVED,
  OWN_SERVERS_LIST, OWN_SERVERS_REMOVE, OWN_SERVERS_RENDERER_ARGUMENT, ownServerListSchema, removeRequestSchema, removeResultSchema, type OwnServersBridge,
} from '../shared/ownModelServers'
import {
  OWN_SERVER_CLEANUP_MEASURE, OWN_SERVER_CLEANUP_MEASURED, OWN_SERVER_CLEANUP_RENDERER_ARGUMENT, ownCleanupChoiceSchema, ownCleanupMeasuredListSchema,
  ownCleanupMeasureResultSchema, type OwnServerCleanupBridge,
} from '../shared/ownServerCleanup'
import { NEXT_PROMPT_CHANGED, NEXT_PROMPT_READ, NEXT_PROMPT_RENDERER_ARGUMENT, nextPromptEntriesSchema, nextPromptEntrySchema, type NextPromptBridge } from '../shared/nextPrompt'
import { THREAD_MOVE_ANSWER, THREAD_MOVE_PREPARE, THREAD_MOVE_START, THREAD_MOVES_CHANGED, THREAD_MOVES_READ, threadMoveAnswerRequestSchema, threadMoveAnswerSchema,
  threadMovePrepareRequestSchema, threadMovePrepareSchema, threadMovesViewSchema, threadMoveStartRequestSchema, threadMoveStartSchema,
  type ThreadMovesBridge } from '../shared/threadMoves'
import { CONTINUE_READ, CONTINUE_START, CONTINUE_RENDERER_ARGUMENT, continueReadRequestSchema, continueReadSchema, continueStartRequestSchema, continueStartSchema, type ContinueBridge } from '../shared/continueThread'
import { MAIN_CHECKOUT_CHANGED, MAIN_CHECKOUT_CHANGES, MAIN_CHECKOUT_COMMAND, MAIN_CHECKOUT_READ, MAIN_CHECKOUT_RENDERER_ARGUMENT, mainCheckoutChangesSchema, mainCheckoutCommandSchema,
  mainCheckoutStateSchema, type MainCheckoutBridge } from '../shared/mainCheckout'
import { GLASS_WINDOW_CHANGED, GLASS_WINDOW_SET, glassWindowRequestSchema, glassWindowResultSchema, parseGlassWindowArguments, type GlassWindowBridge, type GlassWindowState } from '../shared/glassWindow'
import { MAIN_ACTIVITY_CHANGED, MAIN_ACTIVITY_COMMAND, MAIN_ACTIVITY_READ, MAIN_ACTIVITY_RENDERER_ARGUMENT, mainActivityCommandSchema, mainActivityStateSchema, type MainActivityBridge } from '../shared/mainActivity'
import { INTERFACE_LANGUAGE_CHANGED, INTERFACE_LANGUAGE_GET, interfaceLanguageStateSchema, parseInterfaceLanguageArgument, type InterfaceLanguageBridge } from '../shared/interfaceLanguageBridge'
import type { InterfaceLanguageState } from '../shared/interfaceLanguages'
import { DESKTOP_NOTIFICATIONS_RENDERER_ARGUMENT, NOTIFICATION_OPENED, NOTIFICATION_TEST, notificationOpeningSchema, notificationTestResultSchema, type NotificationsBridge } from '../shared/desktopNotifications'
import { USAGE_READ, USAGE_REFRESH, USAGE_CLEAR, USAGE_RENDERER_ARGUMENT, USAGE_HOSTS_MAX, usageQuerySchema, usageRefreshQuerySchema, usageClearQuerySchema, usageDashboardReadSchema, usageClearResultSchema, type UsageBridge } from '../shared/usageDashboard'
import { createToolsBridges } from './tools'
import { createCloudIphoneBridge } from './cloudIphone'
import { createThemesBridge } from './themes'
import { OMARCHY_SETUP_GET, OMARCHY_SETUP_COMMAND, OMARCHY_SETUP_CHANGED, OMARCHY_SETUP_FOCUS, omarchySetupCommandSchema, omarchySetupStateSchema, type OmarchySetupBridge } from '../shared/omarchySetup'
import { speechModelListSchema, speechModelStatusSchema } from '../shared/speechModel'
import { FILES_LIST, FILES_PREVIEW, FILES_COPY_PATH, FILES_REVEAL, FILES_REVEAL_LINK, fileLinkRequestSchema, fileLinkSchema, fileListRequestSchema, fileRequestSchema, fileListingSchema, filePreviewSchema, filePathSchema, filesResultSchema, type FilesBridge } from '../shared/files'
import { AGENT_CHOOSE_PROJECT_DIRECTORY, AGENT_WORKING_COPY_OPTIONS, agentWorkingCopyOptionsSchema, agentWorkingCopyOptionsRequestSchema } from '../shared/agents'
import { AGENT_GIT_REFS, gitRefsPageSchema, gitRefsRequestSchema } from '../shared/gitRefs'
import { AGENT_GIT_CHANGED_FILES, gitChangedFilesRequestSchema, gitChangedFilesSchema } from '../shared/gitChangedFiles'
import { AGENT_GIT_PULL_REQUEST, gitPullRequestRequestSchema, gitPullRequestResultSchema } from '../shared/gitPullRequests'
import { AGENT_HOST_FOLDERS, hostFoldersClientRequestSchema, hostFoldersResultSchema } from '../shared/hostFolders'
import { z } from 'zod'
import { externalLinkSchema } from '../shared/externalLinks'
import { questionPageOpenResultSchema, questionPageOpenSchema } from '../shared/questionPageOpen'
import { systemSettingsPaneSchema } from '../shared/systemSettings'
import { MEMORY_GET, MEMORY_COMMAND, MEMORY_CHANGED, memorySnapshotSchema, memoryCommandSchema, type MemoryBridge } from '../shared/memory'
import { agentActivitySchema } from '../shared/agentActivity'
import { AGENT_THREAD_PROMPTS, agentThreadPromptsRequestSchema, agentThreadPromptsSchema } from '../shared/threadPrompts'
import { AGENT_ATTACHMENT_CONTENT, AGENT_ATTACHMENT_PREVIEW, AGENT_ATTACHMENT_STAGE, agentAttachmentContentRequestSchema, agentAttachmentContentResultSchema, agentAttachmentHandleSchema, agentAttachmentStageRequestSchema, agentAttachmentPreviewRequestSchema, agentAttachmentPreviewResultSchema, AGENT_GET, AGENT_COMMAND, AGENT_STATE, AGENT_E2E, AGENT_THREAD_DETAIL, AGENT_THREAD_DETAIL_GET, AGENT_START_HANDOVER, AGENT_ACTIVITY_BODY, agentActivityBodyRequestSchema, agentStartHandoverSchema, agentThreadDetailRequestSchema, agentThreadDetailResultSchema, agentStateSchema, agentCommandSchema, agentCommandReceiptSchema, agentCommandChangedThreadRecordsReceiptSchema } from '../shared/agents'

import {
  APP_HIDE,
  APP_MINIMIZE,
  APP_RELOAD,
  APP_TOGGLE_MAXIMIZE,
  APP_MAXIMIZED,
  APP_WINDOW_HIDDEN,
  APP_WINDOW_VISIBLE,
  APP_QUIT,
  APP_SHOW,
  EXTERNAL_LINK_OPEN,
  QUESTION_PAGE_OPEN,
  SYSTEM_SETTINGS_OPEN,
  DICTATION_COMMAND,
  DICTATION_REQUEST,
  DICTATION_RECORD_GET,
  DICTATION_RECORDS_LIST,
  HISTORY_ADD,
  HISTORY_CLEAR,
  HISTORY_DELETE,
  HISTORY_LIST,
  HISTORY_SEARCH,
  HOTKEY_GET,
  HOTKEY_REPLACE,
  DICTATION_SHORTCUTS_REPLACE,
  DICTATION_SHORTCUTS_SUSPEND,
  DICTATION_KEYS_RECORD,
  DICTATION_KEYS_RECORD_CANCEL,
  DICTATION_KEYS_HELD,
  DICTATION_KEYS_TAKEN,
  KEY_LISTENER_PERMISSION_GET,
  KEY_LISTENER_PERMISSION_REQUEST,
  KEY_LISTENER_PERMISSION_CHANGED,
  OUTPUT_COPY_IMAGE,
  OUTPUT_DELIVER,
  RECOVERY_NOTICE,
  RECOVERY_NOTICE_LIST,
  TRANSCRIPTION_CANCEL,
  OPENROUTER_CHECK_KEY,
  OPENROUTER_LIST_MODELS,
  OPENROUTER_LIST_SPEECH_MODELS,
  SPEECH_MODEL_CHOOSE,
  SPEECH_MODEL_DOWNLOAD,
  SPEECH_MODEL_GET_STATUS,
  SPEECH_MODEL_LIST,
  SPEECH_MODEL_STATUS,
  TRANSCRIPTION_TRANSCRIBE,
  MICROPHONE_ENSURE_ACCESS,
  SETTINGS_GET,
  SETTINGS_CHANGED,
  SETTINGS_RESET,
  SETTINGS_UPDATE,
  STARTUP_GET,
  TRANSCRIPT_POLISH,
  STARTUP_SET,
  UPDATE_CHECK,
  UPDATE_DOWNLOAD,
  UPDATE_GET_STATUS,
  UPDATE_CHECK_REQUESTED,
  SETTINGS_OPEN_REQUESTED,
  UPDATE_INSTALL,
  UPDATE_STATUS,
  WIDGET_DRAG,
  WIDGET_PRESENTATION,
  WIDGET_PUBLISH,
  WIDGET_STATE,
  WIDGET_VISIBILITY,
} from '../shared/channels'
import {
  dictationCommandSchema,
  openRouterKeyCheckSchema,
  openRouterModelListSchema,
  cloudSpeechModelListSchema,
  transcriptionResultSchema,
  widgetDragSchema,
  widgetPresentationPayloadSchema,
  transcriptPolishResultSchema,
  updateStatusSchema,
  widgetSnapshotSchema,
  widgetVisibilitySchema,
  type SottoBridge,
  type SottoWidgetBridge,
  type WidgetDragPayload,
  type WidgetPresentationPayload,
} from '../shared/contracts'
import { historyEntrySchema } from '../shared/history'
import { dictationRecordSchema, dictationRecordsSchema } from '../shared/dictationRecord'
import {
  PLATFORM_ARGUMENT_PREFIX,
  resolvePlatform,
  type SottoPlatform,
} from '../shared/platform'
import { settingsSchema } from '../shared/settings'
import { recoveryNoticeSchema, recoveryNoticesSchema } from '../shared/recoveryNotice'
import {
  E2E_BROWSER_AGENT_CHANNEL, e2eBrowserAgentSchema, e2eBrowserAgentResultSchema, E2E_HOST_SETUP_TOOL_CHANNEL, e2eHostSetupToolSchema, E2E_VISUAL_TOOL_CHANNEL, e2eVisualToolSchema, E2E_DELEGATION_TOOL_CHANNEL, e2eDelegationToolSchema,
  E2E_SNAPSHOT_CHANNEL,
  E2E_TRIGGER_SHORTCUT_CHANNEL,
  e2eScenarioSchema,
  e2eSnapshotSchema,
  type SottoE2EBridge,
} from '../shared/e2e'

type RendererListener = (event: unknown, ...args: unknown[]) => void

export interface IpcRendererAdapter {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  on(channel: string, listener: RendererListener): unknown
  removeListener(channel: string, listener: RendererListener): unknown
}

export interface ContextBridgeAdapter {
  exposeInMainWorld(name: string, value: unknown): void
}

const historyEntriesSchema = z.array(historyEntrySchema)
const settingsChangedSchema = settingsSchema.strict()
const hotkeyResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }).strict(),
  z
    .object({
      ok: z.literal(false),
      reason: z.enum(['conflict', 'invalid', 'unavailable']),
      message: z.string().max(8000).optional(),
    })
    .strict(),
])
const unavailableSchema = z.object({ ok: z.literal(false), reason: z.literal('unavailable') }).strict()
const dictationShortcutsChangeSchema = z.object({ press: z.array(z.string().min(1).max(64)).min(1).max(4), hold: z.array(z.string().min(1).max(64)).max(4) }).strict()
const dictationShortcutsResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }).strict(),
  z.object({ ok: z.literal(false), reason: z.enum(['conflict', 'invalid', 'unavailable']), chord: z.string().max(64).optional(), message: z.string().max(8000).optional() }).strict(),
])
const keyRecordResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('recorded'), chord: z.string().min(1).max(64) }).strict(),
  z.object({ kind: z.literal('cancelled') }).strict(),
  z.object({ kind: z.literal('unsupported-key') }).strict(),
  z.object({ kind: z.literal('unavailable') }).strict(),
])
const keyListenerPermissionSchema = z.enum(['granted', 'denied', 'not-needed', 'unsupported'])
const heldKeysSchema = z.array(z.string().min(1).max(16)).max(8)
const commandResultSchema = z.union([z.object({ ok: z.literal(true) }).strict(), unavailableSchema])
const updateResponseSchema = z.union([updateStatusSchema, unavailableSchema])
const outputResultSchema = z.union([z.enum(['pasted', 'copied', 'clipboard-unavailable', 'empty']), unavailableSchema])
const startupStateSchema = z.object({ enabled: z.boolean(), supported: z.boolean().optional(), approvalRequired: z.boolean().optional() }).strict()
const voidSchema = z.undefined()
const booleanSchema = z.boolean()
const nullSchema = z.null()
const projectDirectorySchema = z.string().min(1).max(4_096).nullable()
const mainCheckoutProjectIdSchema = z.string().min(1).max(256)
const hotkeyChordSchema = z.string().nullable()
const dictationKeyRoleSchema = z.enum(['press', 'hold'])
const startHandoverResultSchema = agentStartHandoverSchema.nullable()
const activityBodyResultSchema = agentActivitySchema.nullable()
const threadPromptsResultSchema = agentThreadPromptsSchema.nullable()
const usageClearResultsSchema = usageClearResultSchema.array().max(USAGE_HOSTS_MAX)
const cursorSignInReadSchema = cursorSignInViewSchema.nullable()
const fileListingResultSchema = filesResultSchema(fileListingSchema)
const filePreviewResultSchema = filesResultSchema(filePreviewSchema)
const filePathResultSchema = filesResultSchema(filePathSchema)
const fileLinkResultSchema = filesResultSchema(fileLinkSchema)
const requestDraftsSchema = requestDraftSchema.array()
const requestDraftResultSchema = requestDraftSchema.nullable()
const dictationRecordResultSchema = dictationRecordSchema.nullable()

async function invokeParsed<Output>(
  renderer: IpcRendererAdapter,
  channel: string,
  schema: z.ZodType<Output>,
  ...args: unknown[]
): Promise<Output> {
  return schema.parse(await renderer.invoke(channel, ...args))
}

/**
 * What a subscription checks a payload with. A schema satisfies it, and so does the structural
 * guard the state channels use.
 */
interface PayloadCheck<Output> {
  safeParse: (value: unknown) => { success: true; data: Output } | { success: false }
}

/**
 * The state channels carry Sotto's own state, sent by Sotto's own main process over a private
 * channel on this machine, and they are by far the largest and most frequent payloads on the
 * bridge: revalidating every thread's history costs more than the whole rest of the trip from main
 * to the window, many times a second while an agent works. A structural check is what this side
 * needs — it is the shape of the payload, not its trustworthiness, that could still surprise us.
 * Every other channel keeps its schema.
 */
function trustedState<Output>(key: string): PayloadCheck<Output> {
  return {
    safeParse: value => typeof value === 'object' && value !== null && key in value
      ? { success: true, data: value as Output }
      : { success: false },
  }
}

function subscribe<Output>(
  renderer: IpcRendererAdapter,
  channel: string,
  schema: PayloadCheck<Output>,
  listener: (payload: Output) => void,
): () => void {
  const wrapped: RendererListener = (_event, ...args) => {
    if (args.length !== 1) {
      return
    }
    const result = schema.safeParse(args[0])
    if (result.success) {
      listener(result.data)
    }
  }
  renderer.on(channel, wrapped)

  let subscribed = true
  return () => {
    if (!subscribed) {
      return
    }
    subscribed = false
    renderer.removeListener(channel, wrapped)
  }
}

function createBufferedSubscription<Output>(
  renderer: IpcRendererAdapter,
  channel: string,
  schema: z.ZodType<Output>,
  capacity: number,
): (listener: (payload: Output) => void) => () => void {
  const buffered: Output[] = []
  const listeners = new Set<(payload: Output) => void>()
  renderer.on(channel, (_event, ...args) => {
    if (args.length !== 1) return
    const result = schema.safeParse(args[0])
    if (!result.success) return
    if (listeners.size > 0) {
      for (const listener of [...listeners]) {
        if (listeners.has(listener)) listener(result.data)
      }
    } else {
      buffered.push(result.data)
      if (buffered.length > capacity) buffered.splice(0, buffered.length - capacity)
    }
  })
  return (nextListener) => {
    // Each registration owns its unsubscribe, even when callers use the same callback.
    const listener = (payload: Output): void => {
      try { nextListener(payload) }
      catch { /* A subscriber cannot stop delivery to others. Never log state or exception bodies. */ }
    }
    listeners.add(listener)
    const replay = buffered.splice(0)
    for (const payload of replay) {
      if (!listeners.has(listener)) break
      listener(payload)
    }
    let subscribed = true
    return () => {
      if (!subscribed) return
      subscribed = false
      listeners.delete(listener)
    }
  }
}

function validatedRoutedCommand(command: import('../shared/agents').AgentCommand): import('../shared/agents').AgentCommand {
  agentCommandSchema.parse(mapHostReferences(command, id => parseHostEntityKey(id)?.id ?? id))
  return command
}

function createAgentBridge(renderer: IpcRendererAdapter): import('../shared/agents').AgentWireBridge {
  return Object.freeze({
    get: () => invokeParsed(renderer, AGENT_GET, agentStateSchema),
    attachmentPreview: (request: import('../shared/agents').AgentAttachmentPreviewRequest) =>
      invokeParsed(renderer, AGENT_ATTACHMENT_PREVIEW, agentAttachmentPreviewResultSchema, agentAttachmentPreviewRequestSchema.parse(request)),
    // The composer stages a screenshot once and carries its handle; a chip reads its image back (ADR-0031).
    stageAttachment: (request: import('../shared/agents').AgentAttachmentStageRequest) =>
      invokeParsed(renderer, AGENT_ATTACHMENT_STAGE, agentAttachmentHandleSchema, agentAttachmentStageRequestSchema.parse(request)),
    attachmentContent: (request: import('../shared/agents').AgentAttachmentContentRequest) =>
      invokeParsed(renderer, AGENT_ATTACHMENT_CONTENT, agentAttachmentContentResultSchema, agentAttachmentContentRequestSchema.parse(request)),
    chooseProjectDirectory: () => invokeParsed(renderer, AGENT_CHOOSE_PROJECT_DIRECTORY, projectDirectorySchema),
    workingCopyOptions: (projectId: string) => invokeParsed(renderer, AGENT_WORKING_COPY_OPTIONS, agentWorkingCopyOptionsSchema, agentWorkingCopyOptionsRequestSchema.parse(projectId)),
    gitRefs: (request: import('../shared/gitRefs').GitRefsRequest) => invokeParsed(renderer, AGENT_GIT_REFS, gitRefsPageSchema, gitRefsRequestSchema.parse(request)),
    gitChangedFiles: (request: import('../shared/gitChangedFiles').GitChangedFilesRequest) => invokeParsed(renderer, AGENT_GIT_CHANGED_FILES, gitChangedFilesSchema, gitChangedFilesRequestSchema.parse(request)),
    gitPullRequest: (request: import('../shared/gitPullRequests').GitPullRequestRequest) => invokeParsed(renderer, AGENT_GIT_PULL_REQUEST, gitPullRequestResultSchema, gitPullRequestRequestSchema.parse(request)),
    hostFolders: (request: import('../shared/hostFolders').HostFoldersClientRequest) => invokeParsed(renderer, AGENT_HOST_FOLDERS, hostFoldersResultSchema, hostFoldersClientRequestSchema.parse(request)),
    threadDetail: (threadId: string) => invokeParsed(renderer, AGENT_THREAD_DETAIL_GET, agentThreadDetailResultSchema, agentThreadDetailRequestSchema.parse(threadId)),
    startHandover: (threadId: string) => invokeParsed(renderer, AGENT_START_HANDOVER, startHandoverResultSchema, agentThreadDetailRequestSchema.parse(threadId)),
    // One record of a remote thread whole, for a row whose body its host sent cut (ADR-0025, October 18 amendment).
    activityBody: (request: import('../shared/agents').AgentActivityBodyRequest) => invokeParsed(renderer, AGENT_ACTIVITY_BODY, activityBodyResultSchema, agentActivityBodyRequestSchema.parse(request)),
    // The prompts above a pane's window, for the message scrubber (ADR-0109).
    threadPrompts: (request: import('../shared/threadPrompts').AgentThreadPromptsRequest) => invokeParsed(renderer, AGENT_THREAD_PROMPTS, threadPromptsResultSchema, agentThreadPromptsRequestSchema.parse(request)),
    // Whole details and the deltas between them share this channel, so the shape they share is the guard.
    onThreadDetail: (listener: (update: import('../shared/agents').AgentThreadDetailUpdate) => void) => subscribe(renderer, AGENT_THREAD_DETAIL,
      trustedState<import('../shared/agents').AgentThreadDetailUpdate>('threadId'), listener),
    // A command's answer is a receipt (issue #323): its catalogs are named by catalog revision, and the page
    // puts them back from what the broadcast sent it, the same way it does for an omitted broadcast catalog.
    // See src/renderer/src/agents/agentStateCatalogs.ts.
    command: (command: import('../shared/agents').AgentCommand) => invokeParsed(renderer, AGENT_COMMAND, agentCommandReceiptSchema, validatedRoutedCommand(command)),
    commandWithChangedThreadRecords: (command: import('../shared/agents').AgentCommand) => invokeParsed(renderer, AGENT_COMMAND, agentCommandChangedThreadRecordsReceiptSchema, validatedRoutedCommand(command), { changedThreadRecords: true }),
    // The broadcast may omit a model catalog this window already has (issue #286), and carries only the
    // thread records that changed since this window's last broadcast (issue #1330), coded as
    // AgentStateBroadcast rather than AgentState. This crosses to the page unreassembled on purpose:
    // contextBridge copies whatever a listener is called with back across the isolated-world boundary,
    // so putting the catalog back here would clone it again on the way out, defeating most of what
    // omitting it saved. The page puts both back; see src/renderer/src/agents/agentStateCatalogs.ts.
    onState: (listener: (state: import('../shared/agents').AgentStateBroadcast) => void) => subscribe(renderer, AGENT_STATE,
      trustedState<Record<string, unknown>>('host'), raw => listener(raw as import('../shared/agents').AgentStateBroadcast)),
  })
}

export function createSottoBridge(
  renderer: IpcRendererAdapter,
  platform: SottoPlatform,
  watcherEnabled = false,
  usageEnabled = false,
  delegationEnabled = false,
  continueEnabled = false,
  opencodeEnabled = false,
  /** A host's OpenCode signed in from Settings > Hosts & phones (#1107): on whenever OpenCode is not held, local host or not. */
  opencodeHostsEnabled = false,
  /** Main's watch on itself and Record a minute (ADR-0098): only while the `main-freeze` Owl feature is on. */
  mainActivityEnabled = false,
  /** Notifications when a thread has finished or needs the user (ADR-0117): only while the Owl feature is on, on a Mac that can show them. */
  desktopNotificationsEnabled = false,
  /** The machines line and Settings' Where new workers start (#1032): only while Watcher and Work across machines are on. */
  watcherMachinesEnabled = false,
  /** Cursor's sign-in from its tile (ADR-0128): only while Cursor's Owl feature is on. */
  cursorEnabled = false,
  /** The interface language as the window was made (ADR-0123): only while the `interface-language` Owl feature is on. */
  interfaceLanguage: InterfaceLanguageState | null = null,
  /** The user's own model servers (ADR-0124): only while the `own-model-servers` Owl feature is on and OpenCode runs here. */
  ownServersEnabled = false,
  /** Next prompts after a finished turn (ADR-0132): only while the `next-prompt` Owl feature is on and this computer runs threads. */
  nextPromptEnabled = false,
  /** AI cleanup on the user's own model servers (ADR-0136): only while its Owl feature runs, with the two it builds on. */
  ownServerCleanupEnabled = false,
  /** Keep main up to date (ADR-0142): only while the `keep-main-current` Owl feature is on and the local host runs. */
  mainCheckoutEnabled = false,
  /** The see-through window as main made it (ADR-0150): only while the `glass-theme` Owl feature is on. */
  glassWindow: GlassWindowState | null = null,
): SottoBridge {
  const onDictationCommand = createBufferedSubscription(
    renderer,
    DICTATION_COMMAND,
    dictationCommandSchema,
    16,
  )
  const onSettingsChanged = createBufferedSubscription(
    renderer,
    SETTINGS_CHANGED,
    settingsChangedSchema,
    1,
  )
  const onRecoveryNotice = createBufferedSubscription(
    renderer,
    RECOVERY_NOTICE,
    recoveryNoticeSchema,
    2,
  )
  const onSpeechModelStatus = createBufferedSubscription(
    renderer,
    SPEECH_MODEL_STATUS,
    speechModelStatusSchema,
    1,
  )
  const onUpdateStatus = createBufferedSubscription(
    renderer,
    UPDATE_STATUS,
    updateStatusSchema,
    1,
  )
  // Main says so once the page has loaded, before the renderer may be listening, so the last answer is kept for it.
  const onWindowVisible = createBufferedSubscription(
    renderer,
    APP_WINDOW_VISIBLE,
    booleanSchema,
    1,
  )
  const bridge: SottoBridge = {
    ...(usageEnabled ? { usage: Object.freeze<UsageBridge>({
      read: query => invokeParsed(renderer, USAGE_READ, usageDashboardReadSchema, usageQuerySchema.parse(query)),
      refresh: query => invokeParsed(renderer, USAGE_REFRESH, usageDashboardReadSchema, usageRefreshQuerySchema.parse(query)),
      clear: query => invokeParsed(renderer, USAGE_CLEAR, usageClearResultsSchema, usageClearQuerySchema.parse(query)),
    }) } : {}),
    // Every machine's check queue (#1312): only where the machines line is, so stable's window has no such bridge.
    ...(watcherMachinesEnabled ? { checks: Object.freeze<CheckQueuesBridge>({
      read: () => invokeParsed(renderer, CHECK_QUEUES_READ, checkQueuesViewSchema),
      onChanged: listener => subscribe(renderer, CHECK_QUEUES_CHANGED, checkQueuesViewSchema, listener),
    }) } : {}),
    // Moving threads to another machine (#1178): only where the machines line is, so stable's window has no such bridge.
    // Main registers it only where it built the service; a call without one is refused there.
    ...(watcherMachinesEnabled ? { threadMoves: Object.freeze<ThreadMovesBridge>({
      prepare: request => invokeParsed(renderer, THREAD_MOVE_PREPARE, threadMovePrepareSchema, threadMovePrepareRequestSchema.parse(request)),
      start: request => invokeParsed(renderer, THREAD_MOVE_START, threadMoveStartSchema, threadMoveStartRequestSchema.parse(request)),
      read: () => invokeParsed(renderer, THREAD_MOVES_READ, threadMovesViewSchema),
      answer: request => invokeParsed(renderer, THREAD_MOVE_ANSWER, threadMoveAnswerSchema, threadMoveAnswerRequestSchema.parse(request)),
      onChanged: listener => subscribe(renderer, THREAD_MOVES_CHANGED, threadMovesViewSchema, listener),
    }) } : {}),
    // Delegation between threads (ADR-0081): only while the Owl list turns it on, so stable's window has no such bridge.
    ...(delegationEnabled ? { delegations: Object.freeze<DelegationsBridge>({
      read: request => invokeParsed(renderer, DELEGATIONS_READ, delegationsReadSchema, delegationsRequestSchema.parse(request)),
      brief: request => invokeParsed(renderer, DELEGATION_BRIEF_READ, delegationBriefSchema, delegationBriefRequestSchema.parse(request)),
      // A check's reply on a press (#1312): only where checks are offered, with Watcher and Work across machines on.
      ...(watcherMachinesEnabled ? { checkReply: request => invokeParsed(renderer, DELEGATION_CHECK_REPLY_READ, delegationCheckReplySchema, delegationCheckReplyRequestSchema.parse(request)) } : {}),
      onChanged: listener => subscribe(renderer, DELEGATIONS_CHANGED, delegationsChangedSchema, listener),
    }) } : {}),
    // Signing Sotto's OpenCode in to model sources (#1104): only while OpenCode's Owl feature is on. A key goes to main
    // once and nothing returned carries one.
    ...(opencodeEnabled ? { opencode: Object.freeze<OpenCodeSignInBridge>({
      sources: () => invokeParsed(renderer, OPENCODE_SOURCES_READ, modelSourcesSchema),
      signInWithKey: request => invokeParsed(renderer, OPENCODE_SIGN_IN_KEY, signInResultSchema, signInKeyRequestSchema.parse(request)),
      startBrowserSignIn: request => invokeParsed(renderer, OPENCODE_SIGN_IN_BROWSER, signInStartSchema, signInMethodRequestSchema.parse(request)),
      useExternalSignIn: request => invokeParsed(renderer, OPENCODE_SIGN_IN_EXTERNAL, signInResultSchema, signInMethodRequestSchema.parse(request)),
      wait: request => invokeParsed(renderer, OPENCODE_SIGN_IN_WAIT, signInWaitSchema, signInAttemptRequestSchema.parse(request)),
      finish: request => invokeParsed(renderer, OPENCODE_SIGN_IN_FINISH, signInWaitSchema, signInFinishRequestSchema.parse(request)),
      reopen: request => invokeParsed(renderer, OPENCODE_SIGN_IN_REOPEN, signInDoneSchema, signInAttemptRequestSchema.parse(request)),
      cancel: request => invokeParsed(renderer, OPENCODE_SIGN_IN_CANCEL, signInDoneSchema, signInAttemptRequestSchema.parse(request)),
      signOut: request => invokeParsed(renderer, OPENCODE_SIGN_OUT, signInResultSchema, signOutRequestSchema.parse(request)),
    }) } : {}),
    // Cursor's sign-in from its tile (ADR-0128): only while Cursor's Owl feature is on. The page's address stays in main.
    ...(cursorEnabled ? { cursor: Object.freeze<CursorSignInBridge>({
      start: () => invokeParsed(renderer, CURSOR_SIGN_IN_START, cursorSignInStartSchema),
      read: request => invokeParsed(renderer, CURSOR_SIGN_IN_READ, cursorSignInReadSchema, cursorSignInRequestSchema.parse(request)),
      reopen: request => invokeParsed(renderer, CURSOR_SIGN_IN_REOPEN, cursorSignInDoneSchema, cursorSignInRequestSchema.parse(request)),
      cancel: request => invokeParsed(renderer, CURSOR_SIGN_IN_CANCEL, cursorSignInDoneSchema, cursorSignInRequestSchema.parse(request)),
      signOut: () => invokeParsed(renderer, CURSOR_SIGN_OUT, cursorSignInDoneSchema),
    }) } : {}),
    // The user's own model servers (ADR-0124): only while their Owl feature is on. A key goes to main once and nothing
    // returned carries one.
    ...(ownServersEnabled ? { ownServers: Object.freeze<OwnServersBridge>({
      list: () => invokeParsed(renderer, OWN_SERVERS_LIST, ownServerListSchema),
      check: request => invokeParsed(renderer, OWN_SERVERS_CHECK, checkResultSchema, checkRequestSchema.parse(request)),
      add: request => invokeParsed(renderer, OWN_SERVERS_ADD, addResultSchema, addRequestSchema.parse(request)),
      checkSaved: request => invokeParsed(renderer, OWN_SERVERS_CHECK_SAVED, checkResultSchema, checkSavedRequestSchema.parse(request)),
      remove: request => invokeParsed(renderer, OWN_SERVERS_REMOVE, removeResultSchema, removeRequestSchema.parse(request)),
    }) } : {}),
    ...(ownServerCleanupEnabled ? { ownServerCleanup: Object.freeze<OwnServerCleanupBridge>({
      measure: choice => invokeParsed(renderer, OWN_SERVER_CLEANUP_MEASURE, ownCleanupMeasureResultSchema, ownCleanupChoiceSchema.parse(choice)),
      measured: () => invokeParsed(renderer, OWN_SERVER_CLEANUP_MEASURED, ownCleanupMeasuredListSchema),
    }) } : {}),
    ...(mainActivityEnabled ? { mainActivity: Object.freeze<MainActivityBridge>({
      read: () => invokeParsed(renderer, MAIN_ACTIVITY_READ, mainActivityStateSchema),
      command: command => invokeParsed(renderer, MAIN_ACTIVITY_COMMAND, mainActivityStateSchema, mainActivityCommandSchema.parse(command)),
      onChanged: listener => subscribe(renderer, MAIN_ACTIVITY_CHANGED, mainActivityStateSchema, listener),
    }) } : {}),
    ...(glassWindow !== null ? { glassWindow: Object.freeze<GlassWindowBridge>({
      material: glassWindow.material,
      seeThrough: glassWindow.seeThrough,
      setSeeThrough: on => invokeParsed(renderer, GLASS_WINDOW_SET, glassWindowResultSchema, glassWindowRequestSchema.parse(on)),
      onChanged: listener => subscribe(renderer, GLASS_WINDOW_CHANGED, glassWindowResultSchema, listener),
    }) } : {}),
    ...(mainCheckoutEnabled ? { mainCheckout: Object.freeze<MainCheckoutBridge>({
      read: () => invokeParsed(renderer, MAIN_CHECKOUT_READ, mainCheckoutStateSchema),
      changes: projectId => invokeParsed(renderer, MAIN_CHECKOUT_CHANGES, mainCheckoutChangesSchema, mainCheckoutProjectIdSchema.parse(projectId)),
      command: command => invokeParsed(renderer, MAIN_CHECKOUT_COMMAND, mainCheckoutStateSchema, mainCheckoutCommandSchema.parse(command)),
      onChanged: listener => subscribe(renderer, MAIN_CHECKOUT_CHANGED, mainCheckoutStateSchema, listener),
    }) } : {}),
    // Notifications (ADR-0117): only while the Owl list turns them on and this Mac can show them, so no other window has this bridge.
    ...(interfaceLanguage ? { interfaceLanguage: createInterfaceLanguageBridge(renderer, interfaceLanguage) } : {}),
    ...(desktopNotificationsEnabled ? { notifications: Object.freeze<NotificationsBridge>({
      test: () => invokeParsed(renderer, NOTIFICATION_TEST, notificationTestResultSchema),
      onOpened: listener => subscribe(renderer, NOTIFICATION_OPENED, notificationOpeningSchema, listener),
    }) } : {}),
    ...(nextPromptEnabled ? { nextPrompt: Object.freeze<NextPromptBridge>({
      read: () => invokeParsed(renderer, NEXT_PROMPT_READ, nextPromptEntriesSchema),
      onChanged: listener => subscribe(renderer, NEXT_PROMPT_CHANGED, nextPromptEntrySchema, listener),
    }) } : {}),
    // Continue a thread on another provider (ADR-0089): only while the Owl list turns it on, so stable's window has no such bridge.
    ...(continueEnabled ? { continueThread: Object.freeze<ContinueBridge>({
      read: request => invokeParsed(renderer, CONTINUE_READ, continueReadSchema, continueReadRequestSchema.parse(request)),
      start: request => invokeParsed(renderer, CONTINUE_START, continueStartSchema, continueStartRequestSchema.parse(request)),
    }) } : {}),
    ...(watcherEnabled ? { watcher: Object.freeze<WatcherBridge>({
      onChanged: watcherRoomForwarding(renderer),
      get: () => invokeParsed(renderer, WATCHER_GET, watcherRoomResultSchema),
      open: request => invokeParsed(renderer, WATCHER_OPEN, watcherRoomResultSchema, watcherOpenRequestSchema.parse(request)),
      prepareStopAll: () => invokeParsed(renderer, WATCHER_PREPARE_STOP_ALL, watcherPrepareStopAllResultSchema),
      stopAll: request => invokeParsed(renderer, WATCHER_STOP_ALL, watcherStopAllResultSchema, watcherStopAllRequestSchema.parse(request)),
      setPermission: request => invokeParsed(renderer, WATCHER_SET_PERMISSION, watcherRoomResultSchema, watcherSetPermissionRequestSchema.parse(request)),
      watchThread: request => invokeParsed(renderer, WATCHER_WATCH_THREAD, watcherRoomResultSchema, watcherWatchThreadRequestSchema.parse(request)),
      unwatchThread: request => invokeParsed(renderer, WATCHER_UNWATCH_THREAD, watcherRoomResultSchema, watcherWatchThreadRequestSchema.parse(request)),
      readHandover: () => invokeParsed(renderer, WATCHER_READ_HANDOVER, watcherHandoverReadSchema),
      continueWithHandover: request => invokeParsed(renderer, WATCHER_CONTINUE_HANDOVER, watcherRoomResultSchema, watcherContinueHandoverRequestSchema.parse(request)),
      dismissHandover: () => invokeParsed(renderer, WATCHER_DISMISS_HANDOVER, watcherRoomResultSchema),
      startNew: () => invokeParsed(renderer, WATCHER_START_NEW, watcherRoomResultSchema),
      ...(watcherMachinesEnabled ? { readMachines: () => invokeParsed(renderer, WATCHER_READ_MACHINES, watcherMachinesReadSchema) } : {}),
    }) } : {}),
    hosts: Object.freeze<import('../shared/hosts').HostsBridge>({ get: () => renderer.invoke(HOSTS_GET) as Promise<HostsState>, command: command => renderer.invoke(HOSTS_COMMAND, hostsCommandSchema.parse(command)) as Promise<HostsState>, onChanged: listener => subscribe(renderer, HOSTS_CHANGED, trustedState<HostsState>('hosts'), listener),
      devices: () => renderer.invoke(HOSTS_DEVICES) as Promise<HostDeviceList>, tailscale: () => renderer.invoke(HOSTS_TAILSCALE) as Promise<TailscaleSummary>,
      connectTailscale: () => renderer.invoke(HOSTS_TAILSCALE_CONNECT) as Promise<TailscaleConnectOutcome>, openTailscaleDownload: () => renderer.invoke(HOSTS_TAILSCALE_DOWNLOAD) as Promise<void>,
      providerAction: action => renderer.invoke(HOSTS_PROVIDER_ACTION, hostProviderActionSchema.parse(action)) as Promise<HostProviderActionResult>,
      updateClients: request => renderer.invoke(HOSTS_UPDATE_CLIENTS, hostClientUpdateRequestSchema.parse(request)) as Promise<HostProviderActionResult>,
      signIn: request => renderer.invoke(HOSTS_SIGN_IN, hostSignInRequestSchema.parse(request)) as Promise<ProviderSignInView | null>,
      // A host's OpenCode signed in to model sources from this computer (#1107): only while OpenCode's Owl feature is on.
      ...(opencodeHostsEnabled ? { opencodeSignIn: request => {
        const parsed = hostOpenCodeSignInRequestSchema.parse(request)
        return invokeParsed(renderer, HOSTS_OPENCODE_SIGN_IN, HOST_OPENCODE_ANSWERS[parsed.call.action] as z.ZodType<unknown>, parsed) as never
      } } : {}) }),
    phones: Object.freeze<import('../shared/phones').PhonesBridge>({ get: () => renderer.invoke(PHONES_GET) as Promise<PhonesState>, command: command => renderer.invoke(PHONES_COMMAND, phonesCommandSchema.parse(command)) as Promise<PhonesState>, onChanged: listener => subscribe(renderer, PHONES_CHANGED, trustedState<PhonesState>('phones'), listener) }),
    ...createToolsBridges(renderer),
    cloudIphone: createCloudIphoneBridge(renderer),
    themes: createThemesBridge(renderer),
    ...(platform === 'linux' ? { omarchySetup: Object.freeze<OmarchySetupBridge>({
      get: () => invokeParsed(renderer, OMARCHY_SETUP_GET, omarchySetupStateSchema),
      command: command => invokeParsed(renderer, OMARCHY_SETUP_COMMAND, omarchySetupStateSchema, omarchySetupCommandSchema.parse(command)),
      onFocus: listener => subscribe(renderer, OMARCHY_SETUP_FOCUS, nullSchema, listener),
      onChanged: listener => subscribe(renderer, OMARCHY_SETUP_CHANGED, omarchySetupStateSchema, listener),
    }) } : {}),
    subagents: Object.freeze<SubagentsBridge>({
      page: request => invokeParsed(renderer, SUBAGENTS_PAGE, subagentPageSchema, subagentPageRequestSchema.parse(request)),
      assignments: request => invokeParsed(renderer, SUBAGENTS_ASSIGNMENTS, subagentAssignmentsPageSchema, subagentAssignmentsRequestSchema.parse(request)),
      onChanged: listener => subscribe(renderer, SUBAGENTS_CHANGED, subagentChangeSchema, listener),
    }),
    // An interactive visual's sealed page (ADR-0060): the window names the visual, main reads the page from its store.
    visuals: Object.freeze<VisualPagesBridge>({
      open: request => invokeParsed(renderer, VISUAL_PAGE_OPEN, visualPageResultSchema, visualPageRequestSchema.parse(request)),
    }),
    files: Object.freeze<FilesBridge>({
      list: request => invokeParsed(renderer, FILES_LIST, fileListingResultSchema, fileListRequestSchema.parse(request)),
      preview: request => invokeParsed(renderer, FILES_PREVIEW, filePreviewResultSchema, fileRequestSchema.parse(request)),
      copyPath: request => invokeParsed(renderer, FILES_COPY_PATH, filePathResultSchema, fileRequestSchema.parse(request)),
      reveal: request => invokeParsed(renderer, FILES_REVEAL, filePathResultSchema, fileRequestSchema.parse(request)),
      revealLink: request => invokeParsed(renderer, FILES_REVEAL_LINK, fileLinkResultSchema, fileLinkRequestSchema.parse(request)),
    }),
    memory: Object.freeze<MemoryBridge>({
      get: () => invokeParsed(renderer, MEMORY_GET, memorySnapshotSchema),
      command: command => invokeParsed(renderer, MEMORY_COMMAND, memorySnapshotSchema, memoryCommandSchema.parse(command)),
      onChanged: listener => subscribe(renderer, MEMORY_CHANGED, memorySnapshotSchema, listener),
    }),
    agents: createAgentBridge(renderer),
    requestDrafts: Object.freeze<RequestDraftBridge>({
      onChanged: listener => subscribe(renderer, REQUEST_DRAFT_CHANGED, requestDraftOwnerSchema, listener),
      list: owner => invokeParsed(renderer, REQUEST_DRAFT_LIST, requestDraftsSchema, requestDraftOwnerSchema.parse(owner)),
      discard: input => invokeParsed(renderer, REQUEST_DRAFT_DISCARD, booleanSchema, requestDraftDiscardSchema.parse(input)),
      get: target => invokeParsed(renderer, REQUEST_DRAFT_GET, requestDraftResultSchema, requestDraftTargetSchema.parse(target)),
      status: target => invokeParsed(renderer, REQUEST_DRAFT_STATUS, requestDraftStatusSchema, requestDraftTargetSchema.parse(target)),
      save: draft => invokeParsed(renderer, REQUEST_DRAFT_SAVE, requestDraftSchema, requestDraftSchema.parse(draft)),
      check: target => invokeParsed(renderer, REQUEST_DRAFT_CHECK, requestDraftCheckResultSchema, requestDraftTargetSchema.parse(target)),
    }),
    platform,

    listRecoveryNotices: () =>
      invokeParsed(renderer, RECOVERY_NOTICE_LIST, recoveryNoticesSchema),
    onRecoveryNotice,

    getSettings: () => invokeParsed(renderer, SETTINGS_GET, settingsSchema),
    updateSettings: (patch) => invokeParsed(renderer, SETTINGS_UPDATE, settingsSchema, patch),
    resetSettings: () => invokeParsed(renderer, SETTINGS_RESET, settingsSchema),
    onSettingsChanged,

    listHistory: () => invokeParsed(renderer, HISTORY_LIST, historyEntriesSchema),
    addHistory: (entry) => invokeParsed(renderer, HISTORY_ADD, historyEntriesSchema, entry),
    searchHistory: (query) => invokeParsed(renderer, HISTORY_SEARCH, historyEntriesSchema, query),
    deleteHistory: (id) => invokeParsed(renderer, HISTORY_DELETE, booleanSchema, id),
    clearHistory: () => invokeParsed(renderer, HISTORY_CLEAR, voidSchema),
    listDictationRecords: () => invokeParsed(renderer, DICTATION_RECORDS_LIST, dictationRecordsSchema),
    getDictationRecord: (id) => invokeParsed(renderer, DICTATION_RECORD_GET, dictationRecordResultSchema, id),

    getHotkey: () => invokeParsed(renderer, HOTKEY_GET, hotkeyChordSchema),
    replaceHotkey: (accelerator) =>
      invokeParsed(renderer, HOTKEY_REPLACE, hotkeyResultSchema, accelerator),
    replaceDictationShortcuts: (change) =>
      invokeParsed(renderer, DICTATION_SHORTCUTS_REPLACE, dictationShortcutsResultSchema, dictationShortcutsChangeSchema.parse(change)),
    suspendDictationShortcuts: (suspended) => invokeParsed(renderer, DICTATION_SHORTCUTS_SUSPEND, commandResultSchema, booleanSchema.parse(suspended)),
    recordDictationKeys: () => invokeParsed(renderer, DICTATION_KEYS_RECORD, keyRecordResultSchema),
    cancelDictationKeyRecord: () => invokeParsed(renderer, DICTATION_KEYS_RECORD_CANCEL, commandResultSchema),
    onDictationKeysHeld: listener => subscribe(renderer, DICTATION_KEYS_HELD, heldKeysSchema, listener),
    // Linux only: Sotto's Hyprland bindings stand down while Settings records keys.
    ...(platform === 'linux' ? { onDictationKeysTaken: (listener: (role: 'press' | 'hold') => void) => subscribe(renderer, DICTATION_KEYS_TAKEN, dictationKeyRoleSchema, listener) } : {}),
    getKeyListenerPermission: () => invokeParsed(renderer, KEY_LISTENER_PERMISSION_GET, keyListenerPermissionSchema),
    requestKeyListenerPermission: () => invokeParsed(renderer, KEY_LISTENER_PERMISSION_REQUEST, keyListenerPermissionSchema),
    onKeyListenerPermission: listener => subscribe(renderer, KEY_LISTENER_PERMISSION_CHANGED, keyListenerPermissionSchema, listener),

    requestDictation: (command) =>
      invokeParsed(renderer, DICTATION_REQUEST, commandResultSchema, command),
    onDictationCommand,

    publishWidgetState: (state) =>
      invokeParsed(renderer, WIDGET_PUBLISH, commandResultSchema, state),
    deliverOutput: (request) =>
      invokeParsed(renderer, OUTPUT_DELIVER, outputResultSchema, request),
    copyImage: (request) =>
      invokeParsed(renderer, OUTPUT_COPY_IMAGE, commandResultSchema, request),

    polishTranscript: (request) =>
      invokeParsed(renderer, TRANSCRIPT_POLISH, transcriptPolishResultSchema, request),

    transcribe: (request) =>
      invokeParsed(renderer, TRANSCRIPTION_TRANSCRIBE, transcriptionResultSchema, request),
    cancelTranscription: (requestId) =>
      invokeParsed(renderer, TRANSCRIPTION_CANCEL, commandResultSchema, requestId),
    getSpeechModelStatus: () => invokeParsed(renderer, SPEECH_MODEL_GET_STATUS, speechModelStatusSchema),
    downloadSpeechModel: () => invokeParsed(renderer, SPEECH_MODEL_DOWNLOAD, commandResultSchema),
    listSpeechModels: () => invokeParsed(renderer, SPEECH_MODEL_LIST, speechModelListSchema),
    chooseSpeechModel: (id) => invokeParsed(renderer, SPEECH_MODEL_CHOOSE, commandResultSchema, id),
    onSpeechModelStatus,
    checkOpenRouterKey: () => invokeParsed(renderer, OPENROUTER_CHECK_KEY, openRouterKeyCheckSchema),
    listOpenRouterModels: () => invokeParsed(renderer, OPENROUTER_LIST_MODELS, openRouterModelListSchema),
    listCloudSpeechModels: () => invokeParsed(renderer, OPENROUTER_LIST_SPEECH_MODELS, cloudSpeechModelListSchema),
    ensureMicrophoneAccess: () => invokeParsed(renderer, MICROPHONE_ENSURE_ACCESS, booleanSchema),

    getUpdateStatus: () => invokeParsed(renderer, UPDATE_GET_STATUS, updateResponseSchema),
    checkForUpdates: () => invokeParsed(renderer, UPDATE_CHECK, updateResponseSchema),
    downloadUpdate: () => invokeParsed(renderer, UPDATE_DOWNLOAD, commandResultSchema),
    installUpdate: () => invokeParsed(renderer, UPDATE_INSTALL, commandResultSchema),
    onUpdateStatus,
    onUpdateCheckRequested: listener => subscribe(renderer, UPDATE_CHECK_REQUESTED, nullSchema, () => listener()),
    onSettingsRequested: listener => subscribe(renderer, SETTINGS_OPEN_REQUESTED, nullSchema, () => listener()),

    getStartup: () => invokeParsed(renderer, STARTUP_GET, startupStateSchema),
    setStartup: (enabled) => invokeParsed(renderer, STARTUP_SET, startupStateSchema, enabled),

    showApp: () => invokeParsed(renderer, APP_SHOW, voidSchema),
    openExternalLink: url => invokeParsed(renderer, EXTERNAL_LINK_OPEN, commandResultSchema, externalLinkSchema.parse(url)),
    openQuestionPage: input => invokeParsed(renderer, QUESTION_PAGE_OPEN, questionPageOpenResultSchema, questionPageOpenSchema.parse(input)),
    openSystemSettings: pane => invokeParsed(renderer, SYSTEM_SETTINGS_OPEN, commandResultSchema, systemSettingsPaneSchema.parse(pane)),
    hideApp: () => invokeParsed(renderer, APP_HIDE, voidSchema),
    reloadApp: () => invokeParsed(renderer, APP_RELOAD, voidSchema),
    minimizeApp: () => invokeParsed(renderer, APP_MINIMIZE, voidSchema),
    toggleMaximizeApp: () => invokeParsed(renderer, APP_TOGGLE_MAXIMIZE, voidSchema),
    getWindowMaximized: () => invokeParsed(renderer, APP_MAXIMIZED, booleanSchema),
    onWindowMaximized: listener => subscribe(renderer, APP_MAXIMIZED, booleanSchema, listener),
    onWindowHidden: listener => subscribe(renderer, APP_WINDOW_HIDDEN, nullSchema, () => listener()),
    onWindowVisible,
    quitApp: () => invokeParsed(renderer, APP_QUIT, voidSchema),
  }
  return hostClientBridge(bridge)
}

function createInterfaceLanguageBridge(renderer: IpcRendererAdapter, startup: InterfaceLanguageState): InterfaceLanguageBridge {
  return Object.freeze<InterfaceLanguageBridge>({
    startup: Object.freeze({ ...startup }),
    current: () => invokeParsed(renderer, INTERFACE_LANGUAGE_GET, interfaceLanguageStateSchema),
    onChanged: listener => subscribe(renderer, INTERFACE_LANGUAGE_CHANGED, interfaceLanguageStateSchema, listener),
  })
}

export function createSottoWidgetBridge(
  renderer: IpcRendererAdapter,
  platform: SottoPlatform,
  /** The interface language as the window was made (ADR-0123): only while the `interface-language` Owl feature is on. */
  interfaceLanguage: InterfaceLanguageState | null = null,
): SottoWidgetBridge {
  const onWidgetState = createBufferedSubscription(
    renderer,
    WIDGET_STATE,
    widgetSnapshotSchema,
    1,
  )
  const onWidgetVisibilityChange = createBufferedSubscription(
    renderer,
    WIDGET_VISIBILITY,
    widgetVisibilitySchema,
    1,
  )
  return Object.freeze({
    platform,
    ...(interfaceLanguage ? { interfaceLanguage: createInterfaceLanguageBridge(renderer, interfaceLanguage) } : {}),

    onWidgetState,
    onWidgetVisibilityChange,
    requestToggle: () =>
      invokeParsed(renderer, DICTATION_REQUEST, commandResultSchema, { type: 'toggle' }),
    requestStop: () =>
      invokeParsed(renderer, DICTATION_REQUEST, commandResultSchema, { type: 'stop' }),
    requestCancel: () =>
      invokeParsed(renderer, DICTATION_REQUEST, commandResultSchema, { type: 'cancel' }),
    requestRetry: () =>
      invokeParsed(renderer, DICTATION_REQUEST, commandResultSchema, { type: 'retry' }),
    requestDismiss: () =>
      invokeParsed(renderer, DICTATION_REQUEST, commandResultSchema, { type: 'dismiss' }),
    setPresentation: async (payload: WidgetPresentationPayload) =>
      invokeParsed(
        renderer,
        WIDGET_PRESENTATION,
        commandResultSchema,
        widgetPresentationPayloadSchema.parse(payload),
      ),
    reportDrag: async (payload: WidgetDragPayload) =>
      invokeParsed(
        renderer,
        WIDGET_DRAG,
        commandResultSchema,
        widgetDragSchema.parse(payload),
      ),
  })
}

const RENDERER_ROLE_PREFIX = '--sotto-renderer-role='

export function parseRendererRoleArgument(
  arguments_: readonly string[],
): 'main' | 'widget' | null {
  const matches = arguments_.filter((argument) => argument.startsWith(RENDERER_ROLE_PREFIX))
  if (matches.length !== 1) return null
  const role = matches[0]?.slice(RENDERER_ROLE_PREFIX.length)
  return role === 'main' || role === 'widget' ? role : null
}

export function parsePlatformArgument(
  arguments_: readonly string[],
): SottoPlatform {
  const matches = arguments_.filter((argument) =>
    argument.startsWith(PLATFORM_ARGUMENT_PREFIX),
  )
  if (matches.length !== 1) return 'win32'
  return resolvePlatform(matches[0]?.slice(PLATFORM_ARGUMENT_PREFIX.length) ?? '')
}

export function exposeRendererBridge(
  context: ContextBridgeAdapter,
  renderer: IpcRendererAdapter,
  arguments_: readonly string[],
): boolean {
  const rendererRole = parseRendererRoleArgument(arguments_)
  const platform = parsePlatformArgument(arguments_)
  if (rendererRole === 'main') {
    context.exposeInMainWorld('sotto', createSottoBridge(renderer, platform, arguments_.includes(WATCHER_RENDERER_ARGUMENT), arguments_.includes(USAGE_RENDERER_ARGUMENT),
      arguments_.includes(DELEGATION_RENDERER_ARGUMENT), arguments_.includes(CONTINUE_RENDERER_ARGUMENT), arguments_.includes(OPENCODE_RENDERER_ARGUMENT),
      arguments_.includes(OPENCODE_HOSTS_RENDERER_ARGUMENT), arguments_.includes(MAIN_ACTIVITY_RENDERER_ARGUMENT), arguments_.includes(DESKTOP_NOTIFICATIONS_RENDERER_ARGUMENT),
      arguments_.includes(WATCHER_MACHINES_RENDERER_ARGUMENT), arguments_.includes(CURSOR_RENDERER_ARGUMENT),
      parseInterfaceLanguageArgument(arguments_), arguments_.includes(OWN_SERVERS_RENDERER_ARGUMENT), arguments_.includes(NEXT_PROMPT_RENDERER_ARGUMENT),
      arguments_.includes(OWN_SERVER_CLEANUP_RENDERER_ARGUMENT), arguments_.includes(MAIN_CHECKOUT_RENDERER_ARGUMENT),
      parseGlassWindowArguments(arguments_)))
    return true
  }
  if (rendererRole === 'widget') {
    context.exposeInMainWorld(
      'sottoWidget',
      createSottoWidgetBridge(renderer, platform, parseInterfaceLanguageArgument(arguments_)),
    )
    return true
  }
  return false
}

export function exposeE2EBridge(
  context: ContextBridgeAdapter,
  renderer: IpcRendererAdapter,
  environment: NodeJS.ProcessEnv,
  arguments_: readonly string[],
): void {
  if (environment.SOTTO_E2E !== '1' || parseRendererRoleArgument(arguments_) !== 'main') return
  const scenario = e2eScenarioSchema.safeParse(environment.SOTTO_E2E_SCENARIO ?? 'success')
  if (!scenario.success) return
  const bridge: SottoE2EBridge = Object.freeze({
    browserAgent: (request: Parameters<NonNullable<SottoE2EBridge['browserAgent']>>[0]) => invokeParsed(renderer, E2E_BROWSER_AGENT_CHANNEL, e2eBrowserAgentResultSchema, e2eBrowserAgentSchema.parse(request)),
    hostSetupTool: (request: Parameters<NonNullable<SottoE2EBridge['hostSetupTool']>>[0]) => invokeParsed(renderer, E2E_HOST_SETUP_TOOL_CHANNEL, e2eBrowserAgentResultSchema, e2eHostSetupToolSchema.parse(request)),
    visualTool: (request: Parameters<NonNullable<SottoE2EBridge['visualTool']>>[0]) => invokeParsed(renderer, E2E_VISUAL_TOOL_CHANNEL, e2eBrowserAgentResultSchema, e2eVisualToolSchema.parse(request)),
    delegationTool: (request: Parameters<NonNullable<SottoE2EBridge['delegationTool']>>[0]) => invokeParsed(renderer, E2E_DELEGATION_TOOL_CHANNEL, e2eBrowserAgentResultSchema, e2eDelegationToolSchema.parse(request)),
    agentEvent: async (event: Parameters<NonNullable<SottoE2EBridge['agentEvent']>>[0]) => {
      const key = parseHostEntityKey(event.threadId)
      if (key === null) return invokeParsed(renderer, AGENT_E2E, voidSchema, event)
      const state = await invokeParsed(renderer, AGENT_GET, agentStateSchema)
      if (key.hostId !== (state.hostId ?? state.host.hostId)) throw new Error('This test event belongs to another host.')
      return invokeParsed(renderer, AGENT_E2E, voidSchema, { ...event, threadId: key.id })
    },
    scenario: scenario.data,
    ...(environment.SOTTO_E2E_STARTING_SCREEN === '1' ? { startingScreen: true } : {}),
    snapshot: () => invokeParsed(renderer, E2E_SNAPSHOT_CHANNEL, e2eSnapshotSchema),
    triggerShortcut: () => invokeParsed(renderer, E2E_TRIGGER_SHORTCUT_CHANNEL, voidSchema),
  })
  context.exposeInMainWorld('sottoE2E', bridge)
}

exposeRendererBridge(contextBridge, ipcRenderer, process.argv)
exposeE2EBridge(contextBridge, ipcRenderer, process.env, process.argv)
