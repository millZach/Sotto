// @vitest-environment node
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetCliLookup } from '../../../src/main/agents/cliLookup'
import { findMuseExecutable } from '../../../src/main/agents/museRpc'
import { museInstallForExecutable, museMakerInstall, museNativeBinary, museVersionForExecutable } from '../../../src/main/agents/museClientInstall'
import { detectClientInstall } from '../../../src/main/agents/providerClients'

let root: string, home: string, empty: string
beforeEach(async () => {
  resetCliLookup()
  root = await realpath(await mkdtemp(join(tmpdir(), 'sotto-muse-discovery-')))
  home = join(root, 'home'); empty = join(root, 'empty')
  await mkdir(home); await mkdir(empty)
})
afterEach(async () => { resetCliLookup(); await rm(root, { recursive: true, force: true }) })

const VERSION = '1.4.7-R6101.1'
async function native(path: string, platform: NodeJS.Platform): Promise<string> {
  const head = Buffer.alloc(256)
  if (platform === 'win32') { head.write('MZ'); head.writeUInt32LE(128, 60); head.write('PE\0\0', 128, 'latin1') }
  else head.writeUInt32BE(platform === 'darwin' ? 0xcffaedfe : 0x7f454c46)
  await writeFile(path, head); await chmod(path, 0o755)
  return path
}
async function maker(directory: string, platform: NodeJS.Platform, version = VERSION): Promise<string> {
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, '.muse-version'), `${version}\n`)
  for (const name of platform === 'win32' ? ['muse.cmd', '.muse-launcher.ps1'] : ['muse']) await writeFile(join(directory, name), '#!/bin/bash\nexit 99\n')
  return native(join(directory, `muse-bin-${version}${platform === 'win32' ? '.exe' : ''}`), platform)
}
const lookup = (platform: NodeJS.Platform) => ({ home, platform, loginShellPath: async () => undefined })

describe('Muse native discovery', () => {
  it('finds the official Windows layout outside PATH and starts its PE binary', async () => {
    const local = join(root, 'local')
    const binary = await maker(join(local, 'Programs', 'muse'), 'win32')
    expect(await findMuseExecutable({ PATH: empty, LOCALAPPDATA: local }, lookup('win32'))).toBe(binary)
    expect(await museMakerInstall(join(local, 'Programs', 'muse'), 'win32')).toMatchObject({ executable: binary, version: VERSION, channel: 'muse-stable' })
  })

  it.each(['linux', 'darwin'] as const)('resolves the %s launcher without executing it', async platform => {
    const binary = await maker(join(home, '.local', 'bin'), platform)
    expect(await findMuseExecutable({ PATH: empty }, lookup(platform))).toBe(binary)
  })

  it('prefers an explicit maker directory, then PATH, while the default stays behind managers on Windows', async () => {
    const custom = join(root, 'chosen')
    const wanted = await maker(custom, 'win32')
    const pathDirectory = join(root, 'path'); await mkdir(pathDirectory)
    const pathBinary = await native(join(pathDirectory, 'muse.exe'), 'win32')
    const local = join(root, 'local'); await maker(join(local, 'Programs', 'muse'), 'win32')
    expect(await findMuseExecutable({ PATH: pathDirectory, LOCALAPPDATA: local, MUSE_INSTALL_DIR: custom }, lookup('win32'))).toBe(wanted)
    expect(await findMuseExecutable({ PATH: pathDirectory, LOCALAPPDATA: local }, lookup('win32'))).toBe(pathBinary)
    const data = join(root, 'manager')
    const managedDirectory = join(data, 'installs', 'muse', 'latest', 'bin'); await mkdir(managedDirectory, { recursive: true })
    const managed = await native(join(managedDirectory, 'muse.exe'), 'win32')
    expect(await findMuseExecutable({ PATH: empty, LOCALAPPDATA: local, MISE_DATA_DIR: data }, lookup('win32'))).toBe(managed)
  })

  it.each(['../../outside', '1.4.7-R6101.1/other', '1.4.7', 'x'.repeat(130)])('refuses a malformed version record %s without falling back to its wrapper', async version => {
    const directory = join(home, '.local', 'bin')
    await maker(directory, 'linux')
    await writeFile(join(directory, '.muse-version'), version)
    expect(await findMuseExecutable({ PATH: directory }, lookup('linux'))).toBeUndefined()
  })

  it('refuses a stale record, incomplete maker layout, and batch file renamed as an exe', async () => {
    const directory = join(root, 'muse'); await maker(directory, 'win32')
    await rm(join(directory, `muse-bin-${VERSION}.exe`))
    expect(await museMakerInstall(directory, 'win32')).toBeUndefined()
    await writeFile(join(directory, `muse-bin-${VERSION}.exe`), '@echo off\r\nwsl muse %*')
    expect(await museMakerInstall(directory, 'win32')).toBeUndefined()
    await native(join(directory, `muse-bin-${VERSION}.exe`), 'win32')
    await rm(join(directory, '.muse-launcher.ps1'))
    expect(await museMakerInstall(directory, 'win32')).toBeUndefined()
  })

  it('rejects shell, WSL and manager wrappers instead of starting them', async () => {
    await writeFile(join(empty, 'muse.exe'), '@echo off\r\nwsl muse %*')
    await writeFile(join(empty, 'muse'), '#!/bin/bash\nexec mise x muse -- muse "$@"\n'); await chmod(join(empty, 'muse'), 0o755)
    expect(await museNativeBinary(join(empty, 'muse.exe'), 'win32')).toBeUndefined()
    expect(await museNativeBinary(join(empty, 'muse'), 'linux')).toBeUndefined()
  })

  it('keeps a maker custom root as its own install, but never grants ownership to an arbitrary native copy', async () => {
    const binary = await maker(join(root, 'custom'), process.platform)
    expect(await detectClientInstall('muse', binary, {})).toMatchObject({ channel: 'self-update', muse: { directory: join(root, 'custom') } })
    const copy = await native(join(empty, process.platform === 'win32' ? 'muse.exe' : 'muse'), process.platform)
    expect(await detectClientInstall('muse', copy, {})).toEqual({ channel: 'unknown' })
    expect(await museVersionForExecutable(binary, '1.4.7')).toBe(VERSION)
    expect(await museVersionForExecutable(binary, '1.4.6')).toBeUndefined()
    expect(await museVersionForExecutable(copy, '1.4.7')).toBeUndefined()
    expect(await museInstallForExecutable(binary, process.platform, { MUSE_CHANNEL: 'muse-canary' })).toMatchObject({ channel: 'muse-canary' })
    expect(await museInstallForExecutable(binary, process.platform, { MUSE_CHANNEL: '../private' })).toBeUndefined()
  })

  it('preserves mise ownership ahead of a maker-looking versioned layout', async () => {
    const data = join(root, 'mise')
    const directory = join(data, 'installs', 'muse', '1.4.7')
    const binary = await maker(directory, process.platform)
    await writeFile(join(data, 'installs', 'muse', '.mise.backend.toml'), 'short = "aqua:meta-models/muse"\n')
    expect(await detectClientInstall('muse', binary, { MISE_DATA_DIR: data })).toEqual({ channel: 'mise', miseTool: 'aqua:meta-models/muse' })
  })
})
