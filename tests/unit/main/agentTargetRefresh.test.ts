// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { AgentControl } from '../../../src/main/agents/control'
import { AgentCredentials } from '../../../src/main/agents/credentials'
import { E2EAgentHost } from '../../../src/main/e2e/agentEffects'
import { providerIdSchema, type AgentHostSnapshot, type ProviderId } from '../../../src/shared/agents'
import type { AgentHost } from '../../../src/main/agents/host'
import { ConfiguredProviderHost } from '../../../src/main/agents/providerSwitch'
import { SottoThreadHost, ThreadRegistry } from '../../../src/main/agents/threads'

class TargetHost extends E2EAgentHost {
  blocked: Promise<void> | undefined
  readonly reads: string[] = []
  override async snapshot(): Promise<AgentHostSnapshot> { await this.blocked; return super.snapshot() }
  async refreshThread(id: string): Promise<AgentHostSnapshot> { this.reads.push(id); return super.snapshot() }
}

it.each(['manual', 'managed'] as const)('confirms a %s prompt without waiting for unrelated background history', async mode => {
  const root = await mkdtemp(join(tmpdir(), 'sotto-target-read-'))
  const host = new TargetHost()
  const credentials = new AgentCredentials(join(root, 'vault'), { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() })
  await credentials.load()
  const control = new AgentControl({ directory: root, host, credentials,
    reasoner: { intent: async () => ({ type: 'clarify', text: 'Choose a thread' }), decide: async () => ({ decision: 'human', text: 'Review' }) },
    membership: { status: async () => ({ status: 'beta', label: 'Fixture', expiresAt: null }), action: async () => ({ status: 'beta', label: 'Fixture', expiresAt: null }) } })
  let release!: () => void
  let sending: ReturnType<AgentControl['command']> | undefined
  try {
    await control.start(); await control.command({ type: 'connect' })
    if (mode === 'managed') {
      await control.command({ type: 'assign', threadId: 'workshop' })
      await control.command({ type: 'compose', text: 'Selected thread prompt' })
    }
    host.blocked = new Promise<void>(resolve => { release = resolve })
    const background = host.snapshot()
    sending = control.command(mode === 'manual' ? { type: 'manual-send', threadId: 'workshop', text: 'Selected thread prompt', draftId: 'selected-draft' } : { type: 'send' })
    const result = await Promise.race([sending, new Promise<'blocked'>(resolve => setTimeout(() => resolve('blocked'), 200))])
    expect(result, 'unrelated history must not gate target delivery confirmation').not.toBe('blocked')
    if (result === 'blocked') return
    expect(result.error).toBeNull()
    if (mode === 'manual') expect(result.deliveredDrafts).toContainEqual({ threadId: 'workshop', draftId: 'selected-draft' })
    expect(result.draft).toBe('')
    expect(host.reads).toEqual(['workshop', 'workshop'])
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
    adapter.blocked = new Promise<void>(resolve => { release = resolve })
    const result = await host.refreshThread(id)
    expect(adapter.reads).toEqual(['workshop'])
    expect(result.threads.map(thread => thread.id)).toEqual(connected.threads.map(thread => thread.id))
    expect(registry.byThread(id)?.sessionId).toBe('workshop')
    await expect(host.refreshThread('unknown')).rejects.toThrow('not known to Sotto')
  } finally { release?.(); host.disconnect(); await registry.flush(); await rm(root, { recursive: true, force: true }) }
})
