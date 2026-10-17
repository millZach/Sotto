import { windowThreadShellFixture } from './windowThreadShell'
import { StreamingAdapter } from './streamingAdapter'
import { AgentControl } from '../../src/main/agents/control'
import { ConfiguredProviderHost } from '../../src/main/agents/providerSwitch'
import { SottoThreadHost, ThreadRegistry } from '../../src/main/agents/threads'
import { WorkspaceHost } from '../../src/main/agents/workspace'
import { e2eAgentReasoner } from '../../src/main/e2e/agentEffects'
import type { AgentActivity } from '../../src/shared/agentActivity'
import { EMPTY_AGENT_HOST, type AgentHostSnapshot, type AgentThread } from '../../src/shared/agents'
import { FakeProviderHost } from './fakeProviderHost'
import { syntheticModelCatalog } from './modelCatalog'
import { testCredentials } from './testCredentials'
import { join } from 'node:path'

export const STREAMING_ROUNDS = 3
export const STREAMING_CHUNKS = 180
export const STREAMING_CHUNK_GAP_MS = 2
export const STREAMING_ACTIVITY_EVERY = 25
export const STREAMING_ACTIVITY_BYTES = 400

const PUBLISHED_ARCHIVE = { threads: 50, records: 400, outputBytes: 1_000 }
const UNREAD_ARCHIVE = { threads: 4, records: 1_100, outputBytes: 2_600 }
const EMPTY_THREADS = 150


export function records(prefix: string, count: number, outputBytes: number): AgentActivity[] {
  return Array.from({ length: count }, (_, position): AgentActivity => ({
    id: `${prefix}-a${position}`, turnId: `${prefix}-t${Math.floor(position / 4)}`, sequence: position, kind: 'command', status: 'completed',
    title: `Synthetic command ${position}`, output: `${prefix}:${position}:`.padEnd(outputBytes, 'o'),
  }))
}

function thread(sessionId: string, title: string, activities?: AgentActivity[]): AgentThread {
  return { id: sessionId, projectId: 'project', title, modelId: 'fake:model', status: 'idle', messages: [], requests: [], ...(activities ? { activities } : {}) }
}

/** `withActivity` is false for the measured run, where the unread archive's adapter has not read its records yet. */
function adapterStates(root: string, withActivity: boolean, streamCount: number): { claude: AgentHostSnapshot; codex: AgentHostSnapshot } {
  const base = (provider: string): AgentHostSnapshot => ({
    ...structuredClone(EMPTY_AGENT_HOST), name: provider, version: '1', connected: true,
    capabilities: { ...structuredClone(EMPTY_AGENT_HOST.capabilities), projects: true, threads: true, submit: true, observe: true },
    projects: Array.from({length:provider==='claude'?41:2},(_,i)=>({id:i===0?'project':`project-${i}`,title:`Synthetic project ${i}`,path:join(root,provider,`project-${i}`)})),
    models: [{ id: 'fake:model', provider: 'Fake', name: 'Synthetic model', ready: true }], threads: [],
  })
  const claude = base('claude'), codex = base('codex')
  claude.models = [...claude.models, ...syntheticModelCatalog(873)]
  for(let i=0;i<streamCount;i++) claude.threads.push(thread(`stream-${i}`, `Streaming thread ${i}`))
  for (let index = 0; index < PUBLISHED_ARCHIVE.threads; index++) {
    claude.threads.push(thread(`published-${index}`, `Published ${index}`, records(`published-${index}`, PUBLISHED_ARCHIVE.records, PUBLISHED_ARCHIVE.outputBytes)))
  }
  for (let index = 0; index < EMPTY_THREADS - streamCount; index++) claude.threads.push(thread(`empty-${index}`, `Empty ${index}`))
  for (let index = 0; index < UNREAD_ARCHIVE.threads; index++) {
    codex.threads.push(thread(`unread-${index}`, `Unread ${index}`, withActivity ? records(`unread-${index}`, UNREAD_ARCHIVE.records, UNREAD_ARCHIVE.outputBytes) : undefined))
  }
  const shaped = windowThreadShellFixture().host.threads
  for(const host of [claude,codex]) for(const [i,item] of host.threads.entries()) { const shape=shaped[i]!; item.worktree=shape.worktree; item.usage=shape.usage; const project=i%host.projects.length; item.projectId=project===0?'project':`project-${project}` }
  return { claude, codex }
}

export async function stack(root: string, withActivity: boolean, streamCount: number, watcherEnabled = false) {
  const registry = new ThreadRegistry(root)
  await registry.load()
  const states = adapterStates(root, withActivity, streamCount)
  const adapters = { claude: new StreamingAdapter(states.claude), codex: new StreamingAdapter(states.codex) }
  const native = new ConfiguredProviderHost({ directory: root, provider: () => 'claude', enabledProviders: () => ['claude', 'codex'],
    threadProvider: id => registry.byThread(id)?.provider,
    hosts: { claude: new SottoThreadHost('claude', adapters.claude, registry), codex: new SottoThreadHost('codex', adapters.codex, registry),
      grok: new FakeProviderHost(), devin: new FakeProviderHost(), muse: new FakeProviderHost(structuredClone(EMPTY_AGENT_HOST)), opencode: new FakeProviderHost(structuredClone(EMPTY_AGENT_HOST)) } })
  const workspace = new WorkspaceHost(native, root, () => true, undefined,
    watcherEnabled, /* museEnabled */ false, /* streamingPublishCostEnabled */ true)
  await workspace.initialize()
  const credentials = await testCredentials(root, { mode: 'unavailable' })
  const control = new AgentControl({ directory: root, host: workspace, credentials, reasoner: e2eAgentReasoner, watcherEnabled, streamingPublishCost: true })
  await control.start()
  await control.command({ type: 'connect' })
  const stop = async () => { control.dispose(); workspace.disconnect(); await workspace.privacyChanged(); await registry.flush(); workspace.dispose() }
  return { registry, adapters, workspace, control, stop }
}

