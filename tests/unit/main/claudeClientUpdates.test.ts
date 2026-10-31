// @vitest-environment node
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { claudeManagedFolder, claudeReleaseChannel, ProviderClients, type RunLike } from '../../../src/main/agents/providerClients'
import { root } from '../../fixtures/providerClientInstallFixture'

const native = join(homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude')
const RELEASES = 'https://downloads.claude.ai/claude-code-releases'
/** Claude Code's own folder with the settings given, and no mise install whatever the developer's machine has. */
async function environment(settings?: unknown): Promise<NodeJS.ProcessEnv> {
  const folder = await root('sotto-claude-native-')
  const config = join(folder, 'claude')
  await mkdir(config, { recursive: true })
  if (settings !== undefined) await writeFile(join(config, 'settings.json'), typeof settings === 'string' ? settings : JSON.stringify(settings))
  return { CLAUDE_CONFIG_DIR: config, MISE_DATA_DIR: join(folder, 'mise'), PATH: '' }
}
/** An organisation's managed settings folder: empty unless a test writes one, whatever the developer's machine has. */
async function managed(files: Record<string, unknown> = {}): Promise<string> {
  const folder = join(await root('sotto-claude-managed-'), 'ClaudeCode')
  await mkdir(folder, { recursive: true })
  for (const [name, settings] of Object.entries(files)) {
    await mkdir(dirname(join(folder, name)), { recursive: true })
    await writeFile(join(folder, name), JSON.stringify(settings))
  }
  return folder
}
/** npm's `latest` ahead of the native feed's, as on October 30, 2026: 2.1.316 on npm, 2.1.314 on `latest`, 2.1.308 on `stable`. */
function feeds(asked: string[], channels: Record<string, string> = { latest: '2.1.314\n', stable: '2.1.308\n' }): (url: string) => Promise<Response> {
  return async url => {
    asked.push(url)
    if (url.startsWith('https://registry.npmjs.org/')) return new Response(JSON.stringify({ version: '2.1.316' }), { status: 200 })
    const channel = url.slice(RELEASES.length + 1)
    return channels[channel] === undefined ? new Response('', { status: 404 }) : new Response(channels[channel], { status: 200 })
  }
}

describe('Claude Code’s native install is checked against its own release feed (ADR-0042, ADR-0165)', () => {
  it('reads the channel its settings name, and latest when they name none or cannot be read', async () => {
    const none = await managed()
    expect(await claudeReleaseChannel(await environment({ autoUpdatesChannel: 'stable' }), none)).toBe('stable')
    expect(await claudeReleaseChannel(await environment({ autoUpdatesChannel: 'latest' }), none)).toBe('latest')
    expect(await claudeReleaseChannel(await environment({ model: 'opus' }), none)).toBe('latest')
    expect(await claudeReleaseChannel(await environment({ autoUpdatesChannel: 'nightly' }), none)).toBe('latest')
    expect(await claudeReleaseChannel(await environment('{ not json'), none)).toBe('latest')
    expect(await claudeReleaseChannel(await environment(), none)).toBe('latest')
  })

  it('lets managed settings name the channel over the user’s own, the last drop-in that names one winning', async () => {
    const user = await environment({ autoUpdatesChannel: 'latest' })
    expect(await claudeReleaseChannel(user, await managed({ 'managed-settings.json': { autoUpdatesChannel: 'stable' } }))).toBe('stable')
    expect(await claudeReleaseChannel(user, await managed({ 'managed-settings.json': { model: 'opus' } }))).toBe('latest')
    expect(await claudeReleaseChannel(user, await managed({
      'managed-settings.json': { autoUpdatesChannel: 'latest' },
      'managed-settings.d/10-channel.json': { autoUpdatesChannel: 'stable' },
      'managed-settings.d/20-other.json': { model: 'opus' },
      'managed-settings.d/30-notes.txt': { autoUpdatesChannel: 'latest' },
    }))).toBe('stable')
    const asked: string[] = []
    const clients = new ProviderClients({ fetchImpl: feeds(asked), claudeManagedFolder: await managed({ 'managed-settings.d/channel.json': { autoUpdatesChannel: 'stable' } }) })
    expect(await clients.check('claude', '2.1.314', native, user)).toMatchObject({ published: '2.1.308', behind: false })
    expect(asked).toEqual([`${RELEASES}/stable`])
  })

  it('reads managed settings where Claude Code documents them on each platform', () => {
    expect(claudeManagedFolder('win32')).toBe('C:\\Program Files\\ClaudeCode')
    expect(claudeManagedFolder('darwin')).toBe('/Library/Application Support/ClaudeCode')
    expect(claudeManagedFolder('linux')).toBe('/etc/claude-code')
  })

  it('offers no update when npm is ahead of the channel claude update installs from', async () => {
    const asked: string[] = []
    const clients = new ProviderClients({ fetchImpl: feeds(asked), claudeManagedFolder: await managed() })
    const reading = await clients.check('claude', '2.1.314', native, await environment({ autoUpdatesChannel: 'latest' }))
    expect(asked).toEqual([`${RELEASES}/latest`])
    expect(reading).toMatchObject({ installed: '2.1.314', published: '2.1.314', behind: false, channel: 'self-update', canInstall: false })
  })

  it('offers the channel’s version once it moves, and runs claude update for it', async () => {
    const asked: string[] = []
    const runs: { executable: string; args: readonly string[] }[] = []
    const run: RunLike = async (executable, args) => { runs.push({ executable, args }); return { ok: true } }
    const clients = new ProviderClients({ fetchImpl: feeds(asked, { latest: '2.1.316\n' }), run, claudeManagedFolder: await managed() })
    const settings = await environment()
    expect(await clients.check('claude', '2.1.314', native, settings)).toMatchObject({ published: '2.1.316', behind: true, channel: 'self-update', canInstall: true, command: 'claude update' })
    expect((await clients.install('claude', native, settings)).ok).toBe(true)
    expect(runs).toEqual([{ executable: native, args: ['update'] }])
  })

  it('follows the stable channel, and keeps its answer apart from latest’s', async () => {
    const asked: string[] = []
    const clients = new ProviderClients({ fetchImpl: feeds(asked), claudeManagedFolder: await managed() })
    expect(await clients.check('claude', '2.1.305', native, await environment({ autoUpdatesChannel: 'stable' }))).toMatchObject({ published: '2.1.308', behind: true })
    expect(await clients.check('claude', '2.1.305', native, await environment({ autoUpdatesChannel: 'latest' }))).toMatchObject({ published: '2.1.314', behind: true })
    expect(asked).toEqual([`${RELEASES}/stable`, `${RELEASES}/latest`])
  })

  it('claims nothing from a feed that does not answer with one version', async () => {
    for (const body of ['', '<html>Not found</html>', '2.1.316; rm -rf /', '9'.repeat(70)]) {
      const clients = new ProviderClients({ fetchImpl: async () => new Response(body, { status: 200 }), claudeManagedFolder: await managed() })
      const reading = await clients.check('claude', '2.1.314', native, await environment())
      expect(reading.behind).toBe(false)
      expect(reading.published).toBeUndefined()
    }
    const down = new ProviderClients({ fetchImpl: async () => { throw new Error('offline') }, claudeManagedFolder: await managed() })
    expect(await down.check('claude', '2.1.314', native, await environment())).toMatchObject({ behind: false, channel: 'self-update' })
  })
})
