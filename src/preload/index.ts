import { HOSTS_GET, HOSTS_COMMAND, HOSTS_CHANGED, HOSTS_SSH_SUGGESTIONS, hostsCommandSchema, type HostsState, type SshHostSuggestion } from '../shared/hosts'
import { mapHostReferences, parseHostEntityKey } from '../shared/clientIdentity'

import { hostClientBridge } from './hostClientBridge'
import { PERSONAL_CHAT_GET, PERSONAL_CHAT_COMMAND, PERSONAL_CHAT_SKILLS, PERSONAL_CHAT_STATE, personalChatStateSchema, personalChatCommandSchema, personalSkillsInputSchema, type PersonalChatBridge, type PersonalChatCommand } from '../shared/personalChats'
import { REQUEST_DRAFT_GET, REQUEST_DRAFT_SAVE, REQUEST_DRAFT_CHECK, REQUEST_DRAFT_LIST, REQUEST_DRAFT_DISCARD, requestDraftSchema, requestDraftTargetSchema, requestDraftOwnerSchema, requestDraftDiscardSchema, type RequestDraftBridge } from '../shared/requestDrafts'
import { agentSkillCatalogSchema } from '../shared/agentSkills'
import { CHAT_PROMPT_GENERATE, CHAT_PROMPT_COPY, chatPromptInputSchema, chatPromptCopySchema, chatPromptResultSchema, type ChatPromptBridge } from '../shared/chatPrompts'
import { contextBridge, ipcRenderer } from 'electron'
import { SUBAGENTS_PAGE, SUBAGENTS_ASSIGNMENTS, SUBAGENTS_CHANGED, subagentPageRequestSchema, subagentAssignmentsRequestSchema, subagentPageSchema, subagentAssignmentsPageSchema, subagentChangeSchema, type SubagentsBridge } from '../shared/subagents'
import { createToolsBridges } from './tools'
import { createTerminalWorkspaceBridge } from './terminals'
import { createThemesBridge } from './themes'
import { FILES_LIST, FILES_PREVIEW, FILES_COPY_PATH, FILES_REVEAL, fileListRequestSchema, fileRequestSchema, fileListingSchema, filePreviewSchema, filePathSchema, filesResultSchema, type FilesBridge } from '../shared/files'
import { AGENT_CHOOSE_PROJECT_DIRECTORY, AGENT_WORKING_COPY_OPTIONS, agentWorkingCopyOptionsSchema, agentWorkingCopyOptionsRequestSchema } from '../shared/agents'
import { AGENT_GIT_REFS, gitRefsPageSchema, gitRefsRequestSchema } from '../shared/gitRefs'
import { AGENT_GIT_CHANGED_FILES, gitChangedFilesRequestSchema, gitChangedFilesSchema } from '../shared/gitChangedFiles'
import { AGENT_GIT_PULL_REQUEST, gitPullRequestRequestSchema, gitPullRequestResultSchema } from '../shared/gitPullRequests'
import { z } from 'zod'
import { externalLinkSchema } from '../shared/externalLinks'
import { MEMORY_GET, MEMORY_COMMAND, MEMORY_CHANGED, memorySnapshotSchema, memoryCommandSchema, type MemoryBridge } from '../shared/memory'
import { AGENT_ATTACHMENT_PREVIEW, agentAttachmentPreviewRequestSchema, agentAttachmentPreviewResultSchema, AGENT_GET, AGENT_COMMAND, AGENT_STATE, AGENT_E2E, AGENT_SPEECH, AGENT_SPEECH_CANCEL, AGENT_GROK_VOICES, AGENT_VOICE_MODEL, AGENT_WAKE, AGENT_THREAD_DETAIL, AGENT_THREAD_DETAIL_GET, agentThreadDetailRequestSchema, agentThreadDetailResultSchema, agentSpeechVoicesSchema, agentVoiceModelStatusSchema, agentWakeDetectionSchema, agentSpeechSchema, agentStateSchema, agentCommandSchema } from '../shared/agents'

