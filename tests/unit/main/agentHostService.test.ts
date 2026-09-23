// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mayGrantLocally, UNPAIRED_CLIENT_ERROR, type Authority } from '../../../src/main/agents/authority'
import { AgentControl } from '../../../src/main/agents/control'
import { AgentCredentials, type CredentialEncryption } from '../../../src/main/agents/credentials'
import type { AgentHostCommand } from '../../../src/main/agents/host'
import {
  desktopWindowClient, LocalHostService, supervisionClient, DESKTOP_WINDOW_CLIENT_ID, SUPERVISION_CLIENT_ID,
  type ClientIdentity, type HostService,
} from '../../../src/main/agents/hostService'
import { E2EAgentHost, e2eAgentReasoner } from '../../../src/main/e2e/agentEffects'
import { PolicyStore } from '../../../src/main/memory/policies'
import { MemoryStore } from '../../../src/main/memory/store'
import type { AnswerGivenEvent, StoredThreadEvent } from '../../../src/shared/threadEvents'
import { immediatePublishScheduler } from '../../fixtures/publishScheduler'

const roots: string[] = []
const controls: AgentControl[] = []
const stores: MemoryStore[] = []
const encryption: CredentialEncryption = {
  isEncryptionAvailable: () => true,
  encryptString: value => Buffer.from(Buffer.from(value).map(byte => byte ^ 0xa5)),
  decryptString: value => Buffer.from(value.map(byte => byte ^ 0xa5)).toString('utf8'),
}

/** Records answers the way `WorkspaceHost` does, without a SQLite file behind it. */
class RecordingHost extends E2EAgentHost {
  readonly executed: AgentHostCommand[] = []
  readonly answers: { threadId: string; event: AnswerGivenEvent }[] = []
  override async execute(command: AgentHostCommand) {
    this.executed.push(command)
    return super.execute(command)
  }
  recordAnswer(threadId: string, event: AnswerGivenEvent): void { this.answers.push({ threadId, event }) }
}

async function fixture(authority?: Authority) {
  const logFailure = vi.fn<(code: string, detail: string) => void>()
  const root = await mkdtemp(join(tmpdir(), 'sotto-host-service-'))
  roots.push(root)
  const credentials = new AgentCredentials(join(root, 'vault'), encryption)
  await credentials.load()
  const host = new RecordingHost()
  const reasoner = { ...e2eAgentReasoner, decide: vi.fn(e2eAgentReasoner.decide) }
  const control = new AgentControl({
    schedule: immediatePublishScheduler, directory: root, host, credentials,
    reasoner, logFailure,
    ...(authority === undefined ? {} : { authority }),
    membership: {
      status: async () => ({ status: 'beta', label: 'Fixture beta', expiresAt: null }),
      action: async () => ({ status: 'beta', label: 'Fixture beta', expiresAt: null }),
    },
  })
  controls.push(control)
  await control.start()
  const service: HostService = new LocalHostService({ control })
  await service.command({ type: 'connect' }, desktopWindowClient('tester'))
  await service.command({ type: 'assign', threadId: 'workshop', instruction: 'Fix the tests' }, desktopWindowClient('tester'))
  return {
    control, host, service, reasoner, logFailure,
    permission(text = 'May I edit the tests?') {
      host.event({ type: 'permission', threadId: 'workshop', requestId: 'permission', text })
    },
    question(text = 'Which branch?') {
      host.event({ type: 'question', threadId: 'workshop', requestId: 'question', text })
    },
    answer(client: ClientIdentity, answer = 'Allow once', approved: boolean | undefined = true) {
      return service.command({ type: 'answer', threadId: 'workshop', requestId: 'permission', answer,
        ...(approved === undefined ? {} : { approved }) }, client)
    },
  }
}

function policyStore(root: string): PolicyStore {
  const memoryStore = new MemoryStore(join(root, 'memory.sqlite'))
  stores.push(memoryStore)
  memoryStore.open()
  return new PolicyStore(memoryStore)
}

