// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { startSocketServer } from '../../src/host/socketServer'
import { PairedClients } from '../../src/main/agents/pairing'
import { LocalHostService } from '../../src/main/agents/hostService'
import { SocketHostService } from '../../src/main/agents/socketHostService'
import { emptyDesktopState } from '../../src/main/hosts/inactiveLocalHost'
import type { AgentModel, ProviderId } from '../../src/shared/agents'

const model = (id: string, providerId: ProviderId, provider: string): AgentModel => ({ id, name: id, provider, providerId, ready: true, runtimeModes: ['approval-required'] })

it('keeps a paired host’s Antigravity models to Gemini, as a host from before Google’s terms still lists Claude and GPT (ADR-0212)', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sotto-antigravity-catalog-'))
  const pairing = new PairedClients(directory); await pairing.load()
  const state = emptyDesktopState('11111111-1111-4111-8111-111111111111')
  state.host.models = [model('gemini-3.8-flash', 'antigravity', 'Antigravity'), model('claude-opus-5-5', 'antigravity', 'Antigravity'),
    model('gpt-oss-120b-medium', 'antigravity', 'Antigravity'), model('gpt-6.2-sol', 'codex', 'Codex')]
  const control = { get: () => state, shell: () => state, threadDetail: () => null, subscribe: () => () => undefined, commandShell: vi.fn(async () => state) }
  const server = await startSocketServer({ service: new LocalHostService({ control }), pairing })
  let client: SocketHostService | undefined
  try {
    const paired = await pairing.redeem(pairing.issuePairingCode().code, 'Desktop')
    client = new SocketHostService({ url: `http://127.0.0.1:${server.descriptor.port}`, token: paired.token, catchUpEvents: false })
    await client.connect()
    // Codex's GPT model stays: only Antigravity's other makers go.
    expect((await client.readShell()).host.models.map(item => item.id)).toEqual(['gemini-3.8-flash', 'gpt-6.2-sol'])
  } finally { await client?.close(); await server.close(); await rm(directory, { recursive: true, force: true }) }
})
