// @vitest-environment node
/**
 * The desktop relay inside delegation (#1316): the desktop admits a thread on another machine as one of its own callers,
 * under its own ceiling and levels, and a host's thread starts elsewhere through the relay or is refused by name.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DelegationService, type DelegationControlHooks, type DelegationCoordinator, type DelegationServiceOptions, type RelayedCaller } from '../../../src/main/agents/delegation'
import { RelayUnanswered } from '../../../src/main/agents/delegationRelayHost'
import { EMPTY_AGENT_HOST, type AgentCommand, type AgentHostSnapshot, type AgentModel, type AgentThread } from '../../../src/shared/agents'
import { relayAwayWords } from '../../../src/shared/delegationRelay'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-relay-admission-')) throw new Error('Unexpected test directory')
    await rm(root, { recursive: true, force: true })
  }
})
const HOST = '11111111-1111-4111-8111-111111111111', DESKTOP = '22222222-2222-4222-8222-222222222222', RELAYED = '44444444-4444-4444-8444-444444444444'
const model = { id: 'model', name: 'Model', providerId: 'codex', ready: true, reasoningEfforts: [], runtimeModes: ['approval-required', 'auto-accept-edits', 'auto', 'full-access'] } as unknown as AgentModel
const thread = (id: string, patch: Partial<AgentThread> = {}): AgentThread =>
  ({ id, projectId: 'project', providerId: 'codex', title: id, modelId: 'model', status: 'idle', runtimeMode: 'full-access', messages: [{ id: `${id}-ask`, role: 'user', text: 'Do it.' }], requests: [], ...patch }) as AgentThread

async function service(options: Partial<DelegationServiceOptions>, configured: 'auto-accept-edits' | 'full-access' = 'full-access') {
  const root = await mkdtemp(join(tmpdir(), 'sotto-relay-admission-')); roots.push(root)
  const snapshot: AgentHostSnapshot = { ...EMPTY_AGENT_HOST, connected: true, models: [model], projects: [{ id: 'project', title: 'Project', path: join(root, 'project') }] as never,
    threads: [thread('parent')] }
  const commands: AgentCommand[] = []
  let hooks: DelegationControlHooks | undefined
  const control: DelegationCoordinator = {
    hostId: () => HOST, watcherSnapshot: () => snapshot, configuration: () => ({ newThreadRuntimeMode: configured }),
    useDelegation: given => { hooks = given; return () => undefined },
    // The coordinator's own last guard runs before anything is created, as the real one runs it at the writer.
    commandFromDelegation: async (command, guard) => { guard(); commands.push(command); return { host: snapshot } as never },
    hasPendingThreadWork: () => false, hasUserDraft: () => false, refreshDelegationObservation: () => undefined,
    deliverWakeUp: async () => undefined,
  }
  const delegation = new DelegationService({ directory: root, control, host: { setDelegatedBy: async () => undefined, threadMessage: () => undefined },
    historyEnabled: () => true, ...options })
  await delegation.recover()
  return { delegation, commands, hooks: () => hooks! }
}
const start = { work: 'code-review', brief: 'Review it.', provider: 'codex', model: 'model', permission: 'full-access', wait_seconds: 0 }

describe('a relayed caller on the desktop', () => {
  const key = `host:${HOST}:parent-there`
  const caller = (levels: number, runtimeMode: RelayedCaller['runtimeMode'] = 'full-access'): RelayedCaller => ({ id: key, projectId: 'project', runtimeMode, levels, rootUserMessageId: 'root-there' })

  it('starts its thread here, held to the narrower of its own permission and this computer\'s default', async () => {
    const f = await service({ relayedCallers: { caller: id => id === key ? caller(0, 'auto') : undefined, tell: async () => undefined } }, 'full-access')
    expect(f.delegation.admits(key)).toBe(true)
    expect(await f.delegation.delegate(key, { ...start, permission: 'full-access' })).toMatchObject({ status: 'refused', code: 'PERMISSION_TOO_WIDE' })
    const answer = await f.delegation.delegate(key, { ...start, permission: 'auto' }) as { status: string; delegation: { id: string } }
    expect(answer.status).toBe('ok')
    expect(f.commands.find(command => command.type === 'create-thread')).toMatchObject({ type: 'create-thread', projectId: 'project', runtimeMode: 'auto' })
    // The final guard held the start to the relayed caller's own permission, and let it through: the thread was made.
    expect(f.commands.filter(command => command.type === 'create-thread')).toHaveLength(1)
    const narrower = await service({ relayedCallers: { caller: id => id === key ? caller(0, 'full-access') : undefined, tell: async () => undefined } }, 'auto-accept-edits')
    expect(await narrower.delegation.delegate(key, { ...start, permission: 'auto' })).toMatchObject({ status: 'refused', code: 'PERMISSION_TOO_WIDE' })
  })

  it('counts the levels above it on its own machine', async () => {
    const f = await service({ relayedCallers: { caller: id => id === key ? caller(2) : undefined, tell: async () => undefined } })
    expect(await f.delegation.delegate(key, start)).toMatchObject({ status: 'refused', code: 'LEVEL_LIMIT' })
    // A thread no machine named is no caller at all.
    expect(f.delegation.admits(`host:${HOST}:someone-else`)).toBe(false)
  })
})

describe('a thread on a host delegating elsewhere', () => {
  const machines = (reachable: boolean): NonNullable<DelegationServiceOptions['machines']> => ({
    list: async () => ({}), name: () => 'This machine', setting: () => 'this-computer',
    place: async ask => ask.machine === HOST ? { hostId: HOST, projectId: '', receipt: { hostId: HOST, name: 'This machine', awayFromDefault: false } }
      : reachable ? { hostId: DESKTOP, projectId: 'project', receipt: { hostId: DESKTOP, name: 'Another machine', awayFromDefault: false } }
        : { status: 'refused', code: 'HOST_DISCONNECTED', message: relayAwayWords('forge'), retryable: true },
  })
  const relay = (answer: () => Promise<Record<string, unknown>>) => {
    const asked: unknown[] = []
    return { asked, relay: { start: async (callerId: string, work: string, ask: unknown) => { asked.push({ callerId, work, ask }); return answer() },
      holds: () => false, holdsThread: () => false, read: async () => ({}), cancel: async () => ({}), list: () => [], useDelivery: () => undefined, awayWords: () => relayAwayWords('forge'),
      detail: (delegationId: string) => delegationId === RELAYED ? { reply: { messageId: 'reply-1', text: 'Synthetic finding from This computer', truncated: false } } : undefined } as never as NonNullable<DelegationServiceOptions['relay']> & { start: unknown } }
  }

  it('asks the desktop for a start on another machine, with what its admission found here', async () => {
    const r = relay(async () => ({ status: 'ok', delegation: { id: '44444444-4444-4444-8444-444444444444', outcome: 'working' } }))
    const f = await service({ machines: machines(true), relay: r.relay })
    expect(await f.delegation.delegate('parent', { ...start, machine: DESKTOP })).toMatchObject({ status: 'ok' })
    expect(r.asked).toEqual([{ callerId: 'parent', work: 'code-review', ask: expect.objectContaining({ levels: 0, rootUserMessageId: 'parent-ask', runtimeMode: 'full-access', projectId: 'project', machine: DESKTOP,
      input: expect.not.objectContaining({ machine: DESKTOP }) }) }])
    // Nothing started here.
    expect(f.commands).toEqual([])
    // A branch to start from is not carried yet, and is refused before anything is asked.
    expect(await f.delegation.delegate('parent', { ...start, machine: DESKTOP, from_my_branch: true })).toMatchObject({ status: 'refused', code: 'BRANCH_UNAVAILABLE' })
    expect(r.asked).toHaveLength(1)
  })

  it('words an answered relayed delegation\'s wake-up with its reply, labelled as the delegated thread\'s words', async () => {
    const r = relay(async () => ({ status: 'ok' }))
    const f = await service({ machines: machines(true), relay: r.relay })
    const text = f.hooks().newsText?.('parent', [{ source: 'delegation', items: [{ delegationId: RELAYED, threadId: 'child-there', outcome: 'answered' }] }])
    expect(text).toContain('Synthetic finding from This computer')
    expect(text).toContain('in the delegated thread\'s own words')
  })

  it('records the away refusal by name, with nothing queued, and the desktop\'s own refusals as its own', async () => {
    const away = relay(async () => { throw new RelayUnanswered('away') })
    const f = await service({ machines: machines(false), relay: away.relay })
    const refused = await f.delegation.delegate('parent', { ...start, machine: DESKTOP })
    expect(refused).toMatchObject({ status: 'refused', code: 'MACHINE_UNAVAILABLE', message: relayAwayWords('forge'), delegation: expect.any(String) })
    expect(f.delegation.views('parent').made).toEqual([expect.objectContaining({ outcome: 'refused', refusal: 'MACHINE_UNAVAILABLE', away: true, asked: { machine: DESKTOP } })])
    expect(away.asked).toEqual([])
    const there = relay(async () => ({ status: 'refused', code: 'PERMISSION_TOO_WIDE', message: 'Too wide there. Nothing was started.' }))
    const g = await service({ machines: machines(true), relay: there.relay })
    expect(await g.delegation.delegate('parent', { ...start, machine: DESKTOP })).toMatchObject({ status: 'refused', code: 'PERMISSION_TOO_WIDE', message: 'Too wide there. Nothing was started.' })
    expect(g.delegation.views('parent').made).toEqual([expect.not.objectContaining({ away: true })])
    // One the desktop refused for its machine is recorded as relayed, which its card words (Zach, October 27, 2026).
    const mac = relay(async () => ({ status: 'refused', code: 'MACHINE_UNAVAILABLE', message: 'The Mac has no copy. Nothing was started.' }))
    const h = await service({ machines: machines(true), relay: mac.relay })
    await h.delegation.delegate('parent', { ...start, machine: DESKTOP })
    expect(h.delegation.views('parent').made).toEqual([expect.objectContaining({ refusal: 'MACHINE_UNAVAILABLE', relayed: true, asked: { machine: DESKTOP } })])
  })
})
