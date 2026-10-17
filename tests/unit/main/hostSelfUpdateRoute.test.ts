// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { HostUpdateMissed, type HostUpdateMiss } from '../../../src/main/agents/socketHostService'
import { afterSocketMiss, missOf, restartFromOutcome, socketStepResult, updateCarrier, type AfterSocketMiss, type CarrierFacts, type SocketUpdateAction } from '../../../src/main/hosts/hostSelfUpdateRoute'
import type { HostUpdateAnswer } from '../../../src/shared/hostSelfUpdate'

// How a host update's steps travel (ADR-0088, October 16 amendment), row by row.
const FILE = 'Sotto-host-9.9.9-linux-x64.tar.gz', SUM = 'a'.repeat(64)
const facts = (patch: Partial<CarrierFacts> = {}): CarrierFacts => ({ op: 'update-fetch', via: 'tailnet', connected: true, moving: false, offers: true, ...patch })

describe('updateCarrier', () => {
  it('sends download, install and restart over the socket of a connected host on its tailnet connection that offers the route', () => {
    for (const op of ['update-fetch', 'update-install', 'update-restart'] as const) expect(updateCarrier(facts({ op })), op).toBe('socket')
  })
  it('always copies an archive this computer downloaded over SSH, which the socket cannot carry', () => {
    expect(updateCarrier(facts({ op: 'update-receive' }))).toBe('press')
  })
  it.each<[string, Partial<CarrierFacts>]>([
    ['a host on its SSH connection, which signs in nothing new', { via: 'ssh' }],
    ['a host with no socket', { via: undefined }],
    ['a host not connected now', { connected: false }],
    ['a socket moving to the tailnet', { moving: true }],
    ['a host whose hello does not list host-update', { offers: false }],
  ])('keeps %s on press()', (_name, patch) => {
    for (const op of ['update-fetch', 'update-install', 'update-restart'] as const) expect(updateCarrier(facts({ op, ...patch })), op).toBe('press')
  })
})

describe('afterSocketMiss', () => {
  const rows: [HostUpdateMiss, Record<SocketUpdateAction, AfterSocketMiss>][] = [
    // Refused, or never sent: nothing ran on the host.
    ['forbidden', { fetch: 'ssh', install: 'ssh', restart: 'ssh' }],
    ['invalid_request', { fetch: 'ssh', install: 'ssh', restart: 'ssh' }],
    // A host of another version refusing a request it cannot read, as this client reads `invalid_request` from it.
    ['version_mismatch', { fetch: 'ssh', install: 'ssh', restart: 'ssh' }],
    ['busy', { fetch: 'ssh', install: 'ssh', restart: 'ssh' }],
    ['unsent', { fetch: 'ssh', install: 'ssh', restart: 'ssh' }],
    // The connection closed: a download ended with it, an install carries on under the host's lock, a restart may have gone.
    ['closed', { fetch: 'ssh', install: 'lost', restart: 'reconnect' }],
    // The host answered with a failure, or not in time, on a connection that may still be open: a restart is asked about there.
    ['failed', { fetch: 'ssh', install: 'lost', restart: 'ask' }],
    ['timeout', { fetch: 'lost', install: 'lost', restart: 'ask' }],
  ]
  it.each(rows)('leads %s to the right place for each step', (miss, expected) => {
    for (const action of ['fetch', 'install', 'restart'] as const) expect(afterSocketMiss(action, miss, false), action).toBe(expected[action])
  })
  it('falls back to nothing after Cancel update, whatever the miss', () => {
    for (const [miss] of rows) for (const action of ['fetch', 'install', 'restart'] as const) expect(afterSocketMiss(action, miss, true)).toBe('cancelled')
  })
  it('reads the miss from the error class, and anything unexpected as an answer lost', () => {
    expect(missOf(new HostUpdateMissed('forbidden'))).toBe('forbidden')
    expect(missOf(new HostUpdateMissed('timeout'))).toBe('timeout')
    expect(missOf(new Error('forbidden'))).toBe('closed')
  })
})

