import { join } from 'node:path'
import { z } from 'zod'
import type { RecoveryNotice } from '../../shared/recoveryNotice'
import { AtomicJsonStore } from '../storage/atomicJsonStore'

export interface CredentialEncryption {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

/** The only persisted representation is OS-encrypted ciphertext. */
export class AgentCredentials {
  private readonly store: AtomicJsonStore<Record<string, string>>
  private values: Record<string, string> = {}
  private mutation: Promise<void> = Promise.resolve()
  constructor(directory: string, private readonly encryption: CredentialEncryption, onRecovery?: (notice: RecoveryNotice) => void) {
    this.store = new AtomicJsonStore(join(directory, 'credentials.json'), z.record(z.string(), z.string()).parse, () => ({}),
      undefined, undefined, () => onRecovery?.({ code: 'CREDENTIALS_RECOVERED' }))
  }
  async load(): Promise<void> {
    await this.mutation
    this.values = await this.store.read()
    if (this.has('grokSpeech')) {
      try { await this.set('grokSpeech', '') }
      catch { console.warn('retired-voice-credential-clear-failed') }
    }
  }
  available(): boolean { return this.encryption.isEncryptionAvailable() }
  has(slot: string): boolean { return Boolean(this.values[slot]) }
  get(slot: string): string {
    const value = this.values[slot]
    if (!value) return ''
    if (!this.available()) throw new Error('Unlock your operating system credential store to continue.')
    return this.encryption.decryptString(Buffer.from(value, 'base64'))
  }
  set(slot: string, value: string): Promise<void> {
    return this.enqueue(() => this.write(slot, value))
  }
  /** The slot's ciphertext as stored, for putting it back without decrypting it. */
  sealed(slot: string): string | undefined { return this.values[slot] || undefined }
  restoreSealed(slot: string, sealed: string | undefined): Promise<void> {
    return this.enqueue(async () => {
      const updated = { ...this.values }
      if (sealed) updated[slot] = sealed
      else delete updated[slot]
      await this.store.write(updated)
      this.values = updated
    })
  }
  private enqueue(operation: () => Promise<void>): Promise<void> {
    const queued = this.mutation.then(operation)
    this.mutation = queued.catch(() => undefined)
    return queued
  }
  private async write(slot: string, value: string): Promise<void> {
    if (value && !this.available()) throw new Error('Secure credential storage is unavailable. No key was saved.')
    const updated = { ...this.values }
    if (value) updated[slot] = this.encryption.encryptString(value).toString('base64')
    else delete updated[slot]
    await this.store.write(updated)
    this.values = updated
  }
}
