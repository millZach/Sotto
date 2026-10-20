import { spawn as spawnProcess, type SpawnOptions } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import type { SottoPlatform } from '../../shared/platform'
import type { KeyListenerChild } from './keyListener'
import { keyListenerWin32Invocation } from './keyListenerWin32'

export type SpawnKeyListenerProcess = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => KeyListenerChild

export interface KeyListenerHelperOptions {
  readonly resourcesPath: string
  readonly appPath: string
  readonly packaged: boolean
  readonly acceptSynthetic?: boolean
  readonly spawn?: SpawnKeyListenerProcess
  readonly exists?: (path: string) => boolean
  readonly log: (event: string) => void
}

export function spawnKeyListenerHelper(
  platform: SottoPlatform,
  options: KeyListenerHelperOptions,
): KeyListenerChild | null {
  const spawn = options.spawn ?? spawnProcess
  const exists = options.exists ?? existsSync
  const acceptSynthetic = options.acceptSynthetic ?? false

  let path: string
  if (platform === 'darwin') {
    path = options.packaged
      ? join(options.resourcesPath, 'native', 'sotto-key-listener')
      : join(options.appPath, 'native', 'key-listener', 'build', 'sotto-key-listener')
  } else if (platform === 'win32') {
    path = options.packaged
      ? join(options.resourcesPath, 'native', 'win32.cs')
      : join(options.appPath, 'native', 'key-listener', 'win32.cs')
  } else {
    return null
  }
  if (!exists(path)) {
    options.log('native-key-listener-missing')
    return null
  }

  const { executable, args } =
    platform === 'darwin'
      ? { executable: path, args: acceptSynthetic ? ['--accept-synthetic'] : [] }
      : keyListenerWin32Invocation(path, acceptSynthetic)
  return spawn(executable, [...args], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
}
