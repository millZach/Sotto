import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { AgentCredentials, type CredentialEncryption } from '../main/agents/credentials'

const HEADER = Buffer.from('SOTTO1')
const CREDENTIAL_ERROR = 'Host credentials could not be unlocked. Restore the credential file and supply its original key file.'

/** A user-held key encrypts credentials; it is never copied into the host data directory. */
export class HostCredentialEncryption implements CredentialEncryption {
  constructor(private readonly secret?: string) {
    if (secret !== undefined && secret.length < 16) throw new Error('The host key file must contain at least 16 characters.')
  }
  isEncryptionAvailable(): boolean { return this.secret !== undefined }
  encryptString(value: string): Buffer {
    if (!this.secret) throw new Error('Supply a host key file before saving credentials.')
    const salt = randomBytes(16), nonce = randomBytes(12)
    const key = scryptSync(this.secret, salt, 32)
    try {
      const cipher = createCipheriv('aes-256-gcm', key, nonce)
      cipher.setAAD(HEADER)
      const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
      return Buffer.concat([HEADER, salt, nonce, cipher.getAuthTag(), ciphertext])
    } finally { key.fill(0) }
  }
  decryptString(value: Buffer): string {
    if (!this.secret || value.length < 50 || !value.subarray(0, 6).equals(HEADER)) throw new Error(CREDENTIAL_ERROR)
    const key = scryptSync(this.secret, value.subarray(6, 22), 32)
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(22, 34))
      decipher.setAAD(HEADER)
      decipher.setAuthTag(value.subarray(34, 50))
      return Buffer.concat([decipher.update(value.subarray(50)), decipher.final()]).toString('utf8')
    } catch { throw new Error(CREDENTIAL_ERROR) }
    finally { key.fill(0) }
  }
}

export async function openHostCredentials(directory: string, keyFile?: string): Promise<AgentCredentials> {
  const encryption = new HostCredentialEncryption(keyFile ? (await readFile(keyFile, 'utf8')).trimEnd() : undefined)
  // AgentCredentials uses desktop recovery semantics. Headless startup validates first so a damaged
  // file, a desktop-encrypted file or the wrong key can never silently become an empty credential set.
  const path = join(directory, 'credentials.json')
  let contents: string | undefined
  try { contents = await readFile(path, 'utf8') }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  if (contents !== undefined) {
    try {
      const values = z.record(z.string(), z.string()).parse(JSON.parse(contents))
      for (const value of Object.values(values)) {
        if (!value || Buffer.from(value, 'base64').toString('base64') !== value) throw new Error(CREDENTIAL_ERROR)
        encryption.decryptString(Buffer.from(value, 'base64'))
      }
    } catch { throw new Error(CREDENTIAL_ERROR) }
  }
  const credentials = new AgentCredentials(directory, encryption)
  await credentials.load()
  return credentials
}
