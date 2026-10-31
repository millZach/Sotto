// @vitest-environment node
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { claudeReleaseChannel, ProviderClients, type RunLike } from '../../../src/main/agents/providerClients'
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
    expect(await claudeReleaseChannel(await environment({ autoUpdatesChannel: 'stable' }))).toBe('stable')
    expect(await claudeReleaseChannel(await environment({ autoUpdatesChannel: 'latest' }))).toBe('latest')
    expect(await claudeReleaseChannel(await environment({ model: 'opus' }))).toBe('latest')
    expect(await claudeReleaseChannel(await environment({ autoUpdatesChannel: 'nightly' }))).toBe('latest')
    expect(await claudeReleaseChannel(await environment('{ not json'))).toBe('latest')
    expect(await claudeReleaseChannel(await environment())).toBe('latest')
  })

  it('offers no update when npm is ahead of the channel claude update installs from', async () => {
    const asked: string[] = []
    const clients = new ProviderClients({ fetchImpl: feeds(asked) })
    const reading = await clients.check('claude', '2.1.314', native, await environment({ autoUpdatesChannel: 'latest' }))
    expect(asked).toEqual([`${RELEASES}/latest`])
    expect(reading).toMatchObject({ installed: '2.1.314', published: '2.1.314', behind: false, channel: 'self-update', canInstall: false })
  })

  it('offers the channel’s version once it moves, and runs claude update for it', async () => {
    const asked: string[] = []
    const runs: { executable: string; args: readonly string[] }[] = []
    const run: RunLike = async (executable, args) => { runs.push({ executable, args }); return { ok: true } }
    const clients = new ProviderClients({ fetchImpl: feeds(asked, { latest: '2.1.316\n' }), run })
    const settings = await environment()
    expect(await clients.check('claude', '2.1.314', native, settings)).toMatchObject({ published: '2.1.316', behind: true, channel: 'self-update', canInstall: true, command: 'claude update' })
    expect((await clients.install('claude', native, settings)).ok).toBe(true)
    expect(runs).toEqual([{ executable: native, args: ['update'] }])
  })

  it('follows the stable channel, and keeps its answer apart from latest’s', async () => {
    const asked: string[] = []
    const clients = new ProviderClients({ fetchImpl: feeds(asked) })
    expect(await clients.check('claude', '2.1.305', native, await environment({ autoUpdatesChannel: 'stable' }))).toMatchObject({ published: '2.1.308', behind: true })
    expect(await clients.check('claude', '2.1.305', native, await environment({ autoUpdatesChannel: 'latest' }))).toMatchObject({ published: '2.1.314', behind: true })
    expect(asked).toEqual([`${RELEASES}/stable`, `${RELEASES}/latest`])
  })

  it('claims nothing from a feed that does not answer with one version', async () => {
    for (const body of ['', '<html>Not found</html>', '2.1.316; rm -rf /', `${'9'.repeat(70)}`]) {
      const clients = new ProviderClients({ fetchImpl: async () => new Response(body, { status: 200 }) })
      const reading = await clients.check('claude', '2.1.314', native, await environment())
      expect(reading.behind).toBe(false)
      expect(reading.published).toBeUndefined()
    }
    const down = new ProviderClients({ fetchImpl: async () => { throw new Error('offline') } })
    expect(await down.check('claude', '2.1.314', native, await environment())).toMatchObject({ behind: false, channel: 'self-update' })
  })
})
