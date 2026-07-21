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
  MODEL_LIST_DISCLOSURES,
  MODEL_REMOVE,
  OUTPUT_DELIVER,
  RECOVERY_NOTICE_LIST,
  SETTINGS_GET,
  SETTINGS_RESET,
  SETTINGS_UPDATE,
  STARTUP_GET,
  STARTUP_SET,
  WIDGET_DRAG,
  WIDGET_INTERACTIVITY,
  WIDGET_PUBLISH,
} from '../../shared/channels'
import {
  dictationCommandSchema,
  outputDeliveryRequestSchema,
  widgetDragSchema,
  widgetSnapshotSchema,
  type CommandResult,
  type DictationCommand,
  type HotkeyChangeResult,
  type ModelInstallRequest,
  type ModelDisclosureCatalog,
  type ModelStatus,
  type OutputOutcome,
  type OutputDeliveryRequest,
  type OutputResult,
  type StartupState,
  type WidgetDragPayload,
} from '../../shared/contracts'
import { historyEntrySchema, type HistoryEntry } from '../../shared/history'
import {
  settingsSchema,
  type AppSettings,
  type ModelPreset,
  type SettingsPatch,
} from '../../shared/settings'
import type { RendererRole } from '../security'
import type { RecoveryNotice } from '../../shared/recoveryNotice'

const noPayloadSchema = z.undefined()
const settingKeys = [
  'version',
  'theme',
  'reducedMotion',
  'microphoneId',
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
  'startMinimized',
  'showWidgetWhenIdle',
  'historyEnabled',
  'historyRetention',
  'onboardingComplete',
] as const satisfies readonly (keyof SettingsPatch)[]

const looseSettingsPatchSchema = settingsSchema
  .omit({ hotkey: true, launchAtStartup: true })
  .partial()
  .strict()
  .superRefine((patch, context) => {
    if (Object.values(patch).some((value) => value === undefined)) {
      context.addIssue({ code: 'custom', message: 'Undefined settings fields are not allowed' })
    }
  })

function copyDefinedSetting<Key extends (typeof settingKeys)[number]>(
  target: SettingsPatch,
  source: z.infer<typeof looseSettingsPatchSchema>,
  key: Key,
): void {
  const value = source[key]
  if (value !== undefined) {
    Reflect.set(target, key, value)
  }
}

