// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { startHeadlessHost } from '../../src/host'
import { desktopWindowClient } from '../../src/main/agents/hostService'
import { E2EAgentHost, e2eAgentReasoner } from '../../src/main/e2e/agentEffects'
import { publicProviderEntityId, type ProviderId } from '../../src/shared/agents'
import { codexFixture } from '../fixtures/codexFixture'
import { claudeFixture } from '../fixtures/claudeFixture'
import { grokFixture } from '../fixtures/fakeGrokThreadFixture'
import { devinFixture } from '../fixtures/devinFixture'
import { describeHostServiceContract, type AdapterFixture, type AdapterSessionOptions, type HostServiceFixture } from './adapterContract'

/** Provider IDs remain inside the fixture driver; every tested client operation uses HostService. */
async function hostFixture(provider: ProviderId, native: AdapterFixture): Promise<HostServiceFixture> {
  const providers = { codex: new E2EAgentHost(), claude: new E2EAgentHost(), grok: new E2EAgentHost(), devin: new E2EAgentHost(), [provider]: native.host }
  const host = await startHeadlessHost({ dataDirectory: native.root, providers, reasoner: e2eAgentReasoner })
  await host.service.command({ type: 'configure', patch: { enabledProviders: [provider], provider } }, desktopWindowClient('host-contract'))
  const binding = async (threadId: string): Promise<string | undefined> => {
    let text: string
    try { text = await readFile(join(native.root, 'threads.json'), 'utf8') }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
    const registry = JSON.parse(text) as { bindings: { threadId: string; sessionId: string }[] }
    return registry.bindings.find(item => item.threadId === threadId)?.sessionId
  }
  const session = async (threadId: string): Promise<string> => {
    const id = await binding(threadId)
    if (!id) throw new Error('The test thread has not started its native session.')
    return id
  }
  return {
    service: host.service, provider, root: native.root, modelId: publicProviderEntityId(provider, 'model', native.modelId),
    nativeStarted: async threadId => (await binding(threadId)) !== undefined,
    ...(native.protocol ? { protocol: native.protocol } : {}),
    ...(native.skips ? { skips: native.skips } : {}),
    ...(native.sessions ? { sessions: {
      starts: async threadId => native.sessions!.starts(await session(threadId)),
      stopped: async threadId => native.sessions!.stopped(await session(threadId)),
    } } : {}),
    driver: {
      typeInProvider: async (id, text) => native.driver.typeInProvider(await session(id), text),
      completeTurn: async (id, text) => native.driver.completeTurn(await session(id), text),
      raiseQuestion: async (id, text) => native.driver.raiseQuestion(await session(id), text),
      raisePermission: async (id, text) => native.driver.raisePermission(await session(id), text),
      delayNextAck: method => native.driver.delayNextAck(method),
      requests: () => native.driver.requests(),
      restart: async () => { await host.close(); return hostFixture(provider, await native.driver.restart()) },
    },
    cleanup: async () => { await host.close(); await native.cleanup() },
  }
}

const fixtures: { provider: ProviderId; create: (session?: AdapterSessionOptions) => Promise<AdapterFixture> }[] = [
  { provider: 'codex', create: session => codexFixture(undefined, false, undefined, session) },
  { provider: 'claude', create: session => claudeFixture(undefined, undefined, undefined, session) },
  { provider: 'grok', create: session => grokFixture(undefined, undefined, undefined, session) },
  { provider: 'devin', create: session => devinFixture(undefined, undefined, undefined, session) },
]
for (const fixture of fixtures) describeHostServiceContract('Headless ' + fixture.provider, async session => hostFixture(fixture.provider, await fixture.create(session)))

describe('a Claude thread whose host stopped before any read reached its first send', () => {
  it('holds its first message once after the restart (#765)', async () => {
    // No poll of the transcript runs during the case, and the coordinator no longer reads the thread after Claude
    // accepts a send when the echo is already held, so nothing has recorded how far the transcript was read.
    let f = await hostFixture('claude', await claudeFixture(undefined, undefined, undefined, { pollIntervalMs: 600_000 }))
    try {
      const client = desktopWindowClient('restart-before-read')
      const command = (value: Parameters<typeof f.service.command>[0]) => f.service.command(value, client)
      expect((await command({ type: 'connect', provider: 'claude' })).error).toBeNull()
      const created = await command({ type: 'create-project', provider: 'claude', title: 'Project', path: f.root, useExisting: true })
      const projectId = created.host.projects.find(project => project.path === f.root)!.id
      const threadId = randomUUID()
      expect((await command({ type: 'create-thread', threadId, projectId, title: 'Thread', modelId: f.modelId, workingCopy: 'shared' })).error).toBeNull()
      await command({ type: 'observe-threads', threadIds: [threadId] })
      const thread = () => f.service.state().host.threads.find(item => item.id === threadId)!
      expect((await command({ type: 'manual-send', threadId, text: 'First prompt' })).error).toBeNull()
      const before = thread().messages
      expect(before.map(message => message.text)).toEqual(['First prompt'])
      f = await f.driver.restart()
      await command({ type: 'observe-threads', threadIds: [threadId] })
      await command({ type: 'connect', provider: 'claude' })
      // The restarted adapter reads the transcript from its first byte, and finds the prompt already held.
      await expect.poll(() => thread()?.messages.length ?? 0).toBeGreaterThan(0)
      expect(thread().messages).toEqual(before)
      expect(f.service.events(0, threadId).filter(event => event.event.kind === 'message-added')).toHaveLength(1)
    } finally { await f.cleanup() }
  }, 60_000)
})
