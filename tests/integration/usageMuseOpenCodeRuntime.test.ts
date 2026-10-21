// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createAgentRuntime } from '../../src/main/agents/runtime'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import { opencodeFixture } from '../fixtures/fakeOpenCodeFixture'
import { FakeProviderHost } from '../fixtures/fakeProviderHost'
import { museFixture } from '../fixtures/museFixture'
import { testCredentials } from '../fixtures/testCredentials'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

// The whole path through the coordinator: a send is saved before Muse or OpenCode runs it, its echo makes it an accepted
// prompt, and each model call's tokens land in the Usage store under the provider and the model that served them
// (ADR-0083, October 21, 2026). Muse's limits come back with Usage's read; OpenCode has none to read.
describe('Muse and OpenCode through the runtime', () => {
  it('counts their accepted prompts and tokens, reads Muse limits and none for OpenCode', async () => {
    const muse = await museFixture(undefined, 10_000, {}, { usageEnabled: true })
    cleanups.push(muse.cleanup)
    await muse.script({ reportUsage: true })
    const opencode = await opencodeFixture(undefined, 10_000, {}, { usageEnabled: true })
    cleanups.push(opencode.cleanup)
    const directory = join(muse.root, 'sotto'), projectPath = join(muse.root, 'project')
    await mkdir(projectPath, { recursive: true })
    const credentials = await testCredentials(join(directory, 'vault'), { mode: 'unavailable' })
    const settings = { ...DEFAULT_SETTINGS, threadTitles: false }
    const runtime = await createAgentRuntime({ directory, credentials, usageEnabled: true, heldProviders: new Set(), settings: () => settings,
      writingSettings: async () => settings, historyEnabled: () => true, openExternal: async () => undefined, reasoner: {},
      providers: { muse: muse.adapter, opencode: opencode.adapter, codex: new FakeProviderHost(), claude: new FakeProviderHost(), grok: new FakeProviderHost(), devin: new FakeProviderHost() } })
    cleanups.push(runtime.close)
    const control = runtime.agentControl
    for (const provider of ['muse', 'opencode'] as const) await control.commandShell({ type: 'connect', provider })

    const threads: Record<'muse' | 'opencode', string> = { muse: '', opencode: '' }
    for (const provider of ['muse', 'opencode'] as const) {
      await control.commandShell({ type: 'create-project', provider, title: `${provider} project`, path: projectPath, useExisting: true })
      const project = control.shell().host.projects.find(item => item.providerId === provider && item.path === projectPath)!
      const model = control.shell().host.models.find(item => item.providerId === provider && item.ready)!
      threads[provider] = randomUUID()
      expect((await control.commandShell({ type: 'create-thread', threadId: threads[provider], projectId: project.id, title: `${provider} thread`, modelId: model.id, workingCopy: 'shared' })).error).toBeNull()
      expect((await control.commandShell({ type: 'manual-send', threadId: threads[provider], draftId: randomUUID(), text: `Synthetic ${provider} prompt` })).error).toBeNull()
    }
    const sessionOf = (id: string): string => runtime.threadRegistry!.byThread(id)!.sessionId
    await muse.action(sessionOf(threads.muse), { type: 'complete', text: 'Synthetic Muse reply' })
    await opencode.driver.completeTurn(sessionOf(threads.opencode), 'Synthetic OpenCode reply')

    const counted = (provider: 'muse' | 'opencode') => async () => {
      await control.commandShell({ type: 'refresh' })
      const row = (await runtime.usage!.read()).activity?.providers.find(item => item.providerId === provider)
      return row ? [row.prompts.total, row.tokens.input.value, row.tokens.output.value] : undefined
    }
    await expect.poll(counted('muse'), { timeout: 20_000 }).toEqual([1, 100, 7])
    await expect.poll(counted('opencode'), { timeout: 20_000 }).toEqual([1, 14, 2])
    const read = await runtime.usage!.read()
    expect(read.persistence).toBe('saved')
    expect(read.activity!.models.filter(row => row.providerId === 'muse' || row.providerId === 'opencode')).toHaveLength(2)
    expect(read.quotas.map(quota => quota.providerId)).not.toContain('opencode')
    await expect.poll(async () => (await runtime.usage!.refresh(['muse'])).quotas[0], { timeout: 20_000 })
      .toMatchObject({ providerId: 'muse', status: 'available', windows: [{ kind: 'primary', usedPercent: 12 }, { kind: 'weekly', usedPercent: 47 }] })
    expect((await runtime.usage!.refresh(['opencode'])).quotas).toEqual([])
  })
})
