import { STORED_CREDENTIAL_PLACEHOLDER, type AppSettings } from '../../shared/settings'
import type { NativeSettingsRepository } from '../settings/nativeSettingsCoordinator'
import type { AgentCredentials } from './credentials'

const STORED_KEY = STORED_CREDENTIAL_PLACEHOLDER

/** Keeps the legacy settings UI compatible without returning decrypted API keys to renderers. */
export class SecureSettings implements NativeSettingsRepository {
  private mutation: Promise<unknown> = Promise.resolve()
  constructor(
    private readonly repository: NativeSettingsRepository,
    private readonly credentials: AgentCredentials,
    /** Told when a saved OpenRouter key exists but cannot be decrypted (a denied Keychain prompt on macOS). */
    private readonly onKeyUnreadable: () => void = () => undefined,
  ) {}
  async migrate(onStorageFailure: () => void = () => undefined): Promise<void> {
    const current = await this.repository.get()
    if (current.llmApiKey) {
      try {
        await this.credentials.set('formatting', current.llmApiKey)
      } catch (error) {
        onStorageFailure()
        throw error
      } finally {
        // A failed vault write must never leave a readable key on disk.
        await this.repository.update({ llmApiKey: '' })
      }
    }
  }
  private redact(value: AppSettings): AppSettings {
    return { ...value, llmApiKey: this.credentials.has('formatting') ? STORED_KEY : '' }
  }
  async get(): Promise<AppSettings> { await this.mutation; return this.redact(await this.repository.get()) }
  async forFormatting(): Promise<AppSettings> {
    const settings = await this.repository.get()
    let llmApiKey: string
    try {
      llmApiKey = this.credentials.get('formatting')
    } catch (error) {
      // The ciphertext stays where it is: allowing access later reads it again.
      try { this.onKeyUnreadable() } catch { /* the notice is best effort */ }
      throw error
    }
    return { ...settings, llmApiKey }
  }
  update(patch: Partial<AppSettings>): Promise<AppSettings> {
    const copy = { ...patch }
    return this.mutate(copy.llmApiKey, () => this.repository.update({ ...copy, ...(copy.llmApiKey === undefined ? {} : { llmApiKey: '' }) }))
  }
  save(value: AppSettings): Promise<AppSettings> {
    const copy = { ...value }
    return this.mutate(copy.llmApiKey, () => this.repository.save({ ...copy, llmApiKey: '' }))
  }
  reset(): Promise<AppSettings> { return this.mutate(undefined, () => this.repository.reset()) }
  private mutate(key: string | undefined, write: () => Promise<AppSettings>): Promise<AppSettings> {
    const operation = this.mutation.then(async () => {
      const changesKey = key !== undefined && key !== STORED_KEY
      // The sealed copy, not the decrypted key: replacing a key the Keychain will not
      // unlock must still work, and a failed save puts the old ciphertext back untouched.
      const previous = changesKey ? this.credentials.sealed('formatting') : undefined
      if (changesKey) await this.credentials.set('formatting', key!)
      try { return this.redact(await write()) } catch (error) {
        if (changesKey) await this.credentials.restoreSealed('formatting', previous)
        throw error
      }
    })
    this.mutation = operation.catch(() => undefined)
    return operation
  }
}
