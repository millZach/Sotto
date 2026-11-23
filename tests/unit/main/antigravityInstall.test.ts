import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AntigravityRuntime, antigravityRuntimeFolder, describeAntigravityProgress, leaseAntigravityRuntime, managedAntigravityExecutable, removeDownloadedAntigravity, systemTar,
  type AntigravityInstallProgress,
} from '../../../src/main/agents/antigravityInstall'
import {
  ANTIGRAVITY_CLI_FLOOR, ANTIGRAVITY_MANIFEST_BASE, antigravityTarget, compareAntigravityVersions, meetsAntigravityFloor, parseAntigravityRelease,
} from '../../../src/main/agents/antigravityRelease'
import { detectClientInstall, ProviderClients } from '../../../src/main/agents/providerClients'
import { defaultSignInCommand } from '../../../src/host/providerSignIn'
import { E2EAgentHost } from '../../../src/main/e2e/agentEffects'
import type { AgentHostSnapshot, ProviderId } from '../../../src/shared/agents'
import { createAgentControl } from '../../fixtures/agentControlFixture'
import { immediatePublishScheduler } from '../../fixtures/publishScheduler'
import { testCredentials } from '../../fixtures/testCredentials'

const sha512 = (bytes: Buffer): string => createHash('sha512').update(bytes).digest('hex')
const windowsUrl = (version: string): string => `https://storage.googleapis.com/antigravity-public/antigravity-cli/${version}-4021/windows-x64/cli_windows_x64.exe`
const linuxUrl = (version: string): string => `https://storage.googleapis.com/antigravity-public/antigravity-cli/${version}-4021/linux-x64/cli_linux_x64.tar.gz`
const program = (version: string): Buffer => Buffer.from(`fake agy ${version}\n`)

/** A fetch that answers the manifest and the downloads it is given, and records every address it was asked for. */
function fakeGoogle() {
  const files = new Map<string, () => Response>()
  const asked: string[] = []
  let manifest: unknown
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
    asked.push(url)
    expect(init?.redirect).toBe('error')
    if (url.startsWith(`${ANTIGRAVITY_MANIFEST_BASE}/`)) return new Response(JSON.stringify(manifest), { status: 200 })
    const file = files.get(url)
    return file ? file() : new Response('missing', { status: 404 })
  })
  return {
    fetchImpl, asked,
    publish(version: string, url: string, bytes: Buffer, checksum = sha512(bytes)) {
      manifest = { version, url, sha512: checksum.toUpperCase() }
      files.set(url, () => new Response(new Uint8Array(bytes), { status: 200 }))
    },
    serve(url: string, answer: () => Response) { files.set(url, answer) },
  }
}

let directory: string
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'sotto-antigravity-install-')) })
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

const windowsRuntime = (fetchImpl: ReturnType<typeof fakeGoogle>['fetchImpl']): AntigravityRuntime =>
  new AntigravityRuntime({ directory, fetchImpl, platform: 'win32', arch: 'x64', freeBytes: async () => undefined })
const versionsOf = async (platform: NodeJS.Platform = 'win32'): Promise<string[]> =>
  (await readdir(join(antigravityRuntimeFolder(directory, platform, 'x64'), 'versions')).catch(() => [] as string[])).sort()

describe('Google\'s Antigravity manifest', () => {
  it('names each platform as the manifest does', () => {
    expect(antigravityTarget({ platform: 'win32', arch: 'arm64' })).toBe('windows_arm64')
    expect(antigravityTarget({ platform: 'darwin', arch: 'arm64' })).toBe('darwin_arm64')
    expect(antigravityTarget({ platform: 'linux', arch: 'x64', musl: true })).toBe('linux_amd64_musl')
    expect(antigravityTarget({ platform: 'freebsd', arch: 'x64' })).toBeUndefined()
  })

  it('accepts only the Google Storage download for this platform', () => {
    const sha = 'a'.repeat(128)
    expect(parseAntigravityRelease({ version: '1.5.12', url: windowsUrl('1.5.12'), sha512: sha }, { platform: 'win32', arch: 'x64' }))
      .toMatchObject({ version: '1.5.12', executable: 'agy.exe', format: 'executable' })
    expect(parseAntigravityRelease({ version: '1.5.12', url: linuxUrl('1.5.12'), sha512: sha }, { platform: 'linux', arch: 'x64' }))
      .toMatchObject({ executable: 'antigravity', format: 'tar.gz' })
    // Another platform's file, another version's folder, and another host are all refused.
    expect(parseAntigravityRelease({ version: '1.5.12', url: linuxUrl('1.5.12'), sha512: sha }, { platform: 'win32', arch: 'x64' })).toBeUndefined()
    expect(parseAntigravityRelease({ version: '1.5.13', url: windowsUrl('1.5.12'), sha512: sha }, { platform: 'win32', arch: 'x64' })).toBeUndefined()
    expect(parseAntigravityRelease({ version: '1.5.12', url: windowsUrl('1.5.12').replace('storage.googleapis.com', 'storage.example.com'), sha512: sha }, { platform: 'win32', arch: 'x64' })).toBeUndefined()
  })

  it('holds the 1.5.0 floor', () => {
    expect(ANTIGRAVITY_CLI_FLOOR).toBe('1.5.0')
    expect(compareAntigravityVersions('1.5.12', '1.5.9')).toBeGreaterThan(0)
    expect(meetsAntigravityFloor('1.5.0')).toBe(true)
    expect(meetsAntigravityFloor('1.4.99')).toBe(false)
  })
})

