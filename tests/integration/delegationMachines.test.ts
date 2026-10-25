// @vitest-environment node
// #1032 over ADR-0081: a delegating thread lists the machines Watcher lists, and a new delegated thread may name a machine
// or a system. Delegated threads start on This computer for now (#1316), so any other machine is refused and recorded.
import { afterEach, expect, it, vi } from 'vitest'
import { DelegationToolServer } from '../../src/main/agents/delegationTools'
import type { DelegationServiceOptions } from '../../src/main/agents/delegation'
import type { WorkerMachineSetting } from '../../src/shared/workerMachine'
import { delegationFixture } from '../fixtures/delegationFixture'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const FORGE = '22222222-2222-4222-8222-222222222222'
type Machines = NonNullable<DelegationServiceOptions['machines']>

async function fixture() {
  const choice = { setting: 'this-computer' as WorkerMachineSetting }
  // Watcher's placement stands in here: the paired-host tests drive the real one.
  const machines = {
    list: vi.fn<Machines['list']>(async () => ({ status: 'ok', machines: [{ hostId: 'here', name: 'This computer' }, { hostId: FORGE, name: 'forge' }], newWorkersStart: { choice: 'this-computer' } })),
    place: vi.fn<Machines['place']>(async () => ({ status: 'refused', code: 'HOST_DISCONNECTED', message: 'No Mac is connected. Connect a Mac, or run this on This computer. Nothing was started.', retryable: true })),
    name: (hostId: string) => hostId === FORGE ? 'forge' : undefined,
    setting: () => choice.setting,
  }
  const f = await delegationFixture(cleanups, { delegation: { machines } })
  const local = f.control.hostId()!
  const here = (projectId: string) => ({ hostId: local, projectId, receipt: { hostId: local, name: 'This computer', awayFromDefault: false } })
  return { ...f, machines, choice, local, here }
}

it('starts a delegated thread on This computer when it names no machine, and says so when new workers start on another (#1032)', async () => {
  const f = await fixture(), parent = await f.userThread('claude')
  const plain = f.ok(await f.delegate(parent, { provider: 'codex', model: f.model('codex').id, wait_seconds: 0 }))
  expect(plain).not.toHaveProperty('placement')
  f.choice.setting = FORGE
  const noted = f.ok(await f.delegate(parent, { provider: 'codex', model: f.model('codex').id, wait_seconds: 0 }))
  expect(noted).toMatchObject({ placement: { hostId: f.local, name: 'This computer', awayFromDefault: true,
    note: 'New workers start on forge, but a delegated thread starts on This computer for now.' } })
  expect(f.machines.place).not.toHaveBeenCalled()
  expect(f.control.shell().host.threads.filter(thread => thread.delegatedBy === parent)).toHaveLength(2)
})

it('starts on This computer when the machine or system it names resolves here, from the delegating thread’s own project (#1032)', async () => {
  const f = await fixture(), parent = await f.userThread('claude')
  const project = f.control.shell().host.threads.find(thread => thread.id === parent)!.projectId
  f.choice.setting = FORGE
  f.machines.place.mockImplementation(async (_ask, named) => f.here(named.projectId))
  const started = f.ok(await f.delegate(parent, { provider: 'codex', model: f.model('codex').id, os: 'windows', wait_seconds: 0 }))
  expect(started).toMatchObject({ placement: { hostId: f.local, name: 'This computer', awayFromDefault: false } })
  // Placed as This computer first, whatever the setting says, since a delegated thread starts nowhere else yet.
  expect(f.machines.place).toHaveBeenCalledExactlyOnceWith({ machine: undefined, os: 'windows' }, { hostId: f.local, projectId: project }, 'this-computer')
  // A retry reads the first delegation and places nothing again.
  const input = { provider: 'codex', model: f.model('codex').id, machine: f.local, wait_seconds: 0, retry_key: '5b0c3c0e-8f1a-4d6e-9b2a-1c3d4e5f6a7b' }
  const first = f.ok(await f.delegate(parent, input))
  expect(f.ok(await f.delegate(parent, input)).delegation.id).toBe(first.delegation.id)
  expect(f.machines.place).toHaveBeenCalledTimes(2)
})

