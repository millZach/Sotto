import { DEFAULT_SETTINGS, parseSettings, type AppSettings } from '../../shared/settings'
import type { RecoveryNotice } from '../../shared/recoveryNotice'
import { AtomicJsonStore } from './atomicJsonStore'

export interface SettingsRepositoryOptions {
  now?: () => number
  store?: AtomicJsonStore<AppSettings>
  onRecovery?: (notice: RecoveryNotice) => void
}

export class SettingsRepository {
  private readonly store: AtomicJsonStore<AppSettings>
  private mutationTail: Promise<void> = Promise.resolve()

  constructor(filePath: string, options: SettingsRepositoryOptions = {}) {
    this.store =
      options.store ??
      new AtomicJsonStore(
        filePath,
        parseSettings,
        () => parseSettings(DEFAULT_SETTINGS),
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
    const settings = parseSettings(input)
    return this.enqueueMutation(async () => {
      await this.store.write(settings)
      return parseSettings(settings)
    })
  }

  async update(patch: Partial<AppSettings>): Promise<AppSettings> {
    const patchSnapshot = { ...patch }
    return this.enqueueMutation(async () => {
      const current = await this.readSettings()
      const settings = parseSettings({ ...current, ...patchSnapshot })
      await this.store.write(settings)
      return parseSettings(settings)
    })
  }

  async reset(): Promise<AppSettings> {
    const settings = parseSettings(DEFAULT_SETTINGS)
    return this.enqueueMutation(async () => {
      await this.store.write(settings)
      return parseSettings(settings)
    })
  }

  async exists(): Promise<boolean> {
    await this.mutationTail
    return this.store.exists()
  }

  private async readSettings(): Promise<AppSettings> {
    return parseSettings(await this.store.read())
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
