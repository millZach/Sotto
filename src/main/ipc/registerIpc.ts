import { z } from 'zod'

import {
  APP_HIDE,
  APP_MINIMIZE,
  APP_QUIT,
  APP_SHOW,
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
  MODEL_REMOVE,
  OUTPUT_DELIVER,
  SETTINGS_GET,
  SETTINGS_RESET,
  SETTINGS_UPDATE,
  STARTUP_GET,
  STARTUP_SET,
  WIDGET_PUBLISH,
} from '../../shared/channels'
import {
  dictationCommandSchema,
  dictationStateSchema,
  type CommandResult,
  type DictationCommand,
  type HotkeyChangeResult,
  type ModelInstallRequest,
  type ModelStatus,
  type OutputOutcome,
  type OutputResult,
  type StartupState,
} from '../../shared/contracts'
import { historyEntrySchema, type HistoryEntry } from '../../shared/history'
import { settingsSchema, type AppSettings, type ModelPreset } from '../../shared/settings'

const noPayloadSchema = z.undefined()
const settingKeys = [
  'version',
  'theme',
  'reducedMotion',
  'microphoneId',
  'hotkey',
  'maxRecordingSeconds',
  'soundCues',
  'modelPreset',
  'language',
  'inferencePreference',
  'formatWhitespace',
  'autoCopy',
  'autoPaste',
  'pasteDelayMs',
  'successDisplayMs',
  'launchAtStartup',
  'startMinimized',
  'historyEnabled',
  'historyRetention',
  'onboardingComplete',
] as const satisfies readonly (keyof AppSettings)[]

const looseSettingsPatchSchema = settingsSchema.partial().strict().superRefine((patch, context) => {
  if (Object.values(patch).some((value) => value === undefined)) {
    context.addIssue({ code: 'custom', message: 'Undefined settings fields are not allowed' })
  }
})

function copyDefinedSetting<Key extends keyof AppSettings>(
  target: Partial<AppSettings>,
  source: z.infer<typeof looseSettingsPatchSchema>,
  key: Key,
): void {
  const value = source[key]
  if (value !== undefined) {
    Reflect.set(target, key, value)
  }
}

const settingsPatchSchema = looseSettingsPatchSchema.transform((patch): Partial<AppSettings> => {
  const exactPatch: Partial<AppSettings> = {}
  for (const key of settingKeys) {
    copyDefinedSetting(exactPatch, patch, key)
  }
  return exactPatch
})
const historyIdSchema = z.string().min(1).max(256)
const historyQuerySchema = z.string().max(1_000)
const hotkeySchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .refine((accelerator) => accelerator.toLowerCase() !== 'escape')
const modelPresetSchema = z.enum(['fast', 'balanced', 'accurate'])
const modelInstallSchema = z
  .object({ preset: modelPresetSchema, consent: z.literal(true) })
  .strict()
const outputTextSchema = z.string().min(1).max(200_000)

const UNAVAILABLE = Object.freeze({ ok: false as const, reason: 'unavailable' as const })
const OK = Object.freeze({ ok: true as const })

export interface IpcWebContentsLike {
  readonly mainFrame: IpcFrameLike
  getURL(): string
  isDestroyed(): boolean
}

export interface IpcFrameLike {
  readonly parent: unknown | null
  readonly url: string
}

export interface IpcInvocationEvent {
  readonly sender: IpcWebContentsLike
  readonly senderFrame: IpcFrameLike | null
}

export interface TrustedIpcSender {
  readonly webContents: IpcWebContentsLike
  readonly url: string
}

export interface IpcMainAdapter {
  handle(
    channel: string,
    listener: (event: IpcInvocationEvent, ...args: unknown[]) => unknown,
  ): void
  removeHandler(channel: string): void
}

export interface SettingsIpcService {
  get(): Promise<AppSettings>
  update(patch: Partial<AppSettings>): Promise<AppSettings>
  reset(): Promise<AppSettings>
}