it('refuses and records a machine other than This computer, and a system no connected machine runs, starting nothing (#1032)', async () => {
  const f = await fixture(), parent = await f.userThread('claude')
  f.machines.place.mockImplementationOnce(async () => ({ hostId: FORGE, projectId: 'forge-sotto', receipt: { hostId: FORGE, name: 'forge', awayFromDefault: true } }))
  const elsewhere = await f.delegate(parent, { provider: 'codex', model: f.model('codex').id, machine: FORGE, wait_seconds: 0 })
  expect(elsewhere).toMatchObject({ status: 'refused', code: 'MACHINE_UNAVAILABLE', delegation: expect.any(String),
    message: 'A delegated thread starts only on This computer for now, so it cannot start on forge. Leave out the machine and system to start it here. Nothing was started.' })
  const none = await f.delegate(parent, { provider: 'codex', model: f.model('codex').id, os: 'macos', wait_seconds: 0 })
  expect(none).toMatchObject({ status: 'refused', code: 'MACHINE_UNAVAILABLE', message: 'No Mac is connected. Connect a Mac, or run this on This computer. Nothing was started.' })
  expect(f.control.shell().host.threads.filter(thread => thread.delegatedBy === parent)).toHaveLength(0)
  // Both are recorded as refused, under their rule, and read back by ID.
  const read = await f.service.read(parent, {}) as { delegations: { outcome: string; refusal?: string }[] }
  expect(read.delegations).toEqual([expect.objectContaining({ outcome: 'refused', refusal: 'MACHINE_UNAVAILABLE' }), expect.objectContaining({ outcome: 'refused', refusal: 'MACHINE_UNAVAILABLE' })])
})

it('refuses a machine on a brief to a thread it delegated to, which already runs where it runs (#1032)', async () => {
  const f = await fixture(), parent = await f.userThread('claude')
  const started = f.ok(await f.delegate(parent, { provider: 'codex', model: f.model('codex').id, wait_seconds: 0 }))
  expect(await f.delegate(parent, { thread: started.delegation.thread, machine: FORGE })).toMatchObject({ status: 'refused', code: 'INVALID_INPUT' })
})

it('lists the machines as Watcher does through list_machines while Work across machines is on, and offers none while it is off (#1032)', async () => {
  const f = await fixture(), parent = await f.userThread('claude')
  const on = new DelegationToolServer(f.service, { machines: true }), off = new DelegationToolServer(f.service)
  cleanups.push(async () => { await on.close(); await off.close() })
  expect((await on.call(parent, 'list_machines', {})).structuredContent).toMatchObject({ status: 'ok', machines: [{ name: 'This computer' }, { name: 'forge' }] })
  expect(off.definitions.map(tool => tool.name)).not.toContain('list_machines')
  expect(f.machines.list).toHaveBeenCalledOnce()
})

it('refuses a machine or system as invalid while Work across machines is off, recording nothing (#1032)', async () => {
  const f = await delegationFixture(cleanups), parent = await f.userThread('claude')
  expect(await f.delegate(parent, { provider: 'codex', model: f.model('codex').id, machine: FORGE })).toEqual({ status: 'refused', code: 'INVALID_INPUT',
    message: 'This call has invalid or oversized arguments. Use the offered tool schema. Nothing was started.' })
  expect(await f.delegate(parent, { provider: 'codex', model: f.model('codex').id, os: 'linux' })).toMatchObject({ status: 'refused', code: 'INVALID_INPUT' })
  expect((await f.service.read(parent, {}) as { delegations: unknown[] }).delegations).toEqual([])
  expect(await f.service.machines(parent)).toMatchObject({ status: 'refused', code: 'INVALID_INPUT' })
})
