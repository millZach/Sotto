import { DEFAULT_SETTINGS, parseSettings, type AppSettings } from '../../shared/settings'
import type { RecoveryNotice } from '../../shared/recoveryNotice'
import { AtomicJsonStore } from './atomicJsonStore'
import { parseHostEntityKey } from '../../shared/clientIdentity'

export interface SettingsRepositoryOptions {
  now?: () => number
  store?: AtomicJsonStore<AppSettings>
  onRecovery?: (notice: RecoveryNotice) => void
  /** Platform defaults; omitting them keeps the Windows row. */
  defaults?: AppSettings
}

export class SettingsRepository {
  private readonly store: AtomicJsonStore<AppSettings>
  private readonly defaults: AppSettings
  private mutationTail: Promise<void> = Promise.resolve()

  constructor(filePath: string, options: SettingsRepositoryOptions = {}) {
    this.defaults = options.defaults ?? DEFAULT_SETTINGS
    const defaults = this.defaults
    this.store =
      options.store ??
      new AtomicJsonStore(
        filePath,
        (input) => parseSettings(input, defaults),
        () => parseSettings(defaults, defaults),
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
    const settings = parseSettings(input, this.defaults)
    return this.enqueueMutation(async () => {
      await this.writeSettings(settings)
      return parseSettings(settings, this.defaults)
    })
  }

  async update(patch: Partial<AppSettings>): Promise<AppSettings> {
    const patchSnapshot = { ...patch }
    return this.enqueueMutation(async () => {
      const current = await this.readSettings()
      const settings = parseSettings({ ...current, ...patchSnapshot }, this.defaults)
      await this.writeSettings(settings)
      return parseSettings(settings, this.defaults)
    })
  }

  async reset(): Promise<AppSettings> {
    const settings = parseSettings(this.defaults, this.defaults)
    return this.enqueueMutation(async () => {
      await this.writeSettings(settings)
      return parseSettings(settings, this.defaults)
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
      if (changed) await this.writeSettings({ ...settings, projectThreadWorkingCopyDefaults: defaults })
    })
  }

  private async readSettings(): Promise<AppSettings> {
    return parseSettings(await this.store.read(), this.defaults)
  }
  private writeSettings(settings: AppSettings): Promise<void> {
    const { voiceCoordinatorEnabled, ...current } = settings
    void voiceCoordinatorEnabled
    return this.store.writeSerialized(JSON.stringify(current, null, 2))
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
