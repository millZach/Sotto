import { STORED_CREDENTIAL_PLACEHOLDER, type AppSettings } from '../../shared/settings'
import type { NativeSettingsRepository } from '../settings/nativeSettingsCoordinator'
import type { AgentCredentials } from './credentials'

const STORED_KEY = STORED_CREDENTIAL_PLACEHOLDER

/** Keeps the legacy settings UI compatible without returning decrypted API keys to renderers. */
export class SecureSettings implements NativeSettingsRepository {
  private mutation: Promise<unknown> = Promise.resolve()
  constructor(private readonly repository: NativeSettingsRepository, private readonly credentials: AgentCredentials) {}
  async migrate(): Promise<void> {
    const current = await this.repository.get()
    if (current.llmApiKey) {
      await this.credentials.set('formatting', current.llmApiKey)
      await this.repository.update({ llmApiKey: '' })
    }
  }
  private redact(value: AppSettings): AppSettings {
    return { ...value, llmApiKey: this.credentials.has('formatting') ? STORED_KEY : '' }
  }
  async get(): Promise<AppSettings> { await this.mutation; return this.redact(await this.repository.get()) }
  async forFormatting(): Promise<AppSettings> {
    return { ...await this.repository.get(), llmApiKey: this.credentials.get('formatting') }
  }
  update(patch: Partial<AppSettings>): Promise<AppSettings> {
    const copy = { ...patch }
    return this.mutate(copy.llmApiKey, () => this.repository.update({ ...copy, ...(copy.llmApiKey === undefined ? {} : { llmApiKey: '' }) }))
  }
  save(value: AppSettings): Promise<AppSettings> {
    const copy = { ...value }
    return this.mutate(copy.llmApiKey, () => this.repository.save({ ...copy, llmApiKey: '' }))
  }
  reset(): Promise<AppSettings> { return this.mutate('', () => this.repository.reset()) }
  private mutate(key: string | undefined, write: () => Promise<AppSettings>): Promise<AppSettings> {
    const operation = this.mutation.then(async () => {
      const changesKey = key !== undefined && key !== STORED_KEY
      const previousKey = changesKey ? this.credentials.get('formatting') : ''
      if (changesKey) await this.credentials.set('formatting', key!)
      try { return this.redact(await write()) } catch (error) {
        if (changesKey) await this.credentials.set('formatting', previousKey)
        throw error
      }
    })
    this.mutation = operation.catch(() => undefined)
    return operation
  }
}