describe('socketStepResult', () => {
  it('reads a download and an install the way the same step over SSH answers them', () => {
    expect(socketStepResult('fetch', { type: 'update-fetched', file: FILE, sha256: SUM })).toEqual({ type: 'update-fetched', file: FILE, sha256: SUM })
    expect(socketStepResult('install', { type: 'update-installed', version: '9.9.9' })).toEqual({ type: 'update-installed', version: '9.9.9' })
  })
  it('keeps a download error’s archive name, so a host that cannot reach GitHub is sent the archive over SSH', () => {
    expect(socketStepResult('fetch', { type: 'error', reason: 'download-unreachable', file: FILE })).toEqual({ type: 'error', reason: 'download-unreachable', file: FILE })
  })
  it('reads a cancelled download as nothing, and an answer for another step as a failure', () => {
    expect(socketStepResult('fetch', { type: 'update-cancelled', cancelled: true })).toBeUndefined()
    expect(socketStepResult('fetch', { type: 'update-installed', version: '9.9.9' })).toEqual({ type: 'error', reason: 'update-failed' })
    expect(socketStepResult('install', { type: 'update-fetched', file: FILE, sha256: SUM })).toEqual({ type: 'error', reason: 'update-failed' })
  })
})

describe('restartFromOutcome', () => {
  const HOST_ID = '22222222-2222-4222-8222-222222222222'
  const outcome = (running: string, restart: Extract<HostUpdateAnswer, { type: 'update-outcome' }>['restart']): HostUpdateAnswer => ({ type: 'update-outcome', running, restart })
  const ready = { type: 'ready', hostId: HOST_ID, pid: 42 } as const
  it('says the new host started when the restart to this version finished ready and the host runs it', () => {
    expect(restartFromOutcome(outcome('9.9.9', { state: 'finished', version: '9.9.9', result: ready }), '9.9.9')).toEqual(ready)
  })
  it('gives the launch script’s own failure, such as the old version started again', () => {
    const failed = { type: 'error', reason: 'update-start-failed', restarted: true, cause: 'host-start-failed' } as const
    expect(restartFromOutcome(outcome('9.9.8', { state: 'finished', version: '9.9.9', result: failed }), '9.9.9')).toEqual(failed)
  })
  it.each<[string, HostUpdateAnswer | undefined]>([
    ['no restart recorded', outcome('9.9.8', { state: 'none' })],
    ['a restart still under way at the deadline', outcome('9.9.8', { state: 'restarting', version: '9.9.9' })],
    ['an interrupted restart', outcome('9.9.8', { state: 'finished', version: '9.9.9', result: { type: 'error', reason: 'update-lost' } })],
    ['a restart to another version', outcome('9.9.7', { state: 'finished', version: '9.9.7', result: ready })],
    ['a ready restart to this version on a host that runs another', outcome('9.9.8', { state: 'finished', version: '9.9.9', result: ready })],
    ['another answer', { type: 'update-cancelled', cancelled: false }],
    ['no connection by the deadline', undefined],
  ])('cannot say for %s, so the version the host runs decides', (_name, answer) => {
    expect(restartFromOutcome(answer, '9.9.9')).toBeUndefined()
  })
  it('cannot say from a record the host already had before this restart was sent, as from an earlier Try again', () => {
    const failed = { type: 'error', reason: 'update-start-failed', restarted: true } as const
    const earlier = outcome('9.9.8', { state: 'finished', version: '9.9.9', result: failed })
    expect(restartFromOutcome(earlier, '9.9.9', earlier)).toBeUndefined()
    // A record that changed since is this restart's.
    expect(restartFromOutcome(outcome('9.9.9', { state: 'finished', version: '9.9.9', result: ready }), '9.9.9', earlier)).toEqual(ready)
    expect(restartFromOutcome(earlier, '9.9.9', outcome('9.9.8', { state: 'none' }))).toEqual(failed)
  })
})