afterEach(async () => {
  for (const control of controls.splice(0)) control.dispose()
  for (const store of stores.splice(0)) store.close()
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-host-service-')) throw new Error('Unexpected temporary test directory')
    await rm(root, { recursive: true, force: true })
  }
})

describe('the host service boundary', () => {
  it('hands a client the shell, a thread detail and the state, and no events without a store', async () => {
    const f = await fixture()
    expect(f.service.shell().host.threads.map(thread => thread.id)).toContain('workshop')
    expect(f.service.shell().host.threads.every(thread => thread.messages.length === 0)).toBe(true)
    expect(f.service.state().connection).toBe('connected')
    expect(f.service.threadDetail('workshop')?.threadId).toBe('workshop')
    expect(f.service.threadDetail('nothing')).toBeNull()
    expect(f.service.events(0)).toEqual([])
  })

  it('reads the log after a sequence number from the event source it was given', async () => {
    const f = await fixture()
    const stored: StoredThreadEvent[] = [{ seq: 7, threadId: 'workshop', event: { kind: 'messages-reset', at: '2026-09-19T09:00:00.000Z' } }]
    const eventsAfter = vi.fn(() => stored)
    const service = new LocalHostService({ control: f.control, events: { eventsAfter } })
    expect(service.events(6, 'workshop')).toEqual(stored)
    expect(eventsAfter).toHaveBeenCalledWith(6, 'workshop', undefined)
  })

  it('passes a listener straight through to the coordinator', async () => {
    const f = await fixture()
    const listener = vi.fn()
    const stop = f.service.subscribe(listener)
    f.permission()
    await f.control.command({ type: 'select-thread', threadId: 'workshop' })
    expect(listener).toHaveBeenCalled()
    stop()
    const before = listener.mock.calls.length
    await f.control.command({ type: 'select-thread', threadId: 'workshop' })
    expect(listener.mock.calls.length).toBe(before)
  })
})

describe('attribution on an answer', () => {
  it('records who answered, with the choice and no answer text', async () => {
    const f = await fixture()
    f.permission()
    expect((await f.answer(desktopWindowClient('tester'), 'Allow once')).error).toBeNull()
    expect(f.host.executed).toContainEqual(expect.objectContaining({ type: 'answer', answer: 'Allow once' }))
    expect(f.host.answers).toHaveLength(1)
    const [recorded] = f.host.answers
    expect(recorded?.threadId).toBe('workshop')
    expect(recorded?.event).toEqual({
      kind: 'answer-given', at: expect.any(String), requestId: 'permission', approved: true,
      attribution: { clientId: DESKTOP_WINDOW_CLIENT_ID, user: 'tester', transport: 'ipc' },
    })
    expect(JSON.stringify(recorded?.event)).not.toContain('Allow once')
  })

  it('records a question’s chosen options by id alone', async () => {
    const f = await fixture()
    f.host.event({ type: 'question', threadId: 'workshop', requestId: 'permission', text: 'Which branch?',
      request: { id: 'permission', kind: 'question', text: 'Which branch?', options: [],
        questions: [{ id: 'branch', question: 'Which branch?', multiSelect: false, allowFreeText: true,
          options: [{ id: 'main', label: 'main' }, { id: 'next', label: 'next' }] }] } })
    const state = await f.service.command({ type: 'answer', threadId: 'workshop', requestId: 'permission', answer: 'the main one please',
      questionAnswers: { branch: { optionIds: ['main'], text: 'the main one please' } } }, desktopWindowClient('tester'))
    expect(state.error).toBeNull()
    expect(f.host.answers[0]?.event).toMatchObject({ requestId: 'permission', questionOptionIds: ['main'] })
    expect(JSON.stringify(f.host.answers[0]?.event)).not.toContain('the main one please')
  })

  it('attributes the coordinator’s own follow-up answer to Sotto rather than to the user', async () => {
    expect(supervisionClient('tester')).toEqual({ clientId: SUPERVISION_CLIENT_ID, user: 'tester', transport: 'ipc' })
    const f = await fixture()
    await f.service.command({ type: 'configure', patch: { reasoning: 'openrouter', reasoningModel: 'fixture-model' } }, desktopWindowClient('tester'))
    f.reasoner.decide.mockResolvedValue({ decision: 'followup', text: 'Use the main branch' })
    f.question()
    await vi.waitFor(() => expect(f.host.answers).toHaveLength(1))
    expect(f.host.answers[0]?.event.attribution).toEqual({ clientId: SUPERVISION_CLIENT_ID, user: expect.any(String), transport: 'ipc' })
    expect(f.host.answers[0]?.event.attribution.clientId).not.toBe(DESKTOP_WINDOW_CLIENT_ID)
  })

  it('leaves the answer standing and says nothing to the user when the record cannot be written', async () => {
    const f = await fixture()
    vi.spyOn(f.host, 'recordAnswer').mockImplementation(() => { throw new Error('disk full') })
    f.permission()
    expect((await f.answer(desktopWindowClient('tester'))).error).toBeNull()
    expect(f.host.executed).toContainEqual(expect.objectContaining({ type: 'answer' }))
    expect(f.logFailure).toHaveBeenCalledWith('thread-answer-attribution-failed', 'workshop')
  })
})

