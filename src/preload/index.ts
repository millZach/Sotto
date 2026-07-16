import { contextBridge, ipcRenderer } from 'electron'
import { z } from 'zod'

import {
  APP_HIDE,
  APP_MINIMIZE,
  APP_QUIT,
  APP_SHOW,
  DICTATION_COMMAND,
  DICTATION_REQUEST,
  HISTORY_ADD,
  HISTORY_CLEAR,
  HISTORY_DELETE,
  HISTORY_LIST,
  HISTORY_SEARCH,
  HOTKEY_GET,
  HOTKEY_REPLACE,
  MODEL_GET_STATUS,
  MODEL_INSTALL,
  MODEL_LIST_DISCLOSURES,
  MODEL_REMOVE,
  MODEL_STATUS,
  OUTPUT_DELIVER,
  RECOVERY_NOTICE,
  RECOVERY_NOTICE_LIST,
  SETTINGS_GET,
  SETTINGS_CHANGED,
  SETTINGS_RESET,
  SETTINGS_UPDATE,
  STARTUP_GET,
  STARTUP_SET,
  WIDGET_PUBLISH,
  WIDGET_STATE,
} from '../shared/channels'
import {
  dictationCommandSchema,
  modelDisclosureCatalogSchema,
  modelStatusSchema,
  widgetSnapshotSchema,
  type TalkTypeBridge,
  type TalkTypeWidgetBridge,
} from '../shared/contracts'
import { historyEntrySchema } from '../shared/history'
import { settingsSchema } from '../shared/settings'
import { recoveryNoticeSchema, recoveryNoticesSchema } from '../shared/recoveryNotice'
import {
  E2E_SNAPSHOT_CHANNEL,
  E2E_TRIGGER_SHORTCUT_CHANNEL,
  e2eScenarioSchema,
  e2eSnapshotSchema,
  type TalkTypeE2EBridge,
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
const modelResponseSchema = z.union([modelStatusSchema, unavailableSchema])
const modelDisclosureResponseSchema = z.union([modelDisclosureCatalogSchema, unavailableSchema])
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

function subscribe<Output>(
  renderer: IpcRendererAdapter,
  channel: string,
  schema: z.ZodType<Output>,
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

export function createTalkTypeBridge(renderer: IpcRendererAdapter): TalkTypeBridge {
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
  const bridge: TalkTypeBridge = {
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
    getModelStatus: (preset) =>
      invokeParsed(renderer, MODEL_GET_STATUS, modelResponseSchema, preset),
    listModelDisclosures: () =>
      invokeParsed(renderer, MODEL_LIST_DISCLOSURES, modelDisclosureResponseSchema),
    installModel: (request) =>
      invokeParsed(renderer, MODEL_INSTALL, commandResultSchema, request),
    removeModel: (preset) =>
      invokeParsed(renderer, MODEL_REMOVE, commandResultSchema, preset),
    onModelStatus: (listener) => subscribe(renderer, MODEL_STATUS, modelStatusSchema, listener),

    deliverOutput: (request) =>
      invokeParsed(renderer, OUTPUT_DELIVER, outputResultSchema, request),

    getStartup: () => invokeParsed(renderer, STARTUP_GET, startupStateSchema),
    setStartup: (enabled) => invokeParsed(renderer, STARTUP_SET, startupStateSchema, enabled),

    showApp: () => invokeParsed(renderer, APP_SHOW, voidSchema),
    hideApp: () => invokeParsed(renderer, APP_HIDE, voidSchema),
    minimizeApp: () => invokeParsed(renderer, APP_MINIMIZE, voidSchema),
    quitApp: () => invokeParsed(renderer, APP_QUIT, voidSchema),
  }
  return Object.freeze(bridge)
}

export function createTalkTypeWidgetBridge(
  renderer: IpcRendererAdapter,
): TalkTypeWidgetBridge {
  const onWidgetState = createBufferedSubscription(
    renderer,
    WIDGET_STATE,
    widgetSnapshotSchema,
    1,
  )
  return Object.freeze({
    onWidgetState,
    requestStop: () =>
      invokeParsed(renderer, DICTATION_REQUEST, commandResultSchema, { type: 'stop' }),
    requestCancel: () =>
      invokeParsed(renderer, DICTATION_REQUEST, commandResultSchema, { type: 'cancel' }),
  })
}

const RENDERER_ROLE_PREFIX = '--talktype-renderer-role='

export function parseRendererRoleArgument(
  arguments_: readonly string[],
): 'main' | 'widget' | null {
  const matches = arguments_.filter((argument) => argument.startsWith(RENDERER_ROLE_PREFIX))
  if (matches.length !== 1) return null
  const role = matches[0]?.slice(RENDERER_ROLE_PREFIX.length)
  return role === 'main' || role === 'widget' ? role : null
}

export function exposeRendererBridge(
  context: ContextBridgeAdapter,
  renderer: IpcRendererAdapter,
  arguments_: readonly string[],
): boolean {
  const rendererRole = parseRendererRoleArgument(arguments_)
  if (rendererRole === 'main') {
    context.exposeInMainWorld('talktype', createTalkTypeBridge(renderer))
    return true
  }
  if (rendererRole === 'widget') {
    context.exposeInMainWorld('talktypeWidget', createTalkTypeWidgetBridge(renderer))
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
  if (environment.TALKTYPE_E2E !== '1' || parseRendererRoleArgument(arguments_) !== 'main') return
  const scenario = e2eScenarioSchema.safeParse(environment.TALKTYPE_E2E_SCENARIO ?? 'success')
  if (!scenario.success) return
  const bridge: TalkTypeE2EBridge = Object.freeze({
    scenario: scenario.data,
    snapshot: () => invokeParsed(renderer, E2E_SNAPSHOT_CHANNEL, e2eSnapshotSchema),
    triggerShortcut: () => invokeParsed(renderer, E2E_TRIGGER_SHORTCUT_CHANNEL, voidSchema),
  })
  context.exposeInMainWorld('talktypeE2E', bridge)
}

exposeRendererBridge(contextBridge, ipcRenderer, process.argv)
exposeE2EBridge(contextBridge, ipcRenderer, process.env, process.argv)
