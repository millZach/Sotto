import { DEFAULT_SETTINGS, parseSettings, type AppSettings } from '../../shared/settings'
import type { OmarchyTheme } from '../../shared/themes/omarchy'
import type { RecoveryNotice } from '../../shared/recoveryNotice'
import { AtomicJsonStore } from './atomicJsonStore'
import { parseHostEntityKey } from '../../shared/clientIdentity'

export interface SettingsRepositoryOptions {
  watcherEnabled?: boolean
  now?: () => number
  store?: AtomicJsonStore<AppSettings>
  onRecovery?: (notice: RecoveryNotice) => void
  /** Platform defaults; omitting them keeps the Windows row. */
  defaults?: AppSettings
  /** Present only on Linux. The palette is projected into reads, never persisted. */
  omarchyTheme?: () => OmarchyTheme | null
  /** Present only on Linux. Whether the shell pill replaces the floating widget, projected into reads, never persisted. */
  shellPillInUse?: () => boolean
}

export class SettingsRepository {
  private readonly store: AtomicJsonStore<AppSettings>
  private readonly defaults: AppSettings
  private readonly omarchyTheme: (() => OmarchyTheme | null) | undefined
  private readonly shellPillInUse: (() => boolean) | undefined
  private readonly watcherEnabled: boolean
  private mutationTail: Promise<void> = Promise.resolve()

  constructor(filePath: string, options: SettingsRepositoryOptions = {}) {
    this.watcherEnabled = options.watcherEnabled ?? true
    this.omarchyTheme = options.omarchyTheme
    this.shellPillInUse = options.shellPillInUse
    this.defaults = options.defaults ?? DEFAULT_SETTINGS
    this.store =
      options.store ??
      new AtomicJsonStore(
        filePath,
        (input) => this.parse(input),
        () => this.parse(this.defaults),
        options.now ?? Date.now,
        undefined,
        () => options.onRecovery?.({ code: 'SETTINGS_RECOVERED' }),
      )
  }

  async get(): Promise<AppSettings> {
    await this.mutationTail
    return this.readSettings()
  }

  async save(input: unknown): Promise<AppSettings> {
    const parsed = this.parse(input)
    return this.enqueueMutation(async () => {
      const settings = this.watcherEnabled ? parsed : { ...parsed, watcherInFlightLimit: (await this.readSettings()).watcherInFlightLimit }
      await this.writeSettings(settings)
      return this.project(settings)
    })
  }

  async update(patch: Partial<AppSettings>): Promise<AppSettings> {
    const patchSnapshot = { ...patch }
    return this.enqueueMutation(async () => {
      const current = await this.readSettings()
      if (!this.watcherEnabled && patchSnapshot.watcherInFlightLimit !== undefined && patchSnapshot.watcherInFlightLimit !== current.watcherInFlightLimit) {
        throw new Error('Watcher settings are available in Sotto Owl. Nothing was changed.')
      }
      if (!this.watcherEnabled) delete patchSnapshot.watcherInFlightLimit
      const settings = this.parse({ ...current, ...patchSnapshot })
      await this.writeSettings(settings)
      return this.project(settings)
    })
  }

  async reset(): Promise<AppSettings> {
    const parsed = this.parse(this.defaults)
    return this.enqueueMutation(async () => {
      const settings = this.watcherEnabled ? parsed : { ...parsed, watcherInFlightLimit: (await this.readSettings()).watcherInFlightLimit }
      await this.writeSettings(settings)
      return this.project(settings)
    })
  }

  async exists(): Promise<boolean> {
    await this.mutationTail
    return this.store.exists()
  }

  /** Repair the Settings row's former client-keyed local overrides before any thread reads them. */
  migrateProjectWorkingCopyDefaults(localHostId: string): Promise<void> {
    return this.enqueueMutation(async () => {
      const settings = await this.readSettings()
      const defaults = { ...settings.projectThreadWorkingCopyDefaults }
      let changed = false
      for (const [id, value] of Object.entries(defaults)) {
        const key = parseHostEntityKey(id)
        if (!key || key.hostId !== localHostId) continue
        defaults[key.id] ??= value
        delete defaults[id]
        changed = true
      }
      if (changed) await this.writeSettings(this.parse({ ...settings, projectThreadWorkingCopyDefaults: defaults }))
    })
  }

  private async readSettings(): Promise<AppSettings> {
    return this.project(this.parse(await this.store.read()))
  }

  private parse(input: unknown): AppSettings { return parseSettings(input, this.defaults, this.omarchyTheme !== undefined) }

  private project(settings: AppSettings): AppSettings {
    if (!this.omarchyTheme && !this.shellPillInUse) return settings
    return {
      ...settings,
      ...(this.omarchyTheme ? { omarchyTheme: this.omarchyTheme() } : {}),
      ...(this.shellPillInUse ? { shellPillInUse: this.shellPillInUse() } : {}),
    }
  }
  private writeSettings(settings: AppSettings): Promise<void> {
    return this.store.writeSerialized(JSON.stringify(this.parse(settings), null, 2))
  }

  private enqueueMutation<Result>(mutation: () => Promise<Result>): Promise<Result> {
    const operation = this.mutationTail.then(mutation)
    this.mutationTail = operation.then(
      () => undefined,
      () => undefined,
    )
    return operation
  }
}