describe('the Antigravity Sotto downloads', () => {
  it('installs a good download and makes it the one new sessions start', async () => {
    const google = fakeGoogle()
    google.publish('1.5.12', windowsUrl('1.5.12'), program('1.5.12'))
    const phases: AntigravityInstallProgress['phase'][] = []
    const result = await windowsRuntime(google.fetchImpl).install({ onProgress: progress => { phases.push(progress.phase) } })
    expect(result).toMatchObject({ ok: true, version: '1.5.12', downloaded: true })
    const executable = await managedAntigravityExecutable(directory, 'win32', 'x64')
    expect(executable).toBe(join(antigravityRuntimeFolder(directory, 'win32', 'x64'), 'versions', '1.5.12', 'agy.exe'))
    expect(await readFile(executable!)).toEqual(program('1.5.12'))
    expect(phases).toEqual(expect.arrayContaining(['checking', 'downloading', 'verifying', 'extracting', 'activating']))
    expect(await versionsOf()).toEqual(['1.5.12'])
    expect(describeAntigravityProgress({ phase: 'downloading', version: '1.5.12', downloadedBytes: 3 * 1024 * 1024 })).toBe('Downloading Antigravity 1.5.12: 3 MB so far.')
  })

  it('refuses a download whose SHA-512 is not the one Google published, and activates nothing', async () => {
    const google = fakeGoogle()
    google.publish('1.5.12', windowsUrl('1.5.12'), program('1.5.12'), sha512(Buffer.from('something else')))
    const result = await windowsRuntime(google.fetchImpl).install()
    expect(result).toMatchObject({ ok: false, failure: 'download' })
    expect(result.ok ? '' : result.detail).toMatch(/did not match the checksum Google published/u)
    expect(await managedAntigravityExecutable(directory, 'win32', 'x64')).toBeUndefined()
    expect(await versionsOf()).toEqual([])
  })

  it('refuses a manifest that names a download anywhere but Google Storage, without fetching it', async () => {
    const google = fakeGoogle()
    const elsewhere = 'https://downloads.example.com/antigravity-public/antigravity-cli/1.5.12-4021/windows-x64/cli_windows_x64.exe'
    google.publish('1.5.12', elsewhere, program('1.5.12'))
    const result = await windowsRuntime(google.fetchImpl).install()
    expect(result).toMatchObject({ ok: false, failure: 'download' })
    expect(google.asked).not.toContain(elsewhere)
    expect(await managedAntigravityExecutable(directory, 'win32', 'x64')).toBeUndefined()
  })

  it('keeps a version a running thread leases through an update and a removal, and removes it when the thread lets go', async () => {
    const google = fakeGoogle()
    const runtime = windowsRuntime(google.fetchImpl)
    google.publish('1.5.12', windowsUrl('1.5.12'), program('1.5.12'))
    const first = await runtime.install()
    if (!first.ok) throw new Error(first.detail)
    const release = leaseAntigravityRuntime(first.executable)
    google.publish('1.5.13', windowsUrl('1.5.13'), program('1.5.13'))
    expect(await runtime.install()).toMatchObject({ ok: true, version: '1.5.13' })
    expect(await versionsOf()).toEqual(['1.5.12', '1.5.13'])
    expect(await runtime.remove()).toEqual({ removed: ['1.5.13'], kept: ['1.5.12'] })
    expect(await managedAntigravityExecutable(directory, 'win32', 'x64')).toBeUndefined()
    expect(existsSync(first.executable)).toBe(true)
    release()
    await vi.waitFor(async () => { expect(await versionsOf()).toEqual([]) })
  })

  it('leaves the old version active when an update is cancelled mid-download', async () => {
    const google = fakeGoogle()
    const runtime = windowsRuntime(google.fetchImpl)
    google.publish('1.5.12', windowsUrl('1.5.12'), program('1.5.12'))
    expect(await runtime.install()).toMatchObject({ ok: true })
    const before = await managedAntigravityExecutable(directory, 'win32', 'x64')
    google.publish('1.5.13', windowsUrl('1.5.13'), program('1.5.13'))
    // A download that sends one chunk and then waits until it is cancelled.
    google.serve(windowsUrl('1.5.13'), () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(1024)) },
    }), { status: 200 }))
    const running = runtime.install({ onProgress: progress => { if (progress.phase === 'downloading' && progress.downloadedBytes) runtime.cancel() } })
    expect(await running).toEqual({ ok: false, failure: 'cancelled', detail: 'The Antigravity install was cancelled. Nothing was changed.' })
    expect(await managedAntigravityExecutable(directory, 'win32', 'x64')).toBe(before)
    expect(await versionsOf()).toEqual(['1.5.12'])
    expect(runtime.installing).toBe(false)
  })
})

