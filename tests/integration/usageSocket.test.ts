// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { startSocketServer } from '../../src/host/socketServer'
import { PairedClients } from '../../src/main/agents/pairing'
import { LocalHostService, desktopWindowClient, type HostUsageReads } from '../../src/main/agents/hostService'
import { SocketHostService } from '../../src/main/agents/socketHostService'
import { emptyDesktopState } from '../../src/main/hosts/inactiveLocalHost'
import type { UsageLocalHostRead } from '../../src/shared/usageDashboard'
import { rawPeer } from '../fixtures/rawHostPeer'
import { localActivity } from '../fixtures/renderer/usageReads'

describe('optional Owl usage over frozen host v1', () => {
  it.each([false, true])('advertises the host-owned collector only when it exists (enabled: %s)', async enabled => {
    const directory = await mkdtemp(join(tmpdir(), 'sotto-usage-wire-'))
    const pairing = new PairedClients(directory); await pairing.load()
    const state = emptyDesktopState('11111111-1111-4111-8111-111111111111')
    const result: UsageLocalHostRead = { status: 'ready', quotas: [{ providerId: 'codex', status: 'available', refreshable: true, windows: [{ id: 'primary', label: 'Current period', kind: 'primary', usedPercent: 0 }] }] }
    const metadata = { startedAt: '2026-10-12T12:00:00.000Z', revision: 4, generation: 0, legacySeedCompleted: true }
    const usage: HostUsageReads = { read: vi.fn(async () => result), refresh: vi.fn(async () => result), clear: vi.fn(async () => ({ status: 'stale' as const, metadata })) }
    const control = { get: () => state, shell: () => state, threadDetail: () => null, subscribe: () => () => undefined, commandShell: vi.fn(async () => state) }
    let mayAnswer = false
    const service = new LocalHostService({ control, ...(enabled ? { usage } : {}), mayClearUsage: () => mayAnswer })
    const server = await startSocketServer({ service, pairing, mayAnswer: () => mayAnswer })
    let client: SocketHostService | undefined
    let raw: Awaited<ReturnType<typeof rawPeer>> | undefined
    try {
      expect(server.descriptor.features.includes('usage-dashboard')).toBe(enabled)
      const paired = await pairing.redeem(pairing.issuePairingCode().code, 'Desktop')
      client = new SocketHostService({ url: `http://127.0.0.1:${server.descriptor.port}`, token: paired.token, catchUpEvents: false })
      expect((await client.connect()).features.includes('usage-dashboard')).toBe(enabled)
      expect(client.supportsUsage).toBe(enabled)
      if (!enabled) {
        await expect(client.usageRead({})).rejects.toThrow()
        expect(usage.read).not.toHaveBeenCalled()
        expect(await client.readShell()).toMatchObject({ hostId: state.hostId })
        return
      }
      expect(await client.usageRead({ timeZone: 'America/Los_Angeles', providerIds: ['codex'] })).toEqual(result)
      expect(usage.read).toHaveBeenCalledWith({ timeZone: 'America/Los_Angeles', providerIds: ['codex'] })
      expect(await client.usageRefresh(['codex'])).toEqual(result)
      expect(usage.refresh).toHaveBeenCalledWith(['codex'])
      await expect(client.usageClear({ expectedRevision: 4 }, desktopWindowClient())).rejects.toMatchObject({ code: 'forbidden' })
      expect(usage.clear).not.toHaveBeenCalled()
      mayAnswer = true
      expect(await client.usageClear({ expectedRevision: 4 }, desktopWindowClient())).toEqual({ status: 'stale', metadata })
      expect(usage.clear).toHaveBeenCalledExactlyOnceWith({ expectedRevision: 4 })
      // Unknown provider identifiers or extra approval fields are refused before a host read or mutation.
      raw = await rawPeer(server.descriptor.port, pairing.signSession(paired.clientId))
      expect(await raw.call('invalid-read', { op: 'usage-read', query: { providerSessionId: 'private' } })).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
      expect(await raw.call('invalid-clear', { op: 'usage-clear', request: { expectedRevision: 4, approved: true } })).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
      expect(usage.read).toHaveBeenCalledOnce(); expect(usage.clear).toHaveBeenCalledOnce()
    } finally { raw?.frames.close(); await client?.close(); await server.close(); await rm(directory, { recursive: true, force: true }) }
  })
  it('answers a desktop from before history import without what its strict schemas refuse', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sotto-usage-wire-'))
    const pairing = new PairedClients(directory); await pairing.load()
    const state = emptyDesktopState('11111111-1111-4111-8111-111111111111')
    const result: UsageLocalHostRead = { status: 'ready', activity: localActivity(), quotas: [] }
    const metadata = { startedAt: '2026-10-12T12:00:00.000Z', revision: 4, generation: 0, legacySeedCompleted: true }
    const usage: HostUsageReads = { read: vi.fn(async () => result), refresh: vi.fn(async () => result), clear: vi.fn(async () => ({ status: 'stale' as const, metadata })) }
    const control = { get: () => state, shell: () => state, threadDetail: () => null, subscribe: () => () => undefined, commandShell: vi.fn(async () => state) }
    const server = await startSocketServer({ service: new LocalHostService({ control, usage, mayClearUsage: () => false }), pairing, mayAnswer: () => false })
    let client: SocketHostService | undefined
    let raw: Awaited<ReturnType<typeof rawPeer>> | undefined
    try {
      const paired = await pairing.redeem(pairing.issuePairingCode().code, 'Desktop')
      client = new SocketHostService({ url: `http://127.0.0.1:${server.descriptor.port}`, token: paired.token, catchUpEvents: false })
      expect((await client.connect()).features).toContain('usage-history')
      // An updated desktop accepts usage-history and is sent the whole read.
      expect(await client.usageRead({})).toEqual(result)
      // A desktop from before history import neither accepts the feature nor knows its fields.
      raw = await rawPeer(server.descriptor.port, pairing.signSession(paired.clientId))
      expect(await raw.call('hello', { op: 'hello', accepts: ['client-liveness'] })).toMatchObject({ ok: true })
      for (const [id, op] of [['older-read', { op: 'usage-read', query: {} }], ['older-refresh', { op: 'usage-refresh' }]] as const) {
        const answer = await raw.call(id, op) as { ok: boolean; result: UsageLocalHostRead }
        expect(answer.ok).toBe(true)
        for (const key of ['"clients"', '"history"', '"lastDay"']) expect(JSON.stringify(answer.result)).not.toContain(key)
        expect(answer.result.activity?.totals.tokens).toEqual(result.activity?.totals.tokens)
        expect(answer.result.activity?.models.map(row => row.modelId)).toEqual(result.activity?.models.map(row => row.modelId))
      }
    } finally { raw?.frames.close(); await client?.close(); await server.close(); await rm(directory, { recursive: true, force: true }) }
  })
})
