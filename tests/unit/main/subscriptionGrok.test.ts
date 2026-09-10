// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { GrokSubscriptionClient } from '../../../src/main/agents/subscriptionGrok'

const directories: string[] = []

async function fixture(installed = false) {
  const directory = await mkdtemp(join(tmpdir(), 'sotto-grok-route-'))
  directories.push(directory)
  const nativeHome = join(directory, 'native-home')
  await mkdir(join(nativeHome, 'bin'), { recursive: true })
  vi.stubEnv('GROK_HOME', nativeHome)
  vi.stubEnv('PATH', '')
  if (installed) await writeFile(join(nativeHome, 'bin', process.platform === 'win32' ? 'grok.exe' : 'grok'), 'Fixture executable metadata only', { mode: 0o755 })
  return { directory, nativeHome, client: new GrokSubscriptionClient(join(directory, 'isolated')) }
}

afterEach(async () => {
  vi.unstubAllEnvs()
  for (const directory of directories.splice(0)) {
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !directory.includes('sotto-grok-route-')) throw new Error('Unexpected Grok fixture directory')
    await rm(directory, { recursive: true, force: true })
  }
})

describe('Grok subscription containment gate', () => {
  it('distinguishes a missing CLI without offering an inferred model or account', async () => {
    const { client } = await fixture()
    expect(await client.status()).toMatchObject({ provider: 'grok', installed: false, ready: false, models: [] })
    expect((await client.status()).detail).toMatch(/CLI was not found/u)
  })

  it('reports an installed CLI as unavailable and leaves native auth/configuration unchanged', async () => {
    const { client, nativeHome } = await fixture(true)
    const auth = join(nativeHome, 'auth.json')
    const configuration = join(nativeHome, 'config.toml')
    await writeFile(auth, 'fixture-native-login-canary')
    await writeFile(configuration, '[model.grok-build]\napi_key = "fixture-api-key-canary"\n')
    const status = await client.status()
    expect(status).toMatchObject({ provider: 'grok', installed: true, ready: false, models: [] })
    expect(status.detail).toMatch(/not available in this build/u)
    expect(status.detail).toMatch(/sign-in has not been checked/u)
    expect(JSON.stringify(status)).not.toMatch(/canary/u)
    expect(await readFile(auth, 'utf8')).toBe('fixture-native-login-canary')
    expect(await readFile(configuration, 'utf8')).toBe('[model.grok-build]\napi_key = "fixture-api-key-canary"\n')
  })

  it('rejects inference before inspecting the private prompt or selecting an API fallback', async () => {
    const { client } = await fixture(true)
    vi.stubEnv('XAI_API_KEY', 'fixture-env-key-canary')
    const input = { toJSON() { throw new Error('The unavailable route must not serialize private input') } }
    await expect(client.complete('Private system instructions', input, 'grok-build')).rejects.toThrow(/subscription reasoning is not available/u)
    expect((await client.status()).ready).toBe(false)
  })

  it('does not resolve shell wrappers or relative PATH entries as a native installation', async () => {
    const { client, directory } = await fixture()
    const wrappers = join(directory, 'wrappers')
    await mkdir(wrappers)
    await writeFile(join(wrappers, 'grok.cmd'), '@echo fixture')
    await writeFile(join(wrappers, 'grok.ps1'), 'Write-Output fixture')
    vi.stubEnv('PATH', wrappers)
    expect((await client.status()).installed).toBe(false)
    vi.stubEnv('PATH', '.')
    expect((await client.status()).installed).toBe(false)
  })
})