export interface HistoryIpcService {
  list(): Promise<HistoryEntry[]>
  add(
    entry: HistoryEntry,
    options: { readonly enabled: boolean; readonly retention: number | 'unlimited' },
  ): Promise<HistoryEntry[]>
  search(query: string): Promise<HistoryEntry[]>
  delete(id: string): Promise<boolean>
  clear(): Promise<void>
}

export interface StartupIpcService {
  get(): StartupState | Promise<StartupState>
  set(enabled: boolean): StartupState | Promise<StartupState>
}

export interface HotkeyIpcService {
  current(): string | null
  replace(accelerator: string): HotkeyChangeResult
}

export interface AppIpcService {
  show(): void | Promise<void>
  hide(): void | Promise<void>
  minimize(): void | Promise<void>
  quit(): void | Promise<void>
}

export interface DictationIpcService {
  request(command: DictationCommand): void | Promise<void>
  publishWidgetState(state: z.infer<typeof dictationStateSchema>): void | Promise<void>
}

export interface ModelIpcService {
  getStatus(preset: ModelPreset): ModelStatus | Promise<ModelStatus>
  install(request: ModelInstallRequest): void | Promise<void>
  remove(preset: ModelPreset): void | Promise<void>
}

export interface OutputIpcService {
  deliver(
    text: string,
    options: { readonly autoPaste: boolean; readonly pasteDelayMs: number },
  ): OutputOutcome | Promise<OutputOutcome>
}

export interface RegisterIpcDependencies {
  readonly settings: SettingsIpcService
  readonly history: HistoryIpcService
  readonly startup: StartupIpcService
  readonly hotkeys: HotkeyIpcService
  readonly app: AppIpcService
  readonly trustedSenders: () => readonly TrustedIpcSender[]
  readonly dictation?: DictationIpcService
  readonly models?: ModelIpcService
  readonly output?: OutputIpcService
}

export class InvalidIpcPayloadError extends Error {
  readonly code = 'INVALID_IPC_PAYLOAD'

  constructor() {
    super('Invalid IPC payload')
    this.name = 'InvalidIpcPayloadError'
  }
}

export class UnauthorizedIpcSenderError extends Error {
  readonly code = 'UNAUTHORIZED_IPC_SENDER'

  constructor() {
    super('Unauthorized IPC sender')
    this.name = 'UnauthorizedIpcSenderError'
  }
}

const handlerOwners = new WeakMap<IpcMainAdapter, Map<string, symbol>>()

function parsePayload<Output>(schema: z.ZodType<Output>, payload: unknown): Output {
  const result = schema.safeParse(payload)
  if (!result.success) {
    throw new InvalidIpcPayloadError()
  }
  return result.data
}

export function isAuthorizedIpcSender(
  event: IpcInvocationEvent,
  trustedSenders: readonly TrustedIpcSender[],
): boolean {
  if (event.senderFrame === null || event.senderFrame.parent !== null) {
    return false
  }
  if (event.sender.isDestroyed()) {
    return false
  }

  return trustedSenders.some(
    (trusted) =>
      trusted.webContents === event.sender &&
      event.senderFrame === event.sender.mainFrame &&
      trusted.url === event.sender.getURL() &&
      trusted.url === event.senderFrame?.url,
  )
}

