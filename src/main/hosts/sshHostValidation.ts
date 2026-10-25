import { msg } from '@lingui/core/macro'
import { isIP } from 'node:net'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

import type { SshHostConfiguration, ValidatedSshHostConfiguration } from './sshConfiguration'
import { SaidError } from './hostFailureWords'

/**
 * A saved host's SSH settings, checked before Sotto connects, refused in the interface language (ADR-0123). Only this
 * desktop checks them, so this module, unlike `sshConfiguration.ts`, which the headless host builds, uses macros.
 */
/** Which field a refusal is about: one whole sentence each, so each language can word it (ADR-0123). */
function remotePath(value: string, field: 'installation' | 'data'): string {
  if (!value || value.length > 4096 || /[\p{Cc}]/u.test(value) || !(value.startsWith('/') || value.startsWith('~/'))) {
    throw new SaidError(field === 'installation'
      ? msg`Choose an absolute host installation path, or a path starting with ~/.`
      : msg`Choose an absolute host data path, or a path starting with ~/.`)
  }
  return value
}
function port(value: number | undefined, field: 'host' | 'ssh', minimum = 1): number | undefined {
  if (value !== undefined && (!Number.isInteger(value) || value < minimum || value > 65535)) {
    throw new SaidError(field === 'host' ? msg`Choose a host port between 1 and 65535.` : msg`Choose a SSH port between 1 and 65535.`)
  }
  return value
}
export function validateSshHost(configuration: SshHostConfiguration): ValidatedSshHostConfiguration {
  const target = configuration.target
  const parts = target.split('@')
  const user = parts.length === 2 ? parts[0] : undefined
  const host = parts.at(-1) ?? ''
  const validHost = host.startsWith('[') && host.endsWith(']') ? isIP(host.slice(1, -1)) === 6 : /^[a-z0-9][a-z0-9._-]*$/iu.test(host)
  if (!target || target.length > 320 || parts.length > 2 || !validHost || (user !== undefined && !/^[a-z0-9_][a-z0-9_.-]*$/iu.test(user))) {
    throw new SaidError(msg`Enter an SSH host such as forge or user@forge. Put SSH options in your SSH configuration.`)
  }
  let identityFile = configuration.identityFile
  if (identityFile !== undefined && identityFile !== '') {
    if (identityFile.startsWith('~/') || identityFile.startsWith('~\\')) identityFile = join(homedir(), identityFile.slice(2))
    if (!isAbsolute(identityFile) || identityFile.length > 4096 || /[\p{Cc}]/u.test(identityFile)) throw new SaidError(msg`Choose an absolute path for the SSH identity file.`)
  } else identityFile = undefined
  return { target, installPath: remotePath(configuration.installPath, 'installation'),
    dataDirectory: remotePath(configuration.dataDirectory ?? '~/.sotto', 'data'),
    remotePort: port(configuration.remotePort, 'host', 0) ?? 0,
    ...(port(configuration.sshPort, 'ssh') !== undefined ? { sshPort: configuration.sshPort } : {}),
    ...(identityFile !== undefined ? { identityFile } : {}) }
}
