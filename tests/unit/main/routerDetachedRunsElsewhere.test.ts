// @vitest-environment node
// #2749: the desktop's router hands each paired host's runs from elsewhere to the watch, by the name it gives that host,
// clears them when the host goes, asks every connected host to look again, and sends Stop to the host that found the run.
import { describe, expect, it, vi } from 'vitest'
import { DesktopHostRouter, type DesktopHostConnection } from '../../../src/main/hosts/desktopHostRouter'
import { emptyDesktopState } from '../../../src/main/hosts/inactiveLocalHost'
import type { DetachedRunElsewhere } from '../../../src/shared/agentMonitoring'

const LOCAL = '11111111-1111-4111-8111-111111111111', FORGE = '22222222-2222-4222-8222-222222222222'
const RUN = '0b5d6a51-8c2e-5f3a-9d41-6e7a8b9c0d1e'
const run: DetachedRunElsewhere = {
  marks: [{ name: 'CLAUDE_CODE_SESSION_ID', value: 'laptop-session' }],
  work: { id: RUN, label: 'Codex run', type: 'detached-run', run: { client: 'Codex', command: 'codex exec …' } },
}

function host(hostId: string, kind: 'local' | 'remote', name: string, reports = false) {
  const state = emptyDesktopState(hostId)
  state.host.connected = true; state.connection = 'connected'
  let available = true, runs: readonly DetachedRunElsewhere[] = [run]
  const listeners = new Set<() => void>()
  const look = vi.fn(async () => undefined)
  const stop = vi.fn(async (runId: string) => runId === RUN ? null : 'That detached run has already ended. Nothing was stopped.')
  const connection: DesktopHostConnection = { hostId, name, kind, available: () => available,
    service: { shell: () => state, subscribe: () => () => undefined, command: async () => state,
      ...reports ? { supportsDetachedRunsElsewhere: true, detachedRunsElsewhere: () => runs, lookForDetachedRuns: look, stopDetachedRunElsewhere: stop,
        subscribeDetachedRunsElsewhere: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } } } : {} },
    detail: async threadId => ({ threadId, revision: 1, messages: [] }), observe: async () => undefined, preview: () => null }
  return { connection, look, stop, away: () => { available = false }, report: (next: readonly DetachedRunElsewhere[]) => { runs = next; for (const listener of listeners) listener() } }
}

describe('runs from elsewhere through the router (#2749)', () => {
  it('hands each report on by the host’s name, the current one at once, and none once the host is gone', () => {
    const router = new DesktopHostRouter(emptyDesktopState)
    const heard = vi.fn()
    router.subscribeDetachedRunsElsewhere(heard)
    const forge = host(FORGE, 'remote', 'forge', true)
    router.add(host(LOCAL, 'local', 'This computer').connection)
    router.add(forge.connection)
    try {
      expect(heard).toHaveBeenLastCalledWith(FORGE, 'forge', [run])
      forge.report([])
      expect(heard).toHaveBeenLastCalledWith(FORGE, 'forge', [])
      forge.report([run])
      router.remove(FORGE)
      expect(heard).toHaveBeenLastCalledWith(FORGE, 'forge', [])
    } finally { router.dispose() }
  })

  it('asks only the connected hosts that report runs to look again, and sends Stop to the one that found the run', async () => {
    const router = new DesktopHostRouter(emptyDesktopState)
    const forge = host(FORGE, 'remote', 'forge', true)
    router.add(host(LOCAL, 'local', 'This computer').connection)
    router.add(forge.connection)
    try {
      router.lookForDetachedRunsElsewhere()
      await vi.waitFor(() => expect(forge.look).toHaveBeenCalledTimes(1))
      await router.stopDetachedRunElsewhere(FORGE, RUN)
      expect(forge.stop).toHaveBeenCalledWith(RUN)
      await expect(router.stopDetachedRunElsewhere(FORGE, '1c6e7b62-9d3f-5a4b-8e52-7f8a9b0c1d2e')).rejects.toThrow('That detached run has already ended. Nothing was stopped.')
      forge.away()
      router.lookForDetachedRunsElsewhere()
      await Promise.resolve()
      expect(forge.look).toHaveBeenCalledTimes(1)
      await expect(router.stopDetachedRunElsewhere(FORGE, RUN)).rejects.toThrow('Try Stop again once that computer is connected.')
    } finally { router.dispose() }
  })
})