const settingsPatchSchema = looseSettingsPatchSchema.transform((patch): SettingsPatch => {
  const exactPatch: SettingsPatch = {}
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
const modelPresetSchema = z.enum(['fast', 'balanced', 'accurate', 'instant'])
const modelInstallSchema = z
  .object({ preset: modelPresetSchema, consent: z.literal(true) })
  .strict()
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
  readonly role: RendererRole
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
  update(patch: SettingsPatch): Promise<AppSettings>
  reset(): Promise<AppSettings>
}

export interface HistoryIpcService {
  list(options: { readonly enabled: boolean }): Promise<HistoryEntry[]>
  add(
    entry: HistoryEntry,
    options: { readonly enabled: boolean; readonly retention: number | 'unlimited' },
  ): Promise<HistoryEntry[]>
  search(query: string, options: { readonly enabled: boolean }): Promise<HistoryEntry[]>
  delete(id: string, options: { readonly enabled: boolean }): Promise<boolean>
  clear(): Promise<void>
}

export interface StartupIpcService {
  get(): StartupState | Promise<StartupState>
  set(enabled: boolean): StartupState | Promise<StartupState>
}

export interface HotkeyIpcService {
  current(): string | null | Promise<string | null>
  replace(accelerator: string): HotkeyChangeResult | Promise<HotkeyChangeResult>
}

export interface AppIpcService {
  show(): void | Promise<void>
  hide(): void | Promise<void>
  minimize(): void | Promise<void>
  quit(): void | Promise<void>
}

export interface DictationIpcService {
  request(command: DictationCommand): void | Promise<void>
  publishWidgetState(state: z.infer<typeof widgetSnapshotSchema>): void | Promise<void>
}

export interface ModelIpcService {
  listDisclosures(): ModelDisclosureCatalog | Promise<ModelDisclosureCatalog>
  getStatus(preset: ModelPreset): ModelStatus | Promise<ModelStatus>
  install(request: ModelInstallRequest): void | Promise<void>
  remove(preset: ModelPreset): void | Promise<void>
}

export interface OutputIpcService {
  deliver(
    text: string,
    options: Pick<OutputDeliveryRequest, 'autoPaste' | 'pasteDelayMs'>,
  ): OutputOutcome | Promise<OutputOutcome>
}

export interface RecoveryNoticeIpcService {
  list(): readonly RecoveryNotice[] | Promise<readonly RecoveryNotice[]>
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
  readonly recoveryNotices?: RecoveryNoticeIpcService
  readonly widget?: WidgetIpcService
}

export interface WidgetIpcService {
  setMouseInteractive(interactive: boolean): void
  reportDrag(payload: WidgetDragPayload): void
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

export class IpcRegistrationActiveError extends Error {
  readonly code = 'IPC_REGISTRATION_ACTIVE'

  constructor() {
    super('IPC registration is already active')
    this.name = 'IpcRegistrationActiveError'
  }
}

export class IpcCleanupError extends Error {
  readonly code = 'IPC_CLEANUP_FAILED'

  constructor() {
    super('IPC cleanup failed')
    this.name = 'IpcCleanupError'
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
  allowedRoles: readonly RendererRole[],
): boolean {
  return findAuthorizedIpcSenderRole(event, trustedSenders, allowedRoles) !== null
}

function findAuthorizedIpcSenderRole(
  event: IpcInvocationEvent,
  trustedSenders: readonly TrustedIpcSender[],
  allowedRoles: readonly RendererRole[],
): RendererRole | null {
  try {
    if (event.senderFrame === null || event.senderFrame.parent !== null) {
      return null
    }
    if (event.sender.isDestroyed()) {
      return null
    }

    const trusted = trustedSenders.find(
      (trusted) =>
        allowedRoles.includes(trusted.role) &&
        trusted.webContents === event.sender &&
        event.senderFrame === event.sender.mainFrame &&
        trusted.url === event.sender.getURL() &&
        trusted.url === event.senderFrame?.url,
    )
    return trusted?.role ?? null
  } catch {
    return null
  }
}

export function registerIpc(
  ipcMain: IpcMainAdapter,
  dependencies: RegisterIpcDependencies,
): () => void {
  const activeOwnership = handlerOwners.get(ipcMain)
  if (activeOwnership !== undefined && activeOwnership.size > 0) {
    throw new IpcRegistrationActiveError()
  }
  const owner = Symbol('talktype-ipc-owner')
  const ownership = activeOwnership ?? new Map<string, symbol>()
  handlerOwners.set(ipcMain, ownership)
  const ownedChannels: string[] = []

  const register = <Input, Result>(
    channel: string,
    schema: z.ZodType<Input>,
    argumentCount: 0 | 1,
    operation: (input: Input, role: RendererRole) => Result | Promise<Result>,
    allowedRoles: readonly RendererRole[] = ['main'],
  ): void => {
    ipcMain.handle(channel, async (event, ...args) => {
      const role = findAuthorizedIpcSenderRole(
        event,
        dependencies.trustedSenders(),
        allowedRoles,
      )
      if (role === null) {
        throw new UnauthorizedIpcSenderError()
      }
      if (args.length !== argumentCount) {
        throw new InvalidIpcPayloadError()
      }
      const input = parsePayload(schema, argumentCount === 0 ? undefined : args[0])
      return operation(input, role)
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
    let cleanupFailed = false
    for (const channel of ownedChannels) {
      if (ownership.get(channel) === owner) {
        try {
          ipcMain.removeHandler(channel)
          ownership.delete(channel)
        } catch {
          cleanupFailed = true
        }
      }
    }
    if (ownership.size === 0) {
      handlerOwners.delete(ipcMain)
    }
    if (cleanupFailed) {
      throw new IpcCleanupError()
    }
  }

  try {
    register(RECOVERY_NOTICE_LIST, noPayloadSchema, 0, () =>
      dependencies.recoveryNotices?.list() ?? [],
    )
    register(SETTINGS_GET, noPayloadSchema, 0, () => dependencies.settings.get())
    register(SETTINGS_UPDATE, settingsPatchSchema, 1, (patch) =>
      dependencies.settings.update(patch),
    )
    register(SETTINGS_RESET, noPayloadSchema, 0, () => dependencies.settings.reset())

    register(HISTORY_LIST, noPayloadSchema, 0, async () => {
      const settings = await dependencies.settings.get()
      return dependencies.history.list({ enabled: settings.historyEnabled })
    })
    register(HISTORY_ADD, historyEntrySchema.strict(), 1, async (entry) => {
      const settings = await dependencies.settings.get()
      return dependencies.history.add(entry, {
        enabled: settings.historyEnabled,
        retention: settings.historyRetention,
      })
    })
    register(HISTORY_SEARCH, historyQuerySchema, 1, async (query) => {
      const settings = await dependencies.settings.get()
      return dependencies.history.search(query, { enabled: settings.historyEnabled })
    })
    register(HISTORY_DELETE, historyIdSchema, 1, async (id) => {
      const settings = await dependencies.settings.get()
      return dependencies.history.delete(id, { enabled: settings.historyEnabled })
    })
    register(HISTORY_CLEAR, noPayloadSchema, 0, () => dependencies.history.clear())

    register(HOTKEY_GET, noPayloadSchema, 0, () => dependencies.hotkeys.current())
    register(HOTKEY_REPLACE, hotkeySchema, 1, (accelerator) =>
      dependencies.hotkeys.replace(accelerator),
    )

    register(STARTUP_GET, noPayloadSchema, 0, () => dependencies.startup.get())
    register(STARTUP_SET, z.boolean(), 1, (enabled) =>
      dependencies.startup.set(enabled),
    )

    register(APP_SHOW, noPayloadSchema, 0, () => dependencies.app.show())
    register(APP_HIDE, noPayloadSchema, 0, () => dependencies.app.hide())
    register(APP_MINIMIZE, noPayloadSchema, 0, () => dependencies.app.minimize())
    register(APP_QUIT, noPayloadSchema, 0, () => dependencies.app.quit())

    register(
      DICTATION_REQUEST,
      dictationCommandSchema,
      1,
      async (command, role): Promise<CommandResult> => {
        // The widget may toggle (click-to-dictate), stop, and cancel; only the
        // explicit 'start' command stays a main-renderer privilege.
        if (role === 'widget' && command.type === 'start') {
          throw new UnauthorizedIpcSenderError()
        }
        if (dependencies.dictation === undefined) {
          return UNAVAILABLE
        }
        await dependencies.dictation.request(command)
        return OK
      },
      ['main', 'widget'],
    )
    register(
      WIDGET_INTERACTIVITY,
      z.boolean(),
      1,
      async (interactive): Promise<CommandResult> => {
        if (dependencies.widget === undefined) {
          return UNAVAILABLE
        }
        dependencies.widget.setMouseInteractive(interactive)
        return OK
      },
      ['widget'],
    )
    register(
      WIDGET_DRAG,
      widgetDragSchema,
      1,
      async (payload): Promise<CommandResult> => {
        if (dependencies.widget === undefined) {
          return UNAVAILABLE
        }
        dependencies.widget.reportDrag(payload)
        return OK
      },
      ['widget'],
    )
    register(
      WIDGET_PUBLISH,
      widgetSnapshotSchema,
      1,
      async (state): Promise<CommandResult> => {
        if (dependencies.dictation === undefined) {
          return UNAVAILABLE
        }
        await dependencies.dictation.publishWidgetState(state)
        return OK
      },
    )

    register(MODEL_LIST_DISCLOSURES, noPayloadSchema, 0, async () => {
      if (dependencies.models === undefined) {
        return UNAVAILABLE
      }
      return dependencies.models.listDisclosures()
    })
    register(MODEL_GET_STATUS, modelPresetSchema, 1, async (preset) => {
      if (dependencies.models === undefined) {
        return UNAVAILABLE
      }
      return dependencies.models.getStatus(preset)
    })
    register(
      MODEL_INSTALL,
      modelInstallSchema,
      1,
      async (request): Promise<CommandResult> => {
        if (dependencies.models === undefined) {
          return UNAVAILABLE
        }
        await dependencies.models.install(request)
        return OK
      },
    )
    register(
      MODEL_REMOVE,
      modelPresetSchema,
      1,
      async (preset): Promise<CommandResult> => {
        if (dependencies.models === undefined) {
          return UNAVAILABLE
        }
        await dependencies.models.remove(preset)
        return OK
      },
    )
    register(OUTPUT_DELIVER, outputDeliveryRequestSchema, 1, async (request): Promise<OutputResult> => {
      if (dependencies.output === undefined) {
        return UNAVAILABLE
      }
      const settings = await dependencies.settings.get()
      return dependencies.output.deliver(request.text, {
        autoPaste: request.autoPaste && settings.autoPaste,
        pasteDelayMs: Math.min(
          1_000,
          Math.max(50, request.pasteDelayMs, settings.pasteDelayMs),
        ),
      })
    })
  } catch (registrationError) {
    try {
      cleanup()
    } catch {
      // Registration failure remains the primary diagnostic.
    }
    throw registrationError
  }

  return cleanup
}
