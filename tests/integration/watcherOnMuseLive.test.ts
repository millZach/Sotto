// @vitest-environment node
// SOTTO_MUSE_LIVE=1 npx vitest run tests/integration/watcherOnMuseLive.test.ts
// Opt-in only, never in CI, and it spends: one short Watcher turn on the installed, signed-in Muse, in a throwaway
// folder. Watcher is asked to list threads through its own tools and change nothing. Sotto's admission of its own tool is
// the only approval sent; anything else Muse asks is left for the person running the check, and the turn is stopped.
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { MuseMspHost } from '../../src/main/agents/muse'
import { MuseRpc } from '../../src/main/agents/museRpc'
import { createAgentRuntime } from '../../src/main/agents/runtime'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import { FakeProviderHost } from '../fixtures/fakeProviderHost'
import { testCredentials } from '../fixtures/testCredentials'

describe('requires SOTTO_MUSE_LIVE=1', () => {
  it.skipIf(process.env.SOTTO_MUSE_LIVE !== '1' || !!process.env.CI)('Watcher on the installed Muse lists threads through its own tools, admitted by Sotto, in one turn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-watcher-muse-live-')), directory = join(root, 'sotto')
    // At most one turn: a second turn/start is refused before it reaches Muse.
    let turns = 0
    const request = MuseRpc.prototype.request
    const budget = vi.spyOn(MuseRpc.prototype, 'request').mockImplementation(function (this: MuseRpc, method: string, params: unknown, timeoutMs?: number) {
      if (method === 'turn/start') { if (turns >= 1) return Promise.reject(new Error('live-turn-budget')); turns++ }
      return request.call(this, method, params, timeoutMs)
    })
    const adapter = new MuseMspHost(directory)
    const credentials = await testCredentials(join(directory, 'vault'), { mode: 'unavailable' })
    const settings = { ...DEFAULT_SETTINGS, historyEnabled: false, threadTitles: false, agentVisuals: false, babysitPullRequests: false }
    const runtime = await createAgentRuntime({ directory, credentials, watcherEnabled: true, museEnabled: true, settings: () => settings,
      writingSettings: async () => settings, historyEnabled: () => false, openExternal: async () => undefined, reasoner: {},
      providers: { muse: adapter, codex: new FakeProviderHost(), claude: new FakeProviderHost(), grok: new FakeProviderHost(), devin: new FakeProviderHost() } })
    // The person running the check answers nothing through Sotto here: an answer would be the harness's, not theirs.
    const execute = adapter.execute.bind(adapter)
    vi.spyOn(adapter, 'execute').mockImplementation(async command => {
      if (command.type === 'answer') throw new Error('live-answer-not-authorized')
      return execute(command)
    })
    const control = runtime.agentControl, service = runtime.watcher!
    const calls: { name: string; status: string }[] = []
    const invoke = service.invoke.bind(service)
    vi.spyOn(service, 'invoke').mockImplementation(async (id, name, args, context) => {
      const result = await invoke(id, name, args, context) as { status: string }
      calls.push({ name, status: result.status }); return result
    })
    let watcherId = ''
    try {
      await control.commandShell({ type: 'connect', provider: 'muse' })
      const model = control.shell().host.models.find(item => item.providerId === 'muse' && item.ready)
      if (!model) throw new Error('live-provider-unavailable')
      expect(await service.open({ provider: 'muse', modelId: model.id })).toMatchObject({ status: 'ok' })
      watcherId = service.state().current!.target.threadId
      await control.commandShell({ type: 'observe-threads', threadIds: [watcherId] })
      const sent = await control.commandShell({ type: 'manual-send', threadId: watcherId, draftId: randomUUID(),
        text: 'Call list_threads from sotto_threads once, then reply with how many threads it listed. Change nothing and call no other tool.' })
      expect(sent.error).toBeNull()
      await expect.poll(() => control.watcherSnapshot().threads.find(thread => thread.id === watcherId)?.lastTurn?.status,
        { timeout: 240_000, interval: 500 }).toBe('completed')
      // Watcher reached its own tool, and Sotto let the call through without a card for the user.
      expect(calls.some(call => call.name === 'list_threads' && call.status === 'ok')).toBe(true)
      expect(control.watcherSnapshot().threads.find(thread => thread.id === watcherId)?.requests ?? []).toEqual([])
      // The message shows as typed: Watcher's instructions and request note were the model's alone.
      expect(control.threadDetail(watcherId)?.messages.find(message => message.role === 'user')?.text).toMatch(/^Call list_threads/u)
      expect(turns).toBe(1)
      console.info(`Muse ${control.shell().host.providers?.find(provider => provider.id === 'muse')?.version ?? ''}: ${calls.map(call => `${call.name}:${call.status}`).join(', ')}`)
    } finally {
      if (watcherId && control.watcherSnapshot().threads.find(thread => thread.id === watcherId)?.status === 'running') {
        await control.commandShell({ type: 'interrupt', threadId: watcherId }).catch(() => undefined)
      }
      await runtime.close()
      budget.mockRestore()
      await rm(root, { recursive: true, force: true })
    }
  }, 300_000)
})
