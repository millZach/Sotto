// @vitest-environment node
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createAgentRuntime } from '../../../src/main/agents/runtime'
import { UsageStore } from '../../../src/main/agents/usageStore'
import { DEFAULT_SETTINGS } from '../../../src/shared/settings'
import { FakeProviderHost } from '../../fixtures/fakeProviderHost'
import { testCredentials } from '../../fixtures/testCredentials'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'sotto-usage-runtime-'))
  cleanup.push(async () => {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-usage-runtime-')) throw new Error('Unexpected test directory')
    await rm(root, { recursive: true, force: true })
  })
  const credentials = await testCredentials(root, { mode: 'unavailable' })
  const runtime = async (usageEnabled: boolean) => {
    const host = await createAgentRuntime({ directory: root, credentials, host: new FakeProviderHost(), reasoner: {}, usageEnabled,
      settings: () => DEFAULT_SETTINGS, writingSettings: async () => DEFAULT_SETTINGS, historyEnabled: () => false, openExternal: async () => undefined })
    cleanup.push(() => host.close())
    return host
  }
  return { root, runtime }
}

describe('Usage Owl runtime ownership', () => {
  it('opens no Usage store in stable and preserves dormant Owl figures byte for byte', async () => {
    const f = await fixture()
    const path = join(f.root, 'usage.sqlite')
    const store = new UsageStore(path)
    store.open()
    store.observeTokens({ providerId: 'codex', threadId: 'thread-1', modelId: 'native-model',
      recordKey: createHash('sha256').update('request').digest('hex'), tokens: { input: 100, output: 20 }, phase: 'seed', partial: false })
    store.close()
    const before = await readFile(path)
    const stable = await f.runtime(false)
    expect(stable.usage).toBeUndefined()
    expect(stable.hostService.supportsUsage).toBe(false)
    await stable.close()
    expect(await readFile(path)).toEqual(before)
    const owl = await f.runtime(true)
    expect(owl.hostService.supportsUsage).toBe(true)
    expect((await owl.usage!.read()).activity!.totals.tokens.total.value).toBe(120)
    await owl.close()
  })
})
