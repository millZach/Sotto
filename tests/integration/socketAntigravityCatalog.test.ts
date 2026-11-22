// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { startSocketServer } from '../../src/host/socketServer'
import { PairedClients } from '../../src/main/agents/pairing'
import { LocalHostService } from '../../src/main/agents/hostService'
import { SocketHostService } from '../../src/main/agents/socketHostService'
import { emptyDesktopState } from '../../src/main/hosts/inactiveLocalHost'
import type { AgentModel, AgentState, ProviderId } from '../../src/shared/agents'

afterEach(() => { vi.restoreAllMocks() })

const model = (id: string, providerId: ProviderId, provider: string): AgentModel => ({ id, name: id, provider, providerId, ready: true, runtimeModes: ['approval-required'] })

it('keeps a paired host’s qualified and legacy Gemini models while dropping non-Gemini and malformed Antigravity entries across pushes, revisions, legacy shells and reconnect', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sotto-antigravity-catalog-'))
  const pairing = new PairedClients(directory); await pairing.load()
  let state: AgentState = emptyDesktopState('11111111-1111-4111-8111-111111111111')
  const mixedModels = [
    model('native:antigravity:model:gemini-4-neon', 'antigravity', 'Antigravity'),
    model('native:antigravity:model:gemini-3.8-flash', 'antigravity', 'Antigravity'),
    model('native:antigravity:model:claude-opus-5-5', 'antigravity', 'Antigravity'),
    model('native:antigravity:model:gpt-oss-120b-medium', 'antigravity', 'Antigravity'),
    model('gemini-3.8-flash', 'antigravity', 'Antigravity'),
    model('claude-opus-5-5', 'antigravity', 'Antigravity'),
    model('gpt-oss-120b-medium', 'antigravity', 'Antigravity'),
    model('native:codex:model:gemini-4-neon', 'antigravity', 'Antigravity'),
    model('native:antigravity:project:gemini-4-neon', 'antigravity', 'Antigravity'),
    model('native:antigravity:model:%ZZ', 'antigravity', 'Antigravity'),
    model('native:codex:model:gpt-6.2-sol', 'codex', 'Codex'),
  ]
  state.host.models = mixedModels
  const listeners = new Set<(next: AgentState) => void>()
  const control = {
    get: () => state,
    shell: () => state,
    threadDetail: () => null,
    subscribe: (listener: (next: AgentState) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    commandShell: vi.fn(async () => state),
  }
  const server = await startSocketServer({ service: new LocalHostService({ control }), pairing })
  let client: SocketHostService | undefined
  try {
    const paired = await pairing.redeem(pairing.issuePairingCode().code, 'Desktop')
    client = new SocketHostService({ url: `http://127.0.0.1:${server.descriptor.port}`, token: paired.token, catchUpEvents: false })
    await client.connect()

    const expectedInitial = [
      'native:antigravity:model:gemini-4-neon',
      'native:antigravity:model:gemini-3.8-flash',
      'gemini-3.8-flash',
      'native:codex:model:gpt-6.2-sol',
    ]
    const first = await client.readShell()
    expect(first.host.models.map(item => item.id)).toEqual(expectedInitial)
    const certifiedRef = client.view().host.models
    expect(Object.isFrozen(certifiedRef)).toBe(true)

    // A shell push at the same modelsRevision omits `models` on the wire and reuses the certified frozen array.
    state = { ...state, notice: 'Same catalog push' }
    for (const listener of listeners) listener(state)
    await expect.poll(() => client!.view().notice).toBe('Same catalog push')
    expect(client.view().host.models).toBe(certifiedRef)
    await client.readShell()
    expect(client.view().host.models).toBe(certifiedRef)

    // A new revision adopts and filters the updated catalog.
    state = {
      ...state,
      notice: 'Updated catalog push',
      host: {
        ...state.host,
        models: [
          model('native:antigravity:model:gemini-4-neon', 'antigravity', 'Antigravity'),
          model('native:antigravity:model:claude-sonnet-5-5', 'antigravity', 'Antigravity'),
          model('native:codex:model:gpt-6.2-sol', 'codex', 'Codex'),
        ],
      },
    }
    for (const listener of listeners) listener(state)
    await expect.poll(() => client!.shell().notice).toBe('Updated catalog push')
    expect(client.shell().host.models.map(item => item.id)).toEqual([
      'native:antigravity:model:gemini-4-neon',
      'native:codex:model:gpt-6.2-sol',
    ])

    // Reconnecting adopts the filtered catalog again cleanly.
    await client.close()
    state = { ...state, host: { ...state.host, models: mixedModels } }
    client = new SocketHostService({ url: `http://127.0.0.1:${server.descriptor.port}`, token: paired.token, catchUpEvents: false })
    await client.connect()
    expect((await client.readShell()).host.models.map(item => item.id)).toEqual(expectedInitial)
    await client.close()

    // An older host without `model-catalog-revision` sends full shells with no revision; its non-Gemini Antigravity rows still drop.
    const realFetch = globalThis.fetch
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const response = await realFetch(input, init)
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : input.toString()
      if (!url.endsWith('/v1/health')) return response
      const health = await response.json() as { features: string[] }
      return new Response(JSON.stringify({ ...health, features: health.features.filter(feature => feature !== 'model-catalog-revision') }), { status: response.status, headers: response.headers })
    })
    client = new SocketHostService({ url: `http://127.0.0.1:${server.descriptor.port}`, token: paired.token, catchUpEvents: false })
    await client.connect()
    expect(client.shell().host.models.map(item => item.id)).toEqual(expectedInitial)
    expect((await client.readShell()).host.models.map(item => item.id)).toEqual(expectedInitial)
  } finally { await client?.close(); await server.close(); await rm(directory, { recursive: true, force: true }) }
})
