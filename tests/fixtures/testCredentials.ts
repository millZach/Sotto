import { AgentCredentials, type CredentialEncryption } from '../../src/main/agents/credentials'

/** Synthetic ciphertext, never OS encryption. */
export function xorCredentialEncryption(mask = 0xa5): CredentialEncryption {
  return {
    isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(Buffer.from(value).map(byte => byte ^ mask)),
    decryptString: value => Buffer.from(value.map(byte => byte ^ mask)).toString('utf8'),
  }
}

/** Available storage that deliberately leaves bytes plain, for cases that inspect them. */
export function plainCredentialEncryption(): CredentialEncryption {
  return { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() }
}

/** Manual-send cases need no key; a nonempty credential write must still be refused. */
export function unavailableCredentialEncryption(): CredentialEncryption {
  return { ...plainCredentialEncryption(), isEncryptionAvailable: () => false }
}

export type TestCredentialOptions = (
  | { mode: 'xor' | 'unavailable' | 'plain'; encryption?: never }
  | { encryption: CredentialEncryption; mode?: never }
) & { onRecovery?: ConstructorParameters<typeof AgentCredentials>[2] }

/** Loads a fresh store. Custom availability/decryption faults remain explicit at the call site. */
export async function testCredentials(directory: string, options: TestCredentialOptions): Promise<AgentCredentials> {
  const encryption = options.encryption ?? (options.mode === 'xor' ? xorCredentialEncryption()
    : options.mode === 'plain' ? plainCredentialEncryption() : unavailableCredentialEncryption())
  const credentials = new AgentCredentials(directory, encryption, options.onRecovery)
  await credentials.load()
  return credentials
}