import {
  APP_HIDE,
  APP_MINIMIZE,
  APP_RELOAD,
  APP_TOGGLE_MAXIMIZE,
  APP_MAXIMIZED,
  APP_QUIT,
  APP_SHOW,
  EXTERNAL_LINK_OPEN,
  DICTATION_COMMAND,
  DICTATION_REQUEST,
  HISTORY_ADD,
  HISTORY_CLEAR,
  HISTORY_DELETE,
  HISTORY_LIST,
  HISTORY_SEARCH,
  HOTKEY_GET,
  HOTKEY_REPLACE,
  OUTPUT_DELIVER,
  RECOVERY_NOTICE,
  RECOVERY_NOTICE_LIST,
  TRANSCRIPTION_CANCEL,
  TRANSCRIPTION_CHECK_KEY,
  TRANSCRIPTION_TRANSCRIBE,
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
  transcriptionKeyCheckSchema,
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
import {
  PLATFORM_ARGUMENT_PREFIX,
  resolvePlatform,
  type SottoPlatform,
} from '../shared/platform'
import { settingsSchema } from '../shared/settings'
import { recoveryNoticeSchema, recoveryNoticesSchema } from '../shared/recoveryNotice'
import {
  E2E_BROWSER_AGENT_CHANNEL, e2eBrowserAgentSchema, e2eBrowserAgentResultSchema,
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
    })
    .strict(),
])
const unavailableSchema = z.object({ ok: z.literal(false), reason: z.literal('unavailable') }).strict()
const commandResultSchema = z.union([z.object({ ok: z.literal(true) }).strict(), unavailableSchema])
const updateResponseSchema = z.union([updateStatusSchema, unavailableSchema])
const outputResultSchema = z.union([z.enum(['pasted', 'copied', 'empty']), unavailableSchema])
const startupStateSchema = z.object({ enabled: z.boolean() }).strict()
const voidSchema = z.undefined()

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
  let listener: ((payload: Output) => void) | null = null
  renderer.on(channel, (_event, ...args) => {
    if (args.length !== 1) return
    const result = schema.safeParse(args[0])
    if (!result.success) return
    if (listener !== null) {
      listener(result.data)
    } else {
      buffered.push(result.data)
      if (buffered.length > capacity) buffered.splice(0, buffered.length - capacity)
    }
  })
  return (nextListener) => {
    listener = nextListener
    const replay = buffered.splice(0)
    for (const payload of replay) {
      if (listener !== nextListener) break
      nextListener(payload)
    }
    let subscribed = true
    return () => {
      if (!subscribed) return
      subscribed = false
      if (listener === nextListener) listener = null
      buffered.splice(0)
    }
  }
}

function createPersonalChatBridge(renderer: IpcRendererAdapter): PersonalChatBridge {
  const command = (input: PersonalChatCommand) => invokeParsed(renderer, PERSONAL_CHAT_COMMAND, personalChatStateSchema, personalChatCommandSchema.parse(input))
  return Object.freeze({
    get: () => invokeParsed(renderer, PERSONAL_CHAT_GET, personalChatStateSchema),
    create: () => command({ type: 'create' }),
    select: (chatId: string | null) => command({ type: 'select', chatId }),
    saveDraft: (input: Parameters<PersonalChatBridge['saveDraft']>[0]) => command({ ...input, type: 'draft' }),
    send: (input: Parameters<PersonalChatBridge['send']>[0]) => command({ ...input, type: 'send' }),
    skills: (chatId: string, forceReload?: boolean) => invokeParsed(renderer, PERSONAL_CHAT_SKILLS, agentSkillCatalogSchema, personalSkillsInputSchema.parse({ chatId, forceReload })),
    refresh: (chatId: string) => command({ type: 'refresh', chatId }),
    interrupt: (chatId: string) => command({ type: 'interrupt', chatId }),
    answer: (input: Parameters<PersonalChatBridge['answer']>[0]) => command({ ...input, type: 'answer' }),
    connect: () => command({ type: 'connect' }), disconnect: () => command({ type: 'disconnect' }),
    onState: (listener: Parameters<PersonalChatBridge['onState']>[0]) => subscribe(renderer, PERSONAL_CHAT_STATE,
      trustedState<import('../shared/personalChats').PersonalChatState>('chats'), listener),
  })
}

function validatedRoutedCommand(command: import('../shared/agents').AgentCommand): import('../shared/agents').AgentCommand {
  agentCommandSchema.parse(mapHostReferences(command, id => parseHostEntityKey(id)?.id ?? id))
  return command
}