export function registerIpc(
  ipcMain: IpcMainAdapter,
  dependencies: RegisterIpcDependencies,
): () => void {
  const owner = Symbol('talktype-ipc-owner')
  const ownership = handlerOwners.get(ipcMain) ?? new Map<string, symbol>()
  handlerOwners.set(ipcMain, ownership)
  const ownedChannels: string[] = []

  const register = <Input, Result>(
    channel: string,
    schema: z.ZodType<Input>,
    argumentCount: 0 | 1,
    operation: (input: Input) => Result | Promise<Result>,
  ): void => {
    if (ownership.has(channel)) {
      ipcMain.removeHandler(channel)
      ownership.delete(channel)
    }

    ipcMain.handle(channel, async (event, ...args) => {
      if (!isAuthorizedIpcSender(event, dependencies.trustedSenders())) {
        throw new UnauthorizedIpcSenderError()
      }
      if (args.length !== argumentCount) {
        throw new InvalidIpcPayloadError()
      }
      const input = parsePayload(schema, argumentCount === 0 ? undefined : args[0])
      return operation(input)
    })
    ownership.set(channel, owner)
    ownedChannels.push(channel)
  }

  let cleaned = false
  const cleanup = (): void => {
    if (cleaned) {
      return
    }
    cleaned = true
    for (const channel of ownedChannels) {
      if (ownership.get(channel) === owner) {
        ipcMain.removeHandler(channel)
        ownership.delete(channel)
      }
    }
    if (ownership.size === 0) {
      handlerOwners.delete(ipcMain)
    }
  }

  try {

  register(SETTINGS_GET, noPayloadSchema, 0, () => dependencies.settings.get())
  register(SETTINGS_UPDATE, settingsPatchSchema, 1, (patch) =>
    dependencies.settings.update(patch),
  )
  register(SETTINGS_RESET, noPayloadSchema, 0, () => dependencies.settings.reset())

  register(HISTORY_LIST, noPayloadSchema, 0, () => dependencies.history.list())
  register(HISTORY_ADD, historyEntrySchema.strict(), 1, async (entry) => {
    const settings = await dependencies.settings.get()
    return dependencies.history.add(entry, {
      enabled: settings.historyEnabled,
      retention: settings.historyRetention,
    })
  })
  register(HISTORY_SEARCH, historyQuerySchema, 1, (query) => dependencies.history.search(query))
  register(HISTORY_DELETE, historyIdSchema, 1, (id) => dependencies.history.delete(id))
  register(HISTORY_CLEAR, noPayloadSchema, 0, () => dependencies.history.clear())

  register(HOTKEY_GET, noPayloadSchema, 0, () => dependencies.hotkeys.current())
  register(HOTKEY_REPLACE, hotkeySchema, 1, (accelerator) =>
    dependencies.hotkeys.replace(accelerator),
  )

  register(STARTUP_GET, noPayloadSchema, 0, () => dependencies.startup.get())
  register(STARTUP_SET, z.boolean(), 1, (enabled) => dependencies.startup.set(enabled))

  register(APP_SHOW, noPayloadSchema, 0, () => dependencies.app.show())
  register(APP_HIDE, noPayloadSchema, 0, () => dependencies.app.hide())
  register(APP_MINIMIZE, noPayloadSchema, 0, () => dependencies.app.minimize())
  register(APP_QUIT, noPayloadSchema, 0, () => dependencies.app.quit())

  register(DICTATION_REQUEST, dictationCommandSchema, 1, async (command): Promise<CommandResult> => {
    if (dependencies.dictation === undefined) {
      return UNAVAILABLE
    }
    await dependencies.dictation.request(command)
    return OK
  })
  register(WIDGET_PUBLISH, dictationStateSchema, 1, async (state): Promise<CommandResult> => {
    if (dependencies.dictation === undefined) {
      return UNAVAILABLE
    }
    await dependencies.dictation.publishWidgetState(state)
    return OK
  })

  register(MODEL_GET_STATUS, modelPresetSchema, 1, async (preset) => {
    if (dependencies.models === undefined) {
      return UNAVAILABLE
    }
    return dependencies.models.getStatus(preset)
  })
  register(MODEL_INSTALL, modelInstallSchema, 1, async (request): Promise<CommandResult> => {
    if (dependencies.models === undefined) {
      return UNAVAILABLE
    }
    await dependencies.models.install(request)
    return OK
  })
  register(MODEL_REMOVE, modelPresetSchema, 1, async (preset): Promise<CommandResult> => {
    if (dependencies.models === undefined) {
      return UNAVAILABLE
    }
    await dependencies.models.remove(preset)
    return OK
  })
  register(OUTPUT_DELIVER, outputTextSchema, 1, async (text): Promise<OutputResult> => {
    if (dependencies.output === undefined) {
      return UNAVAILABLE
    }
    const settings = await dependencies.settings.get()
    return dependencies.output.deliver(text, {
      autoPaste: settings.autoPaste,
      pasteDelayMs: settings.pasteDelayMs,
    })
  })
  } catch (error) {
    cleanup()
    throw error
  }

  return cleanup
}
