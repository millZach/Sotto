import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { ConfiguredProviderHost } from '../../src/main/agents/providerSwitch'
import { SottoThreadHost, ThreadRegistry } from '../../src/main/agents/threads'
import { WorkspaceHost } from '../../src/main/agents/workspace'
import { FakeProviderHost } from './fakeProviderHost'

export async function workspaceFixture(root?: string, options?: { worktreeRefreshDelayMs?: number }) {
  root ??= await mkdtemp(join(tmpdir(), 'sotto-workspace-'))
  const registry = new ThreadRegistry(root)
  const adapters = { codex: new FakeProviderHost(), claude: new FakeProviderHost(), grok: new FakeProviderHost() }
  for (const [id, adapter] of Object.entries(adapters)) {
    adapter.state.projects[0]!.path = join(root, id)
    await mkdir(adapter.state.projects[0]!.path, { recursive: true })
    adapter.state.models[0]!.reasoningEfforts = ['low', 'high']
    adapter.state.models[0]!.defaultReasoningEffort = 'low'
    adapter.state.models[0]!.runtimeModes = ['approval-required']
    adapter.state.capabilities.configureThread = true
  }
  let history = true
  const native = new ConfiguredProviderHost({ directory: root, provider: () => 'codex', enabledProviders: () => ['codex', 'claude', 'grok'],
    threadProvider: id => registry.byThread(id)?.provider,
    hosts: { codex: new SottoThreadHost('codex', adapters.codex, registry), claude: new SottoThreadHost('claude', adapters.claude, registry), grok: new SottoThreadHost('grok', adapters.grok, registry), devin: new FakeProviderHost() } })
  const host = new WorkspaceHost(native, root, () => history, options?.worktreeRefreshDelayMs)
  await host.initialize()
  return { root, registry, adapters, host, native, setHistory: (value: boolean) => { history = value },
    stop: async () => { host.disconnect(); await host.privacyChanged(); await registry.flush(); host.dispose() },
    remove: async () => {
      if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-workspace-')) throw new Error('Unexpected test directory')
      await rm(root, { recursive: true, force: true })
    },
  }
}