function createAgentBridge(renderer: IpcRendererAdapter, role: 'main' | 'widget'): import('../shared/agents').AgentBridge {
  return Object.freeze({
    get: () => invokeParsed(renderer, AGENT_GET, agentStateSchema),
    attachmentPreview: (request: import('../shared/agents').AgentAttachmentPreviewRequest) =>
      invokeParsed(renderer, AGENT_ATTACHMENT_PREVIEW, agentAttachmentPreviewResultSchema, agentAttachmentPreviewRequestSchema.parse(request)),
    ...(role === 'main' ? {
    chooseProjectDirectory: () => invokeParsed(renderer, AGENT_CHOOSE_PROJECT_DIRECTORY, z.string().min(1).max(4_096).nullable()),
    workingCopyOptions: (projectId: string) => invokeParsed(renderer, AGENT_WORKING_COPY_OPTIONS, agentWorkingCopyOptionsSchema, agentWorkingCopyOptionsRequestSchema.parse(projectId)),
    gitRefs: (request: import('../shared/gitRefs').GitRefsRequest) => invokeParsed(renderer, AGENT_GIT_REFS, gitRefsPageSchema, gitRefsRequestSchema.parse(request)),
    gitChangedFiles: (request: import('../shared/gitChangedFiles').GitChangedFilesRequest) => invokeParsed(renderer, AGENT_GIT_CHANGED_FILES, gitChangedFilesSchema, gitChangedFilesRequestSchema.parse(request)),
    gitPullRequest: (request: import('../shared/gitPullRequests').GitPullRequestRequest) => invokeParsed(renderer, AGENT_GIT_PULL_REQUEST, gitPullRequestResultSchema, gitPullRequestRequestSchema.parse(request)),
    synthesizeSpeech: (text: string) => invokeParsed(renderer, AGENT_SPEECH, agentSpeechSchema, text),
    cancelSpeech: () => invokeParsed(renderer, AGENT_SPEECH_CANCEL, voidSchema),
    grokVoices: () => invokeParsed(renderer, AGENT_GROK_VOICES, agentSpeechVoicesSchema),
    voiceModel: (action: 'status' | 'download') => invokeParsed(renderer, AGENT_VOICE_MODEL, agentVoiceModelStatusSchema, action),
    prepareWake: () => invokeParsed(renderer, AGENT_WAKE, agentWakeDetectionSchema, { type: 'prepare' }),
    detectWake: (audio: Float32Array) => invokeParsed(renderer, AGENT_WAKE, agentWakeDetectionSchema, { type: 'detect', audio }),
    releaseWake: () => invokeParsed(renderer, AGENT_WAKE, agentWakeDetectionSchema, { type: 'release' }),
    // Thread history reaches the management window alone: the widget draws a thread's state from the shell.
    threadDetail: (threadId: string) => invokeParsed(renderer, AGENT_THREAD_DETAIL_GET, agentThreadDetailResultSchema, agentThreadDetailRequestSchema.parse(threadId)),
    // Whole details and the deltas between them share this channel, so the shape they share is the guard.
    onThreadDetail: (listener: (update: import('../shared/agents').AgentThreadDetailUpdate) => void) => subscribe(renderer, AGENT_THREAD_DETAIL,
      trustedState<import('../shared/agents').AgentThreadDetailUpdate>('threadId'), listener),
    } : {}),
    command: (command: import('../shared/agents').AgentCommand) => invokeParsed(renderer, AGENT_COMMAND, agentStateSchema, validatedRoutedCommand(command)),
    // The broadcast may omit a model catalog this window already has (issue #286), coded as
    // AgentStateBroadcast rather than AgentState. This crosses to the page unreassembled on purpose:
    // contextBridge copies whatever a listener is called with back across the isolated-world boundary,
    // so putting the catalog back here would clone it again on the way out, defeating most of what
    // omitting it saved. The page puts it back; see src/renderer/src/agents/agentStateCatalogs.ts.
    onState: (listener: (state: import('../shared/agents').AgentState) => void) => subscribe(renderer, AGENT_STATE,
      trustedState<Record<string, unknown>>('host'), raw => listener(raw as import('../shared/agents').AgentState)),
  })
}

