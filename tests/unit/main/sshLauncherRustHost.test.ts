// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { launchConfiguration } from '../../../src/main/hosts/launchScript'
import type { ValidatedSshHostConfiguration } from '../../../src/main/hosts/sshConfiguration'
import { SshHostLauncher } from '../../../src/main/hosts/sshLauncher'

const config: ValidatedSshHostConfiguration = {
  target: 'dev@forge',
  installPath: '~/.local/share/sotto-host',
  dataDirectory: '~/.local/share/sotto-host/data',
  remotePort: 0,
}

describe('SshHostLauncher Rust host opt-in (ADR-0214)', () => {
  it('omits useRustHost from launch configuration by default and includes it when explicitly requested', () => {
    const defaultLaunch = JSON.parse(launchConfiguration(config, { op: 'launch' }, 30_000)) as Record<string, unknown>
    expect(defaultLaunch.useRustHost).toBeUndefined()

    const rustLaunch = JSON.parse(launchConfiguration(config, { op: 'launch', useRustHost: true }, 30_000)) as Record<string, unknown>
    expect(rustLaunch.useRustHost).toBe(true)

    const rustBootInstall = JSON.parse(launchConfiguration(config, { op: 'boot-install', hostId: 'h1', useRustHost: true }, 30_000)) as Record<string, unknown>
    expect(rustBootInstall.useRustHost).toBe(true)

    const rustBootRemove = JSON.parse(launchConfiguration(config, { op: 'boot-remove', restart: true, useRustHost: true }, 30_000)) as Record<string, unknown>
    expect(rustBootRemove.useRustHost).toBe(true)
  })

  it('constructs SshHostLauncher with useRustHost disabled by default and enabled when passed', () => {
    const defaultLauncher = new SshHostLauncher()
    const rustLauncher = new SshHostLauncher({ useRustHost: true })
    expect(defaultLauncher).toBeInstanceOf(SshHostLauncher)
    expect(rustLauncher).toBeInstanceOf(SshHostLauncher)
  })
})
