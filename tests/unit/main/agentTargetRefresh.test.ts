// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { AgentControl } from '../../../src/main/agents/control'

import { E2EAgentHost } from '../../../src/main/e2e/agentEffects'
import { providerIdSchema, type AgentHostSnapshot, type ProviderId } from '../../../src/shared/agents'
import type { AgentHost } from '../../../src/main/agents/host'
import { ConfiguredProviderHost } from '../../../src/main/agents/providerSwitch'
import { SottoThreadHost, ThreadRegistry } from '../../../src/main/agents/threads'
import { immediatePublishScheduler } from '../../fixtures/publishScheduler'
import { testCredentials } from '../../fixtures/testCredentials'
import { createAgentControl } from '../../fixtures/agentControlFixture'
import { deferred } from '../../fixtures/deferred'

class TargetHost extends E2EAgentHost {
  blocked: Promise<void> | undefined
  readonly reads: string[] = []
  override async snapshot(): Promise<AgentHostSnapshot> { await this.blocked; return super.snapshot() }
  async refreshThread(id: string): Promise<AgentHostSnapshot> { this.reads.push(id); return super.snapshot() }
}

it.each(['manual', 'saved'] as const)('confirms a %s prompt without waiting for unrelated background history', async mode => {
  const root = await mkdtemp(join(tmpdir(), 'sotto-target-read-'))
  const host = new TargetHost()
  const credentials = await testCredentials(join(root, 'vault'), { mode: 'plain' })
  const control = createAgentControl({ schedule: immediatePublishScheduler, directory: root, host, credentials,
    reasoner: {},
  })
  let release!: () => void
  let sending: ReturnType<AgentControl['command']> | undefined
  try {
    await control.start(); await control.command({ type: 'connect' })
    if (mode === 'saved') {
      await control.command({ type: 'select-thread', threadId: 'workshop' })
      await control.command({ type: 'compose', text: 'Selected thread prompt' })
    }
    host.reads.length = 0
    const pending1 = deferred<void>();
    release = pending1.resolve;
    host.blocked = pending1.promise
    const background = host.snapshot()
    sending = control.command(mode === 'manual' ? { type: 'manual-send', threadId: 'workshop', text: 'Selected thread prompt', draftId: 'selected-draft' } : { type: 'send' })
    const result = await Promise.race([sending, new Promise<'blocked'>(resolve => setTimeout(() => resolve('blocked'), 200))])
    expect(result, 'unrelated history must not gate target delivery confirmation').not.toBe('blocked')
    if (result === 'blocked') return
    expect(result.error).toBeNull()
    if (mode === 'manual') expect(result.deliveredDrafts).toContainEqual({ threadId: 'workshop', draftId: 'selected-draft' })
    expect(result.draft).toBe('')
    expect(host.reads).toEqual(['workshop'])
    release(); await background
  } finally { release?.(); await sending; control.dispose(); await rm(root, { recursive: true, force: true }) }
})

it('maps a targeted read through provider selection and durable Sotto identity without a broad snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sotto-target-wrapper-'))
  const adapter = new TargetHost()
  const registry = new ThreadRegistry(root)
  const wrapped = new SottoThreadHost('codex', adapter, registry)
  const hosts = {} as Record<ProviderId, AgentHost>
  for (const provider of providerIdSchema.options) hosts[provider] = provider === 'codex' ? wrapped : new TargetHost()
  const host = new ConfiguredProviderHost({ hosts, provider: () => 'codex' })
  let release!: () => void
  try {
    const connected = await host.connect()
    const id = connected.threads.find(thread => thread.title === 'Workshop')!.id
    expect(id).not.toBe('workshop')
    const pending2 = deferred<void>();
    release = pending2.resolve;
    adapter.blocked = pending2.promise
    const result = await host.refreshThread(id)
    expect(adapter.reads).toEqual(['workshop'])
    expect(result.threads.map(thread => thread.id)).toEqual(connected.threads.map(thread => thread.id))
    expect(registry.byThread(id)?.sessionId).toBe('workshop')
    await expect(host.refreshThread('unknown')).rejects.toThrow('not known to Sotto')
  } finally { release?.(); host.disconnect(); await registry.flush(); await rm(root, { recursive: true, force: true }) }
})