/** A gzipped tar holding the given files, written by hand so the test needs nothing but Node. */
function tarGz(files: Readonly<Record<string, Buffer>>): Buffer {
  const blocks: Buffer[] = []
  for (const [name, data] of Object.entries(files)) {
    const header = Buffer.alloc(512)
    header.write(name, 0, 'utf8')
    header.write('0000755\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116)
    header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124)
    header.write('00000000000\0', 136)
    header.write('        ', 148)
    header.write('0', 156)
    header.write('ustar\0', 257); header.write('00', 263)
    let sum = 0
    for (const byte of header) sum += byte
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148)
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512))
  }
  blocks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(blocks))
}

describe('Remove downloaded on Antigravity\'s row', () => {
  const removing = (kept: string[] = []) => ({ remove: async () => ({ removed: ['1.5.13'], kept }) })
  it('disconnects Antigravity when no other agy is left to start, rather than keep a path that is gone', async () => {
    const disconnect = vi.fn(async () => undefined)
    const said = await removeDownloadedAntigravity(removing(), { clientUpdated: async () => { throw new Error('gone') } }, disconnect)
    expect(disconnect).toHaveBeenCalledOnce()
    expect(said).toBe('Removed the Antigravity Sotto downloaded. Sotto found no other agy, so Antigravity is disconnected. Your threads are kept. Install Antigravity again to connect it.')
  })
  it('stays connected when threads move to another agy, or a running thread still holds the removed one', async () => {
    const disconnect = vi.fn(async () => undefined)
    await removeDownloadedAntigravity(removing(), { clientUpdated: async () => undefined }, disconnect)
    await removeDownloadedAntigravity(removing(['1.5.13']), { clientUpdated: async () => { throw new Error('gone') } }, disconnect)
    expect(disconnect).not.toHaveBeenCalled()
  })
})

describe('unpacking with this computer\'s tar', () => {
  const linuxRuntime = (fetchImpl: ReturnType<typeof fakeGoogle>['fetchImpl']): AntigravityRuntime =>
    new AntigravityRuntime({ directory, fetchImpl, platform: 'linux', arch: 'x64', musl: async () => false, tar: systemTar(), freeBytes: async () => undefined })

  it('takes the one program out of a macOS or Linux archive', async () => {
    const google = fakeGoogle()
    google.publish('1.5.12', linuxUrl('1.5.12'), tarGz({ antigravity: program('1.5.12') }))
    expect(await linuxRuntime(google.fetchImpl).install()).toMatchObject({ ok: true, version: '1.5.12' })
    const executable = await managedAntigravityExecutable(directory, 'linux', 'x64')
    expect(executable?.endsWith('antigravity')).toBe(true)
    expect(await readFile(executable!)).toEqual(program('1.5.12'))
  })

  it('refuses an archive holding anything besides the program', async () => {
    const google = fakeGoogle()
    google.publish('1.5.12', linuxUrl('1.5.12'), tarGz({ antigravity: program('1.5.12'), 'extra.sh': Buffer.from('echo hi\n') }))
    const result = await linuxRuntime(google.fetchImpl).install()
    expect(result).toMatchObject({ ok: false, failure: 'installer' })
    expect(await managedAntigravityExecutable(directory, 'linux', 'x64')).toBeUndefined()
    expect(await versionsOf('linux')).toEqual([])
  })
})

