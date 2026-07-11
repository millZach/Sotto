import { DEFAULT_SETTINGS, parseSettings, type AppSettings } from '../../shared/settings'
import { AtomicJsonStore } from './atomicJsonStore'

export interface SettingsRepositoryOptions {
  now?: () => number
  store?: AtomicJsonStore<AppSettings>
}

export class SettingsRepository {
  private readonly store: AtomicJsonStore<AppSettings>

  constructor(filePath: string, options: SettingsRepositoryOptions = {}) {
    this.store =
      options.store ??
      new AtomicJsonStore(
        filePath,
        parseSettings,
        () => parseSettings(DEFAULT_SETTINGS),
        options.now ?? Date.now,
      )
  }

  async get(): Promise<AppSettings> {
    return parseSettings(await this.store.read())
  }

  async save(input: unknown): Promise<AppSettings> {
    const settings = parseSettings(input)
    await this.store.write(settings)
    return parseSettings(settings)
  }

  async update(patch: Partial<AppSettings>): Promise<AppSettings> {
    const current = await this.get()
    return this.save({ ...current, ...patch })
  }

  async reset(): Promise<AppSettings> {
    const settings = parseSettings(DEFAULT_SETTINGS)
    await this.store.write(settings)
    return parseSettings(settings)
  }

  exists(): Promise<boolean> {
    return this.store.exists()
  }
}
