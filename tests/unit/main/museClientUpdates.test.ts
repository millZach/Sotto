// @vitest-environment node
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { compareMuseVersions, installMuseClient, museByHand, museMakerInstall, museResponseText, type MuseMakerInstall } from '../../../src/main/agents/museClientInstall'
import { ProviderClients, type RunOptions } from '../../../src/main/agents/providerClients'

let root: string
beforeEach(async () => { root = await realpath(await mkdtemp(join(tmpdir(), 'sotto-muse-update-test-'))) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
const oldVersion = '1.4.7-R6100.1', nextVersion = '1.4.7-R6101.1'
const feed = (channel = 'muse-stable', version = nextVersion): Response => new Response(JSON.stringify({ channel, version }), { status: 200 })
async function maker(platform: NodeJS.Platform = process.platform): Promise<MuseMakerInstall> {
  const directory = join(root, 'maker'); await mkdir(directory, { recursive: true })
  await writeFile(join(directory, '.muse-version'), oldVersion)
  for (const name of platform === 'win32' ? ['muse.cmd', '.muse-launcher.ps1'] : ['muse']) await writeFile(join(directory, name), '#!/bin/bash\nexit 1\n')
  const executable = join(directory, `muse-bin-${oldVersion}${platform === 'win32' ? '.exe' : ''}`)
  const head = Buffer.alloc(256)
  if (platform === 'win32') { head.write('MZ'); head.writeUInt32LE(128, 60); head.write('PE\0\0', 128, 'latin1') } else head.writeUInt32BE(0x7f454c46)
  await writeFile(executable, head); await chmod(executable, 0o755)
  return (await museMakerInstall(directory, platform))!
}

describe('Muse release checks', () => {
  it('compares native builds when known, semantic versions alone when MSP only knows those, and rejects guesses', () => {
    expect(compareMuseVersions(oldVersion, nextVersion)).toBe(-1)
    expect(compareMuseVersions('1.4.7-R6101', '1.4.7-R6101.0')).toBe(0)
    expect(compareMuseVersions('1.4.7', nextVersion)).toBe(0)
    expect(compareMuseVersions('1.4.6', nextVersion)).toBe(-1)
    expect(compareMuseVersions('1.4.7 / MSP 1', nextVersion)).toBeUndefined()
    expect(compareMuseVersions('fixture', nextVersion)).toBeUndefined()
  })

  it('caches each fixed channel separately and honors the maker canary record', async () => {
    const install = await maker()
    await writeFile(join(install.directory, '.muse-channel'), 'muse-canary\n')
    let now = 1_000
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(init?.redirect).toBe('error'); expect(init?.signal).toBeDefined()
      return feed(url.endsWith('muse-canary') ? 'muse-canary' : 'muse-stable')
    })
    const clients = new ProviderClients({ fetchImpl, now: () => now })
    expect(await clients.check('muse', oldVersion, install.executable, {})).toMatchObject({ installed: oldVersion, published: nextVersion, behind: true, channel: 'self-update', canInstall: true })
    await clients.check('muse', oldVersion, install.executable, {})
    expect(await clients.check('muse', '1.4.7', install.executable, {})).toMatchObject({ installed: '1.4.7', behind: false, canInstall: false })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://api.meta.ai/muse-code/channels/muse-canary')
    await clients.publishedVersion('muse')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    now += 60 * 60 * 1_000 + 1
    await clients.publishedVersion('muse', 'muse-canary')
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it.each([
    'not JSON', JSON.stringify({ channel: 'muse-canary', version: nextVersion }),
    JSON.stringify({ channel: 'muse-stable', version: `${nextVersion}\n` }),
    JSON.stringify({ channel: 'muse-stable', version: '../../install.exe' }), 'x'.repeat(16 * 1024 + 1),
  ])('treats an unreadable or mismatched feed as unknown', async body => {
    const clients = new ProviderClients({ fetchImpl: async () => new Response(body) })
    expect(await clients.publishedVersion('muse')).toBeUndefined()
  })

  it('does not choose an endpoint from an untyped channel or a returned manifest URL', async () => {
    const fetchImpl = vi.fn(async () => feed())
    const clients = new ProviderClients({ fetchImpl })
    expect(await clients.publishedVersion('muse', '../private' as 'muse-stable')).toBeUndefined()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('honors the configured canary feed for a manager or unknown install and claims no published version for a malformed channel', async () => {
    const fetchImpl = vi.fn(async (url: string) => { expect(url).toContain('muse-canary'); return feed('muse-canary') })
    const clients = new ProviderClients({ fetchImpl })
    expect(await clients.check('muse', '1.4.6', join(root, 'copy'), { MUSE_CHANNEL: 'muse-canary' })).toMatchObject({ published: nextVersion, behind: true, canInstall: false })
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://api.meta.ai/muse-code/channels/muse-canary')
    expect(await clients.check('muse', '1.4.6', join(root, 'copy'), { MUSE_CHANNEL: '../../other' })).not.toHaveProperty('published')
    expect(fetchImpl).toHaveBeenCalledOnce()
    await writeFile(join(root, '.muse-channel'), 'x'.repeat(129))
    expect(await clients.check('muse', '1.4.6', join(root, 'copy'), {})).not.toHaveProperty('published')
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('cancels an oversized streaming body while reading it', async () => {
    const cancelled = vi.fn()
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(20)); }, cancel: cancelled })
    expect(await museResponseText(new Response(stream), 10)).toBeUndefined()
    expect(cancelled).toHaveBeenCalledOnce()
  })

  it('uses semantic comparison without claiming an unverified native build for an ordinary copy', async () => {
    const clients = new ProviderClients({ fetchImpl: async () => feed() })
    expect(await clients.check('muse', '1.4.7', join(root, 'copy'), {})).toMatchObject({ installed: '1.4.7', behind: false, canInstall: false, channel: 'unknown' })
    expect(await clients.check('muse', '1.4.6', join(root, 'copy'), {})).toMatchObject({ behind: true, canInstall: false, channel: 'unknown' })
  })
})

describe('Muse maker updates', () => {
  it('keeps manual retry in the same directory and channel, quotes names literally, and never truncates a long path', async () => {
    const install = await maker()
    const directory = join(root, "an install's $name")
    expect(museByHand({ ...install, directory, channel: 'muse-canary' }, 'win32')).toEqual([
      `$env:MUSE_INSTALL_DIR = '${directory.replace(/'/gu, "''")}'`, "$env:MUSE_CHANNEL = 'muse-canary'",
      "$env:MUSE_UPGRADE_MODE = '1'; $env:MUSE_NO_MODIFY_PATH = '1'; $env:MUSE_LOGIN = '0'", 'irm https://dev.meta.ai/install.ps1 | iex',
    ])
    expect(museByHand({ ...install, directory: '/home/name/install\'s' }, 'linux')?.[0]).toBe('export MUSE_INSTALL_DIR=\'/home/name/install\'"\'"\'s\'')
    expect(museByHand({ ...install, directory: 'x'.repeat(300) }, 'win32')).toBeUndefined()
  })

  it.each(['win32', 'linux'] as const)('runs the fixed %s installer in the same maker directory, excludes override/key variables, and cleans it', async platform => {
    const install = await maker(platform)
    const environment = { PATH: '/kept', HOME: root, SystemRoot: join(root, 'Windows'), MUSE_LAUNCHER_URL: 'https://other.invalid', META_API_KEY: 'secret', MUSE_CHANNEL: 'bad', MUSE_INSTALL_DIR: 'other', MUSE_LOGIN: '1' }
    let file = ''
    const result = await installMuseClient({ ...install, channel: 'muse-canary' }, environment, {
      platform,
      fetchImpl: async (url, init) => { expect(url).toBe(platform === 'win32' ? 'https://dev.meta.ai/install.ps1' : 'https://dev.meta.ai/install.sh'); expect(init?.redirect).toBe('error'); return new Response('verified fixture script') },
      run: async (executable, args, env) => {
        file = args.at(-1)!
        expect(await readFile(file, 'utf8')).toBe('verified fixture script')
        expect(executable).toBe(platform === 'win32' ? join(root, 'Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : '/bin/bash')
        if (platform === 'win32') expect(args.slice(0, -1)).toEqual(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File'])
        else expect(args).toEqual([file])
        expect(env).toEqual({ PATH: '/kept', HOME: root, SystemRoot: join(root, 'Windows'), MUSE_INSTALL_DIR: install.directory, MUSE_CHANNEL: 'muse-canary', MUSE_UPGRADE_MODE: '1', MUSE_NO_MODIFY_PATH: '1', MUSE_LOGIN: '0' })
        return { ok: true }
      },
    })
    expect(result).toEqual({ ok: true })
    expect(await stat(dirname(file)).catch(() => undefined)).toBeUndefined()
    expect(environment.MUSE_INSTALL_DIR).toBe('other'); expect(environment.MUSE_LOGIN).toBe('1')
  })

  it('keeps the restricted Muse environment when the default runner starts a real installer child', async () => {
    const install = await maker(), output = join(root, 'installer-environment.txt')
    const parent = {
      SOTTO_MUSE_UPDATE_PARENT_SECRET: 'fixture-parent-secret', META_API_KEY: 'fixture-parent-key',
      MUSE_LAUNCHER_URL: 'https://parent-fixture.invalid', MUSE_LOGIN: '1', MUSE_NO_MODIFY_PATH: '0',
    }
    const environment = {
      HOME: root, ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot ?? process.env.SYSTEMROOT } : {}),
      META_API_KEY: 'fixture-caller-key', MUSE_LAUNCHER_URL: 'https://caller-fixture.invalid',
      MUSE_INSTALL_DIR: 'caller-override', MUSE_CHANNEL: 'muse-canary', MUSE_LOGIN: '1', MUSE_NO_MODIFY_PATH: '0',
    }
    const before = { ...environment }
    // The child records only presence flags and the installer's fixed, non-secret settings.
    const script = process.platform === 'win32' ? [
      "$ErrorActionPreference = 'Stop'",
      '$observed = @(',
      "  (Test-Path Env:SOTTO_MUSE_UPDATE_PARENT_SECRET).ToString().ToLowerInvariant()",
      "  (Test-Path Env:META_API_KEY).ToString().ToLowerInvariant()",
      "  (Test-Path Env:MUSE_LAUNCHER_URL).ToString().ToLowerInvariant()",
      '  $env:MUSE_INSTALL_DIR', '  $env:MUSE_CHANNEL', '  $env:MUSE_UPGRADE_MODE', '  $env:MUSE_NO_MODIFY_PATH', '  $env:MUSE_LOGIN', ')',
      `[System.IO.File]::WriteAllLines('${output.replace(/'/gu, "''")}', [string[]]$observed)`,
    ].join('\n') : [
      'set -eu', '{',
      '  if [ "${SOTTO_MUSE_UPDATE_PARENT_SECRET+x}" = x ]; then printf "true\\n"; else printf "false\\n"; fi',
      '  if [ "${META_API_KEY+x}" = x ]; then printf "true\\n"; else printf "false\\n"; fi',
      '  if [ "${MUSE_LAUNCHER_URL+x}" = x ]; then printf "true\\n"; else printf "false\\n"; fi',
      '  printf "%s\\n" "$MUSE_INSTALL_DIR" "$MUSE_CHANNEL" "$MUSE_UPGRADE_MODE" "$MUSE_NO_MODIFY_PATH" "$MUSE_LOGIN"',
      `} > '${output.replace(/'/gu, "'\"'\"'")}'`,
    ].join('\n')
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe(process.platform === 'win32' ? 'https://dev.meta.ai/install.ps1' : 'https://dev.meta.ai/install.sh')
      return new Response(script)
    })
    for (const [key, value] of Object.entries(parent)) vi.stubEnv(key, value)
    try {
      const result = await new ProviderClients({ fetchImpl }).install('muse', install.executable, environment)
      expect(result.ok).toBe(true)
      expect(fetchImpl).toHaveBeenCalledOnce()
      const [parentSecretPresent, apiKeyPresent, launcherOverridePresent, installDirectory, channel, upgradeMode, noModifyPath, login]
        = (await readFile(output, 'utf8')).trimEnd().split(/\r?\n/u)
      expect({ parentSecretPresent, apiKeyPresent, launcherOverridePresent, installDirectory, channel, upgradeMode, noModifyPath, login }).toEqual({
        parentSecretPresent: 'false', apiKeyPresent: 'false', launcherOverridePresent: 'false', installDirectory: install.directory,
        channel: 'muse-canary', upgradeMode: '1', noModifyPath: '1', login: '0',
      })
      for (const [key, value] of Object.entries(parent)) expect(process.env[key]).toBe(value)
      expect(environment).toEqual(before)
    } finally { vi.unstubAllEnvs() }
  })

  it('does not run an installer after a failed or oversized download', async () => {
    const install = await maker()
    const run = vi.fn(async () => ({ ok: true }))
    for (const response of [new Response('', { status: 503 }), new Response('x'.repeat(256 * 1024 + 1))]) {
      expect(await installMuseClient(install, {}, { fetchImpl: async () => response, run })).toMatchObject({ ok: false, failure: 'download' })
    }
    expect(run).not.toHaveBeenCalled()
  })

  it('keeps installer failures distinct and removes its temporary script when the runner rejects', async () => {
    const install = await maker(); let file = ''
    expect(await installMuseClient(install, {}, { fetchImpl: async () => new Response('fixture script'), run: async (_executable, args) => {
      file = args.at(-1)!; throw new Error('runner failed')
    } })).toMatchObject({ ok: false, failure: 'installer' })
    expect(await stat(file).catch(() => undefined)).toBeUndefined()
  })

  it('routes ProviderClients through this installer, leaves an unknown install alone, and never runs muse update', async () => {
    const install = await maker()
    const fetched: string[] = [], optionsSeen: RunOptions[] = []
    const run = vi.fn(async (_executable: string, args: readonly string[], _asNode?: boolean, options?: RunOptions) => {
      expect(args).not.toContain('update'); optionsSeen.push(options!)
      return { ok: false, detail: 'fixture refused', printed: 'fixture error' }
    })
    const clients = new ProviderClients({ fetchImpl: async url => { fetched.push(url); return new Response('fixture script') }, run })
    expect(await clients.install('muse', install.executable, {})).toMatchObject({ ok: false, detail: 'fixture refused', failure: 'installer', step: 1 })
    expect(fetched).toEqual([process.platform === 'win32' ? 'https://dev.meta.ai/install.ps1' : 'https://dev.meta.ai/install.sh'])
    expect(optionsSeen[0]?.environment?.MUSE_INSTALL_DIR).toBe(install.directory)
    expect(await clients.install('muse', join(root, 'copy'), {})).toMatchObject({ ok: false, detail: 'Sotto does not know how Muse was installed, so it will not replace it.' })
    expect(run).toHaveBeenCalledOnce()
  })
})
