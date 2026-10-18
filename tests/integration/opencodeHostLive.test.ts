// @vitest-environment node
/**
 * OpenCode 2 itself on a headless host (#1107, ADR-0087). Never in CI: it needs OpenCode 2 installed. Run with
 *
 *   SOTTO_OPENCODE_LIVE=1 SOTTO_OPENCODE_EXECUTABLE=<path to opencode 2> npx vitest run tests/integration/opencodeHostLive.test.ts
 *
 * The host's home is a scratch folder: HOME, USERPROFILE, APPDATA and LOCALAPPDATA point inside it, and OpenCode is copied
 * into its `~/.opencode/bin`, where the host looks first, so no OpenCode, data, config or sign-in of the user's is used.
 */
import { copyFile, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { expect, it } from 'vitest'
import { startHeadlessHost } from '../../src/host'
import { E2EAgentHost, e2eAgentReasoner } from '../../src/main/e2e/agentEffects'

const live = process.env.SOTTO_OPENCODE_LIVE === '1' && Boolean(process.env.SOTTO_OPENCODE_EXECUTABLE)

it.skipIf(!live)('runs Sotto’s OpenCode on a headless host in <dataDirectory>/opencode, and nowhere of the user’s', { timeout: 180_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'sotto-opencode-host-live-'))
  const home = join(root, 'home'), data = join(root, 'host')
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA }
  const executable = process.env.SOTTO_OPENCODE_EXECUTABLE!
  await mkdir(join(home, '.opencode', 'bin'), { recursive: true })
  await copyFile(executable, join(home, '.opencode', 'bin', basename(executable)))
  Object.assign(process.env, { HOME: home, USERPROFILE: home, APPDATA: join(home, 'AppData', 'Roaming'), LOCALAPPDATA: join(home, 'AppData', 'Local') })
  const host = await startHeadlessHost({ dataDirectory: data, sottoVersion: '0.1.37-owl.20261012.1', reasoner: e2eAgentReasoner,
    providers: { codex: new E2EAgentHost(), claude: new E2EAgentHost(), grok: new E2EAgentHost(), devin: new E2EAgentHost(), muse: new E2EAgentHost() } })
  try {
    await expect.poll(() => host.service.shell().host.providers?.find(provider => provider.id === 'opencode')?.connection, { timeout: 120_000, interval: 500 }).toBe('connected')
    const row = host.service.shell().host.providers!.find(provider => provider.id === 'opencode')!
    expect(row.version).toMatch(/2\.\d+\.\d+/u)
    expect(host.service.shell().host.models.some(model => model.providerId === 'opencode' && model.source === 'OpenCode Zen')).toBe(true)
    // OpenCode's database is in the host's own Sotto OpenCode folder, and its four XDG folders are there.
    expect(existsSync(join(data, 'opencode', 'data', 'opencode', 'opencode.db'))).toBe(true)
    expect((await readdir(join(data, 'opencode'))).sort()).toEqual(expect.arrayContaining(['cache', 'config', 'data', 'state']))
    // The user's own OpenCode folders under this home were never made.
    expect(existsSync(join(home, '.local', 'share', 'opencode'))).toBe(false)
    expect(existsSync(join(home, '.config', 'opencode'))).toBe(false)
  } finally {
    await host.close()
    Object.assign(process.env, saved)
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
