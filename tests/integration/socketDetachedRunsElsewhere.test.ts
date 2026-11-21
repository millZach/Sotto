// @vitest-environment node
// #2749: a host reports the detached runs it found with marks none of its threads owns to a recorded desktop, looks again
// when that desktop asks, and stops one when its user presses Stop; it offers none of it to any other client.
import { describe, expect, it, vi } from 'vitest'
import { startSocketServer } from '../../src/host/socketServer'
import type { HostService } from '../../src/main/agents/hostService'
import type { DetachedRunElsewhere } from '../../src/shared/agentMonitoring'
import { rawPeer } from '../fixtures/rawHostPeer'
import { useSocketHostFixture } from '../fixtures/socketHostFixture'

const fixture = useSocketHostFixture()
const RUN = '0b5d6a51-8c2e-5f3a-9d41-6e7a8b9c0d1e'
const run: DetachedRunElsewhere = {
  marks: [{ name: 'CLAUDE_CODE_SESSION_ID', value: '0d15c982-fe12-44e4-8834-23b3be4bd2eb' }],
  work: { id: RUN, label: 'Codex run', type: 'detached-run', startedAt: '2026-11-20T21:00:00.000Z',
    run: { client: 'Codex', model: 'gpt-6-astra', effort: 'max', folder: '/home/zach/algo-attack/dopamine-gt3rs', command: 'codex exec --json -m gpt-6-astra …' } },
}

function reportingHost(found: { runs: readonly DetachedRunElsewhere[] }, listeners: Set<() => void>, look: () => void, stop: (runId: string) => Promise<string | null>): HostService {
  const base = fixture.host.service
  return {
    shell: () => base.shell(), state: () => base.state(), threadDetail: id => base.threadDetail(id), events: () => [],
    command: (command, identity) => base.command(command, identity), subscribe: listener => base.subscribe(listener),
    supportsDetachedRunsElsewhere: true, detachedRunsElsewhere: () => found.runs,
    subscribeDetachedRunsElsewhere: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
    lookForDetachedRuns: look, stopDetachedRunElsewhere: stop,
  }
}
const pushes = (messages: readonly Record<string, unknown>[]) => messages.filter(message => message.event === 'detached-runs-elsewhere').map(message => message.runs)

describe('detached runs from elsewhere over the socket (#2749)', () => {
  it('pushes them after a recorded desktop’s hello and on each change, looks again and stops one when asked', async () => {
    const found: { runs: readonly DetachedRunElsewhere[] } = { runs: [run] }
    const listeners = new Set<() => void>()
    const look = vi.fn()
    const stop = vi.fn(async (runId: string) => runId === RUN ? null : 'That detached run has already ended. Nothing was stopped.')
    const known = new Set<string>()
    const server = await startSocketServer({ service: reportingHost(found, listeners, look, stop), pairing: fixture.host.pairing,
      watcherDesktops: { has: (clientId: string) => known.has(clientId), refresh: async () => undefined } })
    const paired = await fixture.host.pairing.redeem(fixture.host.pairing.issuePairingCode().code, 'Desktop')
    known.add(paired.clientId)
    const desktop = await rawPeer(server.descriptor.port, fixture.host.pairing.signSession(paired.clientId))
    try {
      const hello = await desktop.call('hello', { op: 'hello', accepts: ['detached-runs-elsewhere'] }) as { result: { features: string[] } }
      expect(hello.result.features).toContain('detached-runs-elsewhere')
      await expect.poll(() => pushes(desktop.messages).length).toBe(1)
      expect(pushes(desktop.messages)[0]).toEqual([run])
      found.runs = []
      for (const listener of listeners) listener()
      await expect.poll(() => pushes(desktop.messages).length).toBe(2)
      expect(pushes(desktop.messages)[1]).toEqual([])

      expect(await desktop.call('look', { op: 'detached-runs-look' })).toMatchObject({ ok: true })
      expect(look).toHaveBeenCalledTimes(1)
      expect(await desktop.call('stop', { op: 'detached-run-elsewhere-stop', runId: RUN })).toMatchObject({ ok: true, result: { error: null } })
      expect(stop).toHaveBeenCalledWith(RUN)
      const other = '1c6e7b62-9d3f-5a4b-8e52-7f8a9b0c1d2e'
      expect(await desktop.call('stop-ended', { op: 'detached-run-elsewhere-stop', runId: other })).toMatchObject({ ok: true, result: { error: 'That detached run has already ended. Nothing was stopped.' } })
    } finally { desktop.frames.close(); await server.close() }
  })

  it('offers none of it to a client the launch script did not record as a desktop, and refuses its look and Stop', async () => {
    const listeners = new Set<() => void>()
    const look = vi.fn(), stop = vi.fn(async () => null)
    const server = await startSocketServer({ service: reportingHost({ runs: [run] }, listeners, look, stop), pairing: fixture.host.pairing,
      watcherDesktops: { has: () => false, refresh: async () => undefined } })
    const phone = await fixture.host.pairing.redeem(fixture.host.pairing.issuePairingCode().code, 'Phone')
    const stranger = await rawPeer(server.descriptor.port, fixture.host.pairing.signSession(phone.clientId))
    try {
      const hello = await stranger.call('hello', { op: 'hello', accepts: ['detached-runs-elsewhere'] }) as { result: { features: string[] } }
      expect(hello.result.features).not.toContain('detached-runs-elsewhere')
      for (const listener of listeners) listener()
      await stranger.call('shell', { op: 'shell' })
      expect(pushes(stranger.messages)).toEqual([])
      expect(await stranger.call('look', { op: 'detached-runs-look' })).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
      expect(await stranger.call('stop', { op: 'detached-run-elsewhere-stop', runId: RUN })).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
      expect(look).not.toHaveBeenCalled()
      expect(stop).not.toHaveBeenCalled()
    } finally { stranger.frames.close(); await server.close() }
  })
})
