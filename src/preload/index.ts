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
  SETTINGS_GET,
  SETTINGS_RESET,
  SETTINGS_UPDATE,
  STARTUP_GET,
  STARTUP_SET,
  WIDGET_PUBLISH,
  WIDGET_STATE,
} from '../shared/channels'
import {
  dictationCommandSchema,
  dictationStateSchema,
  modelDisclosureCatalogSchema,
  modelStatusSchema,
  type TalkTypeBridge,
} from '../shared/contracts'
import { historyEntrySchema } from '../shared/history'
import { settingsSchema } from '../shared/settings'

type RendererListener = (event: unknown, ...args: unknown[]) => void

export interface IpcRendererAdapter {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  on(channel: string, listener: RendererListener): unknown
  removeListener(channel: string, listener: RendererListener): unknown
}

const historyEntriesSchema = z.array(historyEntrySchema)
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

export function createTalkTypeBridge(renderer: IpcRendererAdapter): TalkTypeBridge {
  const bridge: TalkTypeBridge = {
    getSettings: () => invokeParsed(renderer, SETTINGS_GET, settingsSchema),
    updateSettings: (patch) => invokeParsed(renderer, SETTINGS_UPDATE, settingsSchema, patch),
    resetSettings: () => invokeParsed(renderer, SETTINGS_RESET, settingsSchema),

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
    onDictationCommand: (listener) =>
      subscribe(renderer, DICTATION_COMMAND, dictationCommandSchema, listener),

    publishWidgetState: (state) =>
      invokeParsed(renderer, WIDGET_PUBLISH, commandResultSchema, state),
    onWidgetState: (listener) => subscribe(renderer, WIDGET_STATE, dictationStateSchema, listener),

    getModelStatus: (preset) =>
      invokeParsed(renderer, MODEL_GET_STATUS, modelResponseSchema, preset),
    listModelDisclosures: () =>
      invokeParsed(renderer, MODEL_LIST_DISCLOSURES, modelDisclosureResponseSchema),
    installModel: (request) =>
      invokeParsed(renderer, MODEL_INSTALL, commandResultSchema, request),
    removeModel: (preset) =>
      invokeParsed(renderer, MODEL_REMOVE, commandResultSchema, preset),
    onModelStatus: (listener) => subscribe(renderer, MODEL_STATUS, modelStatusSchema, listener),

    deliverOutput: (text) => invokeParsed(renderer, OUTPUT_DELIVER, outputResultSchema, text),

    getStartup: () => invokeParsed(renderer, STARTUP_GET, startupStateSchema),
    setStartup: (enabled) => invokeParsed(renderer, STARTUP_SET, startupStateSchema, enabled),

    showApp: () => invokeParsed(renderer, APP_SHOW, voidSchema),
    hideApp: () => invokeParsed(renderer, APP_HIDE, voidSchema),
    minimizeApp: () => invokeParsed(renderer, APP_MINIMIZE, voidSchema),
    quitApp: () => invokeParsed(renderer, APP_QUIT, voidSchema),
  }
  return Object.freeze(bridge)
}

const talkTypeBridge = createTalkTypeBridge(ipcRenderer)
contextBridge.exposeInMainWorld('talktype', talkTypeBridge)