export function createSottoBridge(
  renderer: IpcRendererAdapter,
  platform: SottoPlatform,
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
  const onUpdateStatus = createBufferedSubscription(
    renderer,
    UPDATE_STATUS,
    updateStatusSchema,
    1,
  )
  const bridge: SottoBridge = {
    hosts: Object.freeze<import('../shared/hosts').HostsBridge>({ get: () => renderer.invoke(HOSTS_GET) as Promise<HostsState>, command: command => renderer.invoke(HOSTS_COMMAND, hostsCommandSchema.parse(command)) as Promise<HostsState>, onChanged: listener => subscribe(renderer, HOSTS_CHANGED, trustedState<HostsState>('hosts'), listener), sshSuggestions: () => renderer.invoke(HOSTS_SSH_SUGGESTIONS) as Promise<SshHostSuggestion[]> }),
    ...createToolsBridges(renderer),
    terminals: createTerminalWorkspaceBridge(renderer),
    themes: createThemesBridge(renderer),
    subagents: Object.freeze<SubagentsBridge>({
      page: request => invokeParsed(renderer, SUBAGENTS_PAGE, subagentPageSchema, subagentPageRequestSchema.parse(request)),
      assignments: request => invokeParsed(renderer, SUBAGENTS_ASSIGNMENTS, subagentAssignmentsPageSchema, subagentAssignmentsRequestSchema.parse(request)),
      onChanged: listener => subscribe(renderer, SUBAGENTS_CHANGED, subagentChangeSchema, listener),
    }),
    files: Object.freeze<FilesBridge>({
      list: request => invokeParsed(renderer, FILES_LIST, filesResultSchema(fileListingSchema), fileListRequestSchema.parse(request)),
      preview: request => invokeParsed(renderer, FILES_PREVIEW, filesResultSchema(filePreviewSchema), fileRequestSchema.parse(request)),
      copyPath: request => invokeParsed(renderer, FILES_COPY_PATH, filesResultSchema(filePathSchema), fileRequestSchema.parse(request)),
      reveal: request => invokeParsed(renderer, FILES_REVEAL, filesResultSchema(filePathSchema), fileRequestSchema.parse(request)),
    }),
    memory: Object.freeze<MemoryBridge>({
      get: () => invokeParsed(renderer, MEMORY_GET, memorySnapshotSchema),
      command: command => invokeParsed(renderer, MEMORY_COMMAND, memorySnapshotSchema, memoryCommandSchema.parse(command)),
      onChanged: listener => subscribe(renderer, MEMORY_CHANGED, memorySnapshotSchema, listener),
    }),
    agents: createAgentBridge(renderer, 'main'),
    personalChats: createPersonalChatBridge(renderer),
    chatPrompts: Object.freeze<ChatPromptBridge>({ generate: input => invokeParsed(renderer, CHAT_PROMPT_GENERATE, chatPromptResultSchema, chatPromptInputSchema.parse(input)),
      copy: text => invokeParsed(renderer, CHAT_PROMPT_COPY, z.void(), chatPromptCopySchema.parse(text)) }),
    requestDrafts: Object.freeze<RequestDraftBridge>({
      list: owner => invokeParsed(renderer, REQUEST_DRAFT_LIST, requestDraftSchema.array(), requestDraftOwnerSchema.parse(owner)),
      discard: input => invokeParsed(renderer, REQUEST_DRAFT_DISCARD, z.boolean(), requestDraftDiscardSchema.parse(input)),
      get: target => invokeParsed(renderer, REQUEST_DRAFT_GET, requestDraftSchema.nullable(), requestDraftTargetSchema.parse(target)),
      save: draft => invokeParsed(renderer, REQUEST_DRAFT_SAVE, requestDraftSchema, requestDraftSchema.parse(draft)),
      check: target => invokeParsed(renderer, REQUEST_DRAFT_CHECK, requestDraftSchema.nullable(), requestDraftTargetSchema.parse(target)),
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
    deleteHistory: (id) => invokeParsed(renderer, HISTORY_DELETE, z.boolean(), id),
    clearHistory: () => invokeParsed(renderer, HISTORY_CLEAR, voidSchema),

    getHotkey: () => invokeParsed(renderer, HOTKEY_GET, z.string().nullable()),
    replaceHotkey: (accelerator) =>
      invokeParsed(renderer, HOTKEY_REPLACE, hotkeyResultSchema, accelerator),

    requestDictation: (command) =>
      invokeParsed(renderer, DICTATION_REQUEST, commandResultSchema, command),
    onDictationCommand,

    publishWidgetState: (state) =>
      invokeParsed(renderer, WIDGET_PUBLISH, commandResultSchema, state),
    deliverOutput: (request) =>
      invokeParsed(renderer, OUTPUT_DELIVER, outputResultSchema, request),

    polishTranscript: (request) =>
      invokeParsed(renderer, TRANSCRIPT_POLISH, transcriptPolishResultSchema, request),

    transcribe: (request) =>
      invokeParsed(renderer, TRANSCRIPTION_TRANSCRIBE, transcriptionResultSchema, request),
    cancelTranscription: (requestId) =>
      invokeParsed(renderer, TRANSCRIPTION_CANCEL, commandResultSchema, requestId),
    checkTranscriptionKey: () => invokeParsed(renderer, TRANSCRIPTION_CHECK_KEY, transcriptionKeyCheckSchema),

    getUpdateStatus: () => invokeParsed(renderer, UPDATE_GET_STATUS, updateResponseSchema),
    checkForUpdates: () => invokeParsed(renderer, UPDATE_CHECK, updateResponseSchema),
    downloadUpdate: () => invokeParsed(renderer, UPDATE_DOWNLOAD, commandResultSchema),
    installUpdate: () => invokeParsed(renderer, UPDATE_INSTALL, commandResultSchema),
    onUpdateStatus,
    onUpdateCheckRequested: listener => subscribe(renderer, UPDATE_CHECK_REQUESTED, z.null(), () => listener()),

    getStartup: () => invokeParsed(renderer, STARTUP_GET, startupStateSchema),
    setStartup: (enabled) => invokeParsed(renderer, STARTUP_SET, startupStateSchema, enabled),

    showApp: () => invokeParsed(renderer, APP_SHOW, voidSchema),
    openExternalLink: url => invokeParsed(renderer, EXTERNAL_LINK_OPEN, commandResultSchema, externalLinkSchema.parse(url)),
    hideApp: () => invokeParsed(renderer, APP_HIDE, voidSchema),
    reloadApp: () => invokeParsed(renderer, APP_RELOAD, voidSchema),
    minimizeApp: () => invokeParsed(renderer, APP_MINIMIZE, voidSchema),
    toggleMaximizeApp: () => invokeParsed(renderer, APP_TOGGLE_MAXIMIZE, voidSchema),
    getWindowMaximized: () => invokeParsed(renderer, APP_MAXIMIZED, z.boolean()),
    onWindowMaximized: listener => subscribe(renderer, APP_MAXIMIZED, z.boolean(), listener),
    quitApp: () => invokeParsed(renderer, APP_QUIT, voidSchema),
  }
  return hostClientBridge(bridge)
}

export function createSottoWidgetBridge(
  renderer: IpcRendererAdapter,
  platform: SottoPlatform,
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

    agents: createAgentBridge(renderer, 'widget'),

    onWidgetState,
    onWidgetVisibilityChange,
    requestToggle: () =>
      invokeParsed(renderer, DICTATION_REQUEST, commandResultSchema, { type: 'toggle' }),
    requestStop: () =>
      invokeParsed(renderer, DICTATION_REQUEST, commandResultSchema, { type: 'stop' }),
    requestCancel: () =>
      invokeParsed(renderer, DICTATION_REQUEST, commandResultSchema, { type: 'cancel' }),
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
    context.exposeInMainWorld('sotto', createSottoBridge(renderer, platform))
    return true
  }
  if (rendererRole === 'widget') {
    context.exposeInMainWorld(
      'sottoWidget',
      createSottoWidgetBridge(renderer, platform),
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
    agentEvent: async (event: Parameters<NonNullable<SottoE2EBridge['agentEvent']>>[0]) => {
      const key = parseHostEntityKey(event.threadId)
      if (key === null) return invokeParsed(renderer, AGENT_E2E, voidSchema, event)
      const state = await invokeParsed(renderer, AGENT_GET, agentStateSchema)
      if (key.hostId !== (state.hostId ?? state.host.hostId)) throw new Error('This test event belongs to another host.')
      return invokeParsed(renderer, AGENT_E2E, voidSchema, { ...event, threadId: key.id })
    },
    scenario: scenario.data,
    snapshot: () => invokeParsed(renderer, E2E_SNAPSHOT_CHANNEL, e2eSnapshotSchema),
    triggerShortcut: () => invokeParsed(renderer, E2E_TRIGGER_SHORTCUT_CHANNEL, voidSchema),
  })
  context.exposeInMainWorld('sottoE2E', bridge)
}

exposeRendererBridge(contextBridge, ipcRenderer, process.argv)
exposeE2EBridge(contextBridge, ipcRenderer, process.env, process.argv)
