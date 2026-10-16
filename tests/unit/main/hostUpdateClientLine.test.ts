// @vitest-environment node
import { expect, it } from 'vitest'
import { routerBusyThreads } from '../../../src/main/hosts/busyHost'
import { DesktopHostRouter, type DesktopHostConnection } from '../../../src/main/hosts/desktopHostRouter'
import { HostUpdates } from '../../../src/main/hosts/hostUpdate'
import { emptyDesktopState } from '../../../src/main/hosts/inactiveLocalHost'
import type { SshHostUpdateOperation, SshHostUpdateResult } from '../../../src/main/hosts/sshLauncher'
import type { AgentState, ProviderClientUpdate } from '../../../src/shared/agents'

const HOST = '11111111-1111-4111-8111-111111111111'
const SAVED = '33333333-3333-4333-8333-333333333333'
const codex = (state: ProviderClientUpdate['state']): ProviderClientUpdate =>
  ({ id: 'codex', installed: '0.51.0', published: '0.52.1', behind: true, channel: 'npm', canInstall: true, checkedAt: '2026-10-16T10:00:00.000Z', state })

/**
 * Wired as main wires it (src/main/index.ts): the line is read from the router in place, and nothing but the router's
 * changes, which reach an update through its threads, tells a waiting update that the line has emptied (ADR-0077).
 */
it('begins a host update that waited for its client update line once the router publishes the line empty', () => {
  const state = emptyDesktopState(HOST)
  state.host.connected = true; state.connection = 'connected'
  let push: ((state: AgentState) => void) | undefined
  const connection: DesktopHostConnection = { hostId: HOST, name: 'forge', kind: 'local', detail: () => null, preview: () => null,
    service: { shell: () => state, subscribe: listener => { push = listener; return () => undefined }, command: async () => state } }
  const router = new DesktopHostRouter(emptyDesktopState)
  router.add(connection)
  router.subscribe(() => undefined)
  const operations: SshHostUpdateOperation[] = []
  const updates = new HostUpdates({ version: '0.1.24', releasesUrl: 'https://releases.example/download', threads: routerBusyThreads(router),
    clients: { updating: hostId => router.clientLineRunning(hostId) },
    hosts: { candidates: () => [{ id: SAVED, name: 'forge', hostId: HOST, version: '0.1.22', owned: true, installPath: '/opt/sotto', dataDirectory: '/var/sotto' }],
      run: async (_id, operation) => { operations.push(operation); return new Promise<SshHostUpdateResult>(() => undefined) },
      restart: async () => new Promise<SshHostUpdateResult>(() => undefined), subscribe: () => () => undefined } })
  try {
    push!({ ...state, clientUpdates: [codex('updating')], clientUpdateRun: { total: 1, done: 0 } })
    void updates.command(SAVED, 'update')
    expect(updates.state()).toMatchObject([{ phase: 'waiting', clientsUpdating: true }])
    // Codex has finished; the run clears a moment later.
    push!({ ...state, clientUpdates: [codex('updated')], clientUpdateRun: { total: 1, done: 1 } })
    expect(updates.state()).toMatchObject([{ phase: 'waiting' }])
    expect(operations).toEqual([])
    push!({ ...state, clientUpdates: [codex('updated')] })
    expect(updates.state()).toMatchObject([{ phase: 'updating', step: 'download' }])
    expect(operations.map(operation => operation.op)).toEqual(['update-fetch'])
  } finally { updates.dispose(); router.dispose() }
})

it('does not hold a host update for the stale line of a host that is not connected', () => {
  const state = emptyDesktopState(HOST)
  state.host.connected = true; state.connection = 'connected'
  let push: ((state: AgentState) => void) | undefined
  let available = true
  const connection: DesktopHostConnection = { hostId: HOST, name: 'forge', kind: 'local', detail: () => null, preview: () => null, available: () => available,
    service: { shell: () => state, subscribe: listener => { push = listener; return () => undefined }, command: async () => state } }
  const router = new DesktopHostRouter(emptyDesktopState)
  router.add(connection)
  router.subscribe(() => undefined)
  const operations: SshHostUpdateOperation[] = []
  const updates = new HostUpdates({ version: '0.1.24', releasesUrl: 'https://releases.example/download', threads: routerBusyThreads(router),
    clients: { updating: hostId => router.clientLineRunning(hostId) },
    hosts: { candidates: () => [{ id: SAVED, name: 'forge', hostId: HOST, version: '0.1.22', owned: true, installPath: '/opt/sotto', dataDirectory: '/var/sotto' }],
      run: async (_id, operation) => { operations.push(operation); return new Promise<SshHostUpdateResult>(() => undefined) },
      restart: async () => new Promise<SshHostUpdateResult>(() => undefined), subscribe: () => () => undefined } })
  try {
    // forge drops with Codex still queued; what it last said stays, stale.
    available = false
    push!({ ...state, clientUpdates: [codex('queued')], clientUpdateRun: { total: 1, done: 0 } })
    expect(router.clientLineRunning(HOST)).toBe(false)
    void updates.command(SAVED, 'update')
    expect(updates.state()).toMatchObject([{ phase: 'updating', step: 'download' }])
    expect(updates.state()[0]!.clientsUpdating).toBeUndefined()
    expect(operations.map(operation => operation.op)).toEqual(['update-fetch'])
  } finally { updates.dispose(); router.dispose() }
})
