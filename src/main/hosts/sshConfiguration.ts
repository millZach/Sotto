import { isIP } from 'node:net'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

export interface SshHostConfiguration {
  readonly target: string
  readonly identityFile?: string
  /** Extracted release directory, containing host/index.js. */
  readonly installPath: string
  readonly dataDirectory?: string
  readonly remotePort?: number
  readonly sshPort?: number
}
export interface ValidatedSshHostConfiguration {
  readonly target: string
  readonly identityFile?: string
  readonly installPath: string
  readonly dataDirectory: string
  readonly remotePort: number
  readonly sshPort?: number
}

function remotePath(value: string, label: string): string {
  if (!value || value.length > 4096 || /[\p{Cc}]/u.test(value) || !(value.startsWith('/') || value.startsWith('~/'))) {
    throw new Error(`Choose an absolute ${label} path, or a path starting with ~/.`)
  }
  return value
}
function port(value: number | undefined, label: string, minimum = 1): number | undefined {
  if (value !== undefined && (!Number.isInteger(value) || value < minimum || value > 65535)) throw new Error(`Choose a ${label} port between 1 and 65535.`)
  return value
}
export function validateSshHost(configuration: SshHostConfiguration): ValidatedSshHostConfiguration {
  const target = configuration.target
  const parts = target.split('@')
  const user = parts.length === 2 ? parts[0] : undefined
  const host = parts.at(-1) ?? ''
  const validHost = host.startsWith('[') && host.endsWith(']') ? isIP(host.slice(1, -1)) === 6 : /^[a-z0-9][a-z0-9._-]*$/iu.test(host)
  if (!target || target.length > 320 || parts.length > 2 || !validHost || (user !== undefined && !/^[a-z0-9_][a-z0-9_.-]*$/iu.test(user))) {
    throw new Error('Enter an SSH host such as forge or user@forge. Put SSH options in your SSH configuration.')
  }
  let identityFile = configuration.identityFile
  if (identityFile !== undefined && identityFile !== '') {
    if (identityFile.startsWith('~/') || identityFile.startsWith('~\\')) identityFile = join(homedir(), identityFile.slice(2))
    if (!isAbsolute(identityFile) || identityFile.length > 4096 || /[\p{Cc}]/u.test(identityFile)) throw new Error('Choose an absolute path for the SSH identity file.')
  } else identityFile = undefined
  return { target, installPath: remotePath(configuration.installPath, 'host installation'),
    dataDirectory: remotePath(configuration.dataDirectory ?? '~/.sotto', 'host data'),
    remotePort: port(configuration.remotePort, 'host', 0) ?? 0,
    ...(port(configuration.sshPort, 'SSH') !== undefined ? { sshPort: configuration.sshPort } : {}),
    ...(identityFile !== undefined ? { identityFile } : {}) }
}

/** OpenSSH passes its remote command through the account's shell even though local spawn has no shell. */
export const quoteRemoteArgument = (value: string): string => `'${value.replace(/'/gu, "'\\''")}'`