describe('Antigravity in the client update flow', () => {
  it('reads the newest version from Google\'s manifest and updates only the copy Sotto downloaded', async () => {
    const google = fakeGoogle()
    const runtime = windowsRuntime(google.fetchImpl)
    google.publish('1.5.12', windowsUrl('1.5.12'), program('1.5.12'))
    const first = await runtime.install()
    if (!first.ok) throw new Error(first.detail)
    google.publish('1.5.13', windowsUrl('1.5.13'), program('1.5.13'))
    const clients = new ProviderClients({ fetchImpl: google.fetchImpl, antigravity: runtime, platform: 'win32' })
    const managed = await clients.check('antigravity', '1.5.12', first.executable)
    expect(managed).toMatchObject({ published: '1.5.13', behind: true, channel: 'self-update', canInstall: true, steps: 1 })
    const own = await clients.check('antigravity', '1.5.12', join(directory, 'elsewhere', 'agy.exe'))
    expect(own).toMatchObject({ behind: true, channel: 'unknown', canInstall: false })
    const steps: number[] = []
    expect(await clients.install('antigravity', first.executable, process.env, step => { steps.push(step) })).toEqual({ ok: true, detail: 'Antigravity is now 1.5.13.' })
    expect(steps).toEqual([1])
    expect(await managedAntigravityExecutable(directory, 'win32', 'x64')).toMatch(/1\.5\.13[\\/]agy\.exe$/u)
  })

  it('updates a standalone agy in Google’s default folder via `agy update`, without downloading a managed copy (#2842)', async () => {
    const google = fakeGoogle()
    google.publish('1.5.15', linuxUrl('1.5.15'), tarGz({ antigravity: program('1.5.15') }))
    const runtime = new AntigravityRuntime({ directory, fetchImpl: google.fetchImpl, platform: 'linux', arch: 'x64', musl: async () => false, freeBytes: async () => undefined })
    const home = join(directory, 'home')
    const agy = join(home, '.local', 'bin', 'agy')
    await mkdir(join(home, '.local', 'bin'), { recursive: true })
    await writeFile(agy, 'fake\n')
    const ran: { executable: string; args: readonly string[]; env: NodeJS.ProcessEnv | undefined }[] = []
    const clients = new ProviderClients({
      fetchImpl: google.fetchImpl, antigravity: runtime, platform: 'linux',
      run: async (executable, args, _asNode, options) => { ran.push({ executable, args, env: options?.environment }); return { ok: true } },
    })
    const environment = { HOME: home, AGY_CLI_DISABLE_AUTO_UPDATE: '1', PATH: join(home, '.local', 'bin') }
    const reading = await clients.check('antigravity', '1.5.14', agy, environment)
    expect(reading).toMatchObject({ installed: '1.5.14', published: '1.5.15', behind: true, channel: 'self-update', command: 'agy update', byHand: ['agy update'], steps: 1, canInstall: true })
    const steps: number[] = []
    expect(await clients.install('antigravity', agy, environment, step => { steps.push(step) }, '1.5.15')).toEqual({ ok: true })
    expect(steps).toEqual([1])
    expect(ran).toEqual([{ executable: agy, args: ['update'], env: expect.objectContaining({ HOME: home }) }])
    expect(ran[0]!.env).not.toHaveProperty('AGY_CLI_DISABLE_AUTO_UPDATE')
    expect(await managedAntigravityExecutable(directory, 'linux', 'x64')).toBeUndefined()
  })

  it('detects Google’s Windows standalone install folder and refuses manager-owned symlinks (#2842)', async () => {
    const home = join(directory, 'win-home')
    const localAppData = join(home, 'AppData', 'Local')
    const winAgy = join(localAppData, 'agy', 'bin', 'agy.exe')
    expect(await detectClientInstall('antigravity', winAgy, { USERPROFILE: home, LOCALAPPDATA: localAppData }, 'win32')).toEqual({ channel: 'self-update' })
    expect(await detectClientInstall('antigravity', join(directory, 'custom', 'agy.exe'), { USERPROFILE: home, LOCALAPPDATA: localAppData }, 'win32')).toEqual({ channel: 'unknown' })
    if (process.platform !== 'win32') {
      const brewTarget = join(directory, 'homebrew', 'bin', 'agy')
      const linkDir = join(home, '.local', 'bin')
      await mkdir(join(directory, 'homebrew', 'bin'), { recursive: true })
      await mkdir(linkDir, { recursive: true })
      await writeFile(brewTarget, 'fake\n')
      await symlink(brewTarget, join(linkDir, 'agy'))
      expect(await detectClientInstall('antigravity', join(linkDir, 'agy'), { HOME: home }, 'linux')).toEqual({ channel: 'unknown' })
    }
  })

  it('queues and completes a standalone Antigravity update through AgentControl’s client update line (#2842)', async () => {
    const google = fakeGoogle()
    const runtime = new AntigravityRuntime({ directory, fetchImpl: google.fetchImpl, platform: process.platform, arch: process.arch, musl: async () => false, freeBytes: async () => undefined })
    const os = process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'windows' : 'linux'
    const folder = `${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch === 'arm64' ? 'arm' : 'x64'}`
    const ext = process.platform === 'win32' ? 'exe' : 'tar.gz'
    const cpu = process.arch === 'x64' ? 'x64' : 'arm64'
    const hostUrl = `https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.15-4021/${folder}/cli_${os}_${cpu}.${ext}`
    const payload = process.platform === 'win32' ? program('1.5.15') : tarGz({ antigravity: program('1.5.15') })
    google.publish('1.5.15', hostUrl, payload)
    const agy = join(homedir(), '.local', 'bin', process.platform === 'win32' ? 'sotto-test-agy.exe' : 'sotto-test-agy')
    class AntigravityHost extends E2EAgentHost {
      installed = '1.5.14'
      onDisk = '1.5.14'
      private decorate(snapshot: AgentHostSnapshot): AgentHostSnapshot {
        return { ...snapshot, providers: [{ id: 'antigravity', name: 'Antigravity', connection: snapshot.connected ? 'connected' : 'disconnected', version: `${this.installed} / ACP 1`, capabilities: snapshot.capabilities }] }
      }
      override async connect(): Promise<AgentHostSnapshot> { return this.decorate(await super.connect()) }
      override async snapshot(): Promise<AgentHostSnapshot> { return this.decorate(await super.snapshot()) }
      async clientUpdated(provider: ProviderId): Promise<void> { if (provider === 'antigravity') this.installed = this.onDisk }
    }
    const host = new AntigravityHost()
    const ran: (readonly string[])[] = []
    const clients = new ProviderClients({
      fetchImpl: google.fetchImpl, antigravity: runtime,
      run: async (executable, args) => { ran.push([executable, ...args]); host.onDisk = '1.5.15'; return { ok: true } },
    })
    const credentials = await testCredentials(join(directory, 'vault'), { mode: 'plain' })
    const control = createAgentControl({
      schedule: immediatePublishScheduler, directory, host, credentials, clients,
      locateClient: async provider => provider === 'antigravity' ? agy : undefined,
      reasoner: {},
    })
    await control.start()
    try {
      await control.command({ type: 'connect' })
      await control.command({ type: 'check-client-updates' })
      expect(control.get().clientUpdates).toEqual([expect.objectContaining({ id: 'antigravity', installed: '1.5.14', published: '1.5.15', behind: true, channel: 'self-update', command: 'agy update', canInstall: true })])
      const queued = await control.command({ type: 'queue-client-updates', providers: ['antigravity'] })
      expect(queued.error).toBeNull()
      await vi.waitFor(() => { expect(control.get().clientUpdates).toEqual([expect.objectContaining({ id: 'antigravity', installed: '1.5.15', behind: false, state: 'updated' })]) })
      expect(ran).toEqual([[agy, 'update']])
    } finally { control.dispose() }
  })

  it('keeps a version a paste-code sign-in command leases across removal until its release runs', async () => {
    const google = fakeGoogle()
    const runtime = new AntigravityRuntime({ directory, fetchImpl: google.fetchImpl, tar: systemTar(), freeBytes: async () => undefined })
    const os = process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'windows' : 'linux'
    const folder = `${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch === 'arm64' ? 'arm' : 'x64'}`
    const ext = process.platform === 'win32' ? 'exe' : 'tar.gz'
    const cpu = process.arch === 'x64' ? 'x64' : 'arm64'
    const hostUrl = `https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.12-4021/${folder}/cli_${os}_${cpu}.${ext}`
    const payload = process.platform === 'win32' ? program('1.5.12') : tarGz({ antigravity: program('1.5.12') })
    google.publish('1.5.12', hostUrl, payload)
    const installed = await runtime.install()
    if (!installed.ok) throw new Error(installed.detail)
    const command = await defaultSignInCommand('antigravity', undefined, undefined, directory)
    expect(command?.executable).toBe(installed.executable)
    expect(command?.release).toBeTypeOf('function')
    expect(await runtime.remove()).toEqual({ removed: [], kept: ['1.5.12'] })
    expect(existsSync(installed.executable)).toBe(true)
    command!.release!()
    const versionsDir = join(antigravityRuntimeFolder(directory), 'versions')
    await vi.waitFor(async () => { expect(await readdir(versionsDir).catch(() => [])).toEqual([]) })
  })
})