describe('whether a client may grant', () => {
  it('lets the local window answer and refuses a socket client with no policy store', async () => {
    expect(mayGrantLocally(desktopWindowClient('tester'))).toEqual({ allowed: true, reason: 'local-window' })
    expect(mayGrantLocally({ clientId: 'laptop', user: 'tester', transport: 'socket' })).toEqual({ allowed: false, reason: 'no-policy' })
    const f = await fixture()
    f.permission()
    const state = await f.answer({ clientId: 'laptop', user: 'tester', transport: 'socket' })
    expect(state.error).toBe(UNPAIRED_CLIENT_ERROR)
    expect(f.host.executed.filter(command => command.type === 'answer')).toEqual([])
    expect(f.host.answers).toEqual([])
  })

  it('refuses an unpaired socket client before anything reaches the provider', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-host-service-'))
    roots.push(root)
    const policies = policyStore(root)
    const f = await fixture(policies)
    f.permission()
    const state = await f.answer({ clientId: 'laptop', user: 'tester', transport: 'socket' })
    expect(state.error).toBe(UNPAIRED_CLIENT_ERROR)
    expect(f.host.executed.filter(command => command.type === 'answer')).toEqual([])
    expect(f.control.get().queue).toContainEqual(expect.objectContaining({ requestId: 'permission' }))
  })

  it('lets a client a policy record names answer, and refuses it again once revoked', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-host-service-'))
    roots.push(root)
    const policies = policyStore(root)
    const record = policies.grantRemoteAnswers('laptop', 'Paired on this PC')
    const f = await fixture(policies)
    const client: ClientIdentity = { clientId: 'laptop', user: 'tester', transport: 'socket' }
    expect(policies.mayGrant(client)).toEqual({ allowed: true, reason: 'paired-client', policyId: record.id })
    f.permission()
    expect((await f.answer(client)).error).toBeNull()
    expect(f.host.answers[0]?.event.attribution).toEqual({ clientId: 'laptop', user: 'tester', transport: 'socket' })
    policies.revoke(record.id)
    expect(policies.mayGrant(client)).toEqual({ allowed: false, reason: 'unpaired', policyId: record.id })
    f.permission()
    expect((await f.answer(client)).error).toBe(UNPAIRED_CLIENT_ERROR)
  })

  it('never reads a grant for one client off another client’s record or a global one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-host-service-'))
    roots.push(root)
    const policies = policyStore(root)
    policies.grantRemoteAnswers('laptop', 'Paired on this PC')
    policies.grant({ action: 'remote-answer', resource: '*', scope: 'global', note: 'Too broad to be an answer about a client' })
    expect(policies.mayGrant({ clientId: 'phone', user: 'tester', transport: 'socket' })).toEqual({ allowed: false, reason: 'no-policy' })
    expect(policies.mayGrant(desktopWindowClient('tester'))).toEqual({ allowed: true, reason: 'local-window' })
  })
})
