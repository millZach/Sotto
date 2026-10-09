// @vitest-environment node
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { releasePlatformProfile } from '../../../scripts/release-platform-profile.mjs'

const temporaryRoots: string[] = []

const posix = (value: string): string => value.replaceAll('\\', '/')

const posixValues = (environment: Readonly<Record<string, string>>): Record<string, string> =>
  Object.fromEntries(Object.entries(environment).map(([key, value]) => [key, posix(value)]))

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'sotto-release-profile-'))
  temporaryRoots.push(root)
  return root
}

describe('release platform profile', () => {
  it('locates the Windows unpacked layout', () => {
    const profile = releasePlatformProfile('win32')

    expect(profile.key).toBe('win32')
    expect(profile.packagedDirName).toBe('win-unpacked')
    expect(profile.executableLabel).toBe('Sotto.exe')
    expect(profile.distributableLabel).toBe('installer')
    expect(posix(profile.applicationRoot('release/win-unpacked'))).toBe('release/win-unpacked')
    expect(posix(profile.executablePath('release/win-unpacked'))).toBe('release/win-unpacked/Sotto.exe')
    expect(posix(profile.resourcesPath('release/win-unpacked'))).toBe('release/win-unpacked/resources')
    expect(posix(profile.licenseRoot('release/win-unpacked'))).toBe('release/win-unpacked')
  })

  it('locates the macOS application bundle layout', () => {
    const profile = releasePlatformProfile('darwin')

    expect(profile.key).toBe('darwin')
    expect(profile.packagedDirName).toBe('mac-arm64')
    expect(profile.executableLabel).toBe('Sotto.app')
    expect(profile.distributableLabel).toBe('disk image')
    expect(posix(profile.applicationRoot('release/mac-arm64'))).toBe('release/mac-arm64/Sotto.app')
    expect(posix(profile.executablePath('release/mac-arm64')))
      .toBe('release/mac-arm64/Sotto.app/Contents/MacOS/Sotto')
    expect(posix(profile.resourcesPath('release/mac-arm64')))
      .toBe('release/mac-arm64/Sotto.app/Contents/Resources')
    expect(posix(profile.licenseRoot('release/mac-arm64')))
      .toBe('release/mac-arm64/Sotto.app/Contents/Resources')
  })

  it('names the packaged directory after the requested architecture', () => {
    expect(releasePlatformProfile('darwin', 'x64').packagedDirName).toBe('mac-x64')
  })

  it('prepares a sandboxed Windows smoke profile', async () => {
    const root = await temporaryRoot()

    const environment = await releasePlatformProfile('win32').smokeEnvironment(root)

    expect(posixValues(environment)).toEqual({
      APPDATA: `${posix(root)}/AppData/Roaming`,
      LOCALAPPDATA: `${posix(root)}/AppData/Local`,
    })
    await expect(stat(join(root, 'AppData', 'Roaming'))).resolves.toBeDefined()
    await expect(stat(join(root, 'AppData', 'Local'))).resolves.toBeDefined()
  })

  it('prepares a sandboxed macOS home with the Library directories the app expects', async () => {
    const root = await temporaryRoot()

    const environment = await releasePlatformProfile('darwin').smokeEnvironment(root)

    expect(posixValues(environment)).toEqual({ HOME: `${posix(root)}/Home` })
    await expect(stat(join(root, 'Home', 'Library', 'Application Support'))).resolves.toBeDefined()
    await expect(stat(join(root, 'Home', 'Library', 'Caches'))).resolves.toBeDefined()
  })

  it('refuses to guess a layout for an unsupported platform', () => {
    expect(() => releasePlatformProfile('freebsd')).toThrow(/win32, darwin and linux only/u)
  })

  it('locates the Linux executable, resources and licenses without a bundle', () => {
    const profile = releasePlatformProfile('linux')
    expect(profile.packagedDirName).toBe('linux-unpacked')
    expect(profile.executableLabel).toBe('sotto')
    expect(profile.distributableLabel).toBe('tarball')
    expect(posix(profile.executablePath('release/linux-unpacked'))).toBe('release/linux-unpacked/sotto')
    expect(posix(profile.resourcesPath('release/linux-unpacked'))).toBe('release/linux-unpacked/resources')
    expect(profile.licenseRoot('release/linux-unpacked')).toBe('release/linux-unpacked')
  })

  it('isolates the Linux home, XDG config and password store for both smoke probes', async () => {
    const root = await temporaryRoot()
    const profile = releasePlatformProfile('linux')
    expect(posixValues(await profile.smokeEnvironment(root))).toEqual({
      HOME: `${posix(root)}/Home`, XDG_CONFIG_HOME: `${posix(root)}/Home/.config`,
    })
    expect(profile.smokeArgs).toEqual(['--password-store=basic'])
    expect(releasePlatformProfile('win32').smokeArgs).toEqual([])
    expect(releasePlatformProfile('darwin').smokeArgs).toEqual(['--use-mock-keychain'])
    await expect(stat(join(root, 'Home', '.config'))).resolves.toBeDefined()
  })
})
