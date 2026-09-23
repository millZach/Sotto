// @vitest-environment node
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
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
