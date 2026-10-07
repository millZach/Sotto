// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { classifyRiskyAction, mayGrantLocally, UNPAIRED_CLIENT_ERROR, type Authority, type RiskyAction } from '../../../src/main/agents/authority'
import { AgentControl } from '../../../src/main/agents/control'
import { AgentCredentials, type CredentialEncryption } from '../../../src/main/agents/credentials'
import type { AgentHostCommand } from '../../../src/main/agents/host'
import type { ClientIdentity } from '../../../src/main/agents/hostService'
import { TurnRecorder } from '../../../src/main/agents/turns'
import { E2EAgentHost, e2eAgentReasoner } from '../../../src/main/e2e/agentEffects'
import { PolicyStore } from '../../../src/main/memory/policies'
import { MemoryStore } from '../../../src/main/memory/store'
import { immediatePublishScheduler } from '../../fixtures/publishScheduler'

const roots: string[] = []
const controls: AgentControl[] = []
const stores: MemoryStore[] = []
const encryption: CredentialEncryption = {
  isEncryptionAvailable: () => true,
  encryptString: value => Buffer.from(Buffer.from(value).map(byte => byte ^ 0xa5)),
  decryptString: value => Buffer.from(value.map(byte => byte ^ 0xa5)).toString('utf8'),
}

class RecordingHost extends E2EAgentHost {
  readonly executed: AgentHostCommand[] = []
  permissionOnSnapshot = false
  override async execute(command: AgentHostCommand) {
    this.executed.push(command)
    return super.execute(command)
  }
  override async snapshot() {
    const snapshot = await super.snapshot()
    if (this.permissionOnSnapshot) {
      for (const thread of snapshot.threads) for (const request of thread.requests) request.kind = 'permission'
    }
    return snapshot
  }
}

async function fixture(partialAuthority?: Pick<Authority, 'authorizes'> & Partial<Authority>, recordTurns = true) {
  // A PolicyStore is handed through whole; a plain mock gets the local-only `mayGrant` beside it.
  const authority: Authority | undefined = partialAuthority === undefined ? undefined
    : 'mayGrant' in partialAuthority ? partialAuthority as Authority
      : { mayGrant: mayGrantLocally, authorizes: query => partialAuthority.authorizes(query) }
  const root = await mkdtemp(join(tmpdir(), 'sotto-agent-authority-'))
  roots.push(root)
  const credentials = new AgentCredentials(join(root, 'vault'), encryption)
  await credentials.load()
  const recorder = new TurnRecorder({ directory: root, resolveSession: id => ({ provider: 'codex', sessionId: `session-${id}` }) })
  const reasoner = { ...e2eAgentReasoner, decide: vi.fn(e2eAgentReasoner.decide) }
  const host = new RecordingHost()
  const control = new AgentControl({ schedule: immediatePublishScheduler, directory: root, host, credentials, reasoner,
    ...(recordTurns ? { turns: recorder } : {}),
    ...(authority === undefined ? {} : { authority }),
  })
  controls.push(control)
  await control.start()
  await control.command({ type: 'connect' })
  await control.command({ type: 'assign', threadId: 'workshop', instruction: 'Fix the tests' })
  return { root, control, host, reasoner, recorder,
    permission(text = 'May I publish the release to npm?') {
      host.event({ type: 'permission', threadId: 'workshop', requestId: 'permission', text })
    },
    answer(answer: string, approved = true) {
      return control.command({ type: 'answer', threadId: 'workshop', requestId: 'permission', answer, approved })
    },
  }
}

async function policyFixture() {
  const root = await mkdtemp(join(tmpdir(), 'sotto-agent-authority-'))
  roots.push(root)
  const memoryStore = new MemoryStore(join(root, 'memory.sqlite'))
  stores.push(memoryStore)
  memoryStore.open()
  return { memoryStore, policies: new PolicyStore(memoryStore) }
}

afterEach(async () => {
  for (const control of controls.splice(0)) control.dispose()
  for (const store of stores.splice(0)) store.close()
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-agent-authority-')) throw new Error('Unexpected temporary test directory')
    await rm(root, { recursive: true, force: true })
  }
})

const classes: [RiskyAction, string][] = [
  ['destroy', 'git push --force'], ['destroy', 'git push -f'], ['destroy', 'push to main'],
  ['destroy', 'push origin main'], ['destroy', 'git clean -fd'], ['destroy', 'reset --hard'],
  ['destroy', 'git reset --hard HEAD~1'], ['destroy', 'rm -rf'], ['destroy', 'drop table'],
  ['destroy', 'overwrite'], ['destroy', 'truncate'],
  ['publish', 'deploy to production'], ['publish', 'publish the package'], ['publish', 'npm publish'],
  ['publish', 'create a GitHub release'], ['publish', 'cut a release'],
  ['spend', 'pay'], ['spend', 'purchase'], ['spend', 'subscribe'],
  ['spend', 'charge the card'], ['spend', 'buy credits'], ['spend', 'spend'],
  ['relax-verification', 'skip CI'], ['relax-verification', '--no-verify'],
  ['relax-verification', '--no-gpg-sign'], ['relax-verification', 'skip the tests'],
  ['relax-verification', 'disable the checks'], ['relax-verification', 'bypass'],
]

const ordinary = [
  'edit deploy.md', 'read the release notes', 'remove the unused import', 'delete a blank line',
  'open credits.txt', 'update docs/billing.md', 'May I edit the tests?',
  'republish deployments buyer discharged', 'x--forceful',
  'edit publish.md', 'read spend.txt', 'open truncate.sql', 'x--no-verify', '--no-verify-extra',
]

describe('risky action classification', () => {
  it.each(classes)('classifies %s command %s', (action, text) => {
    expect(classifyRiskyAction({ kind: 'permission', text: `May I ${text.toUpperCase()}?` })).toEqual([action])
  })
  it.each(ordinary)('leaves ordinary permission %s unclassified', text => {
    expect(classifyRiskyAction({ kind: 'permission', text })).toEqual([])
  })
  it.each(classes)('never classifies questions about %s command %s', (_action, text) => {
    expect(classifyRiskyAction({ kind: 'question', text })).toEqual([])
  })
  it.each<[string, RiskyAction[]]>([
    ['publish the package and buy credits', ['spend', 'publish']],
    ['git push --force and skip CI', ['destroy', 'relax-verification']],
    ['publish the package then npm publish', ['publish']],
  ])('returns every matching class once for %s', (text, actions) => {
    const result = classifyRiskyAction({ kind: 'permission', text })
    expect([...result].sort()).toEqual([...actions].sort())
    expect(classifyRiskyAction({ kind: 'permission', text })).toEqual(result)
  })
})

describe('authority at dispatch', () => {
  it.each([false, true])('records one attribution for an uncertain answer with accepted %s', async accepted => {
    const f = await fixture()
    const recordAnswer = vi.fn()
    Object.assign(f.host, { recordAnswer })
    f.permission()
    const execute = vi.spyOn(f.host, 'execute').mockResolvedValueOnce({ accepted, uncertain: true })
    expect((await f.answer('Allow')).error).toBeTruthy()
    expect(recordAnswer).toHaveBeenCalledExactlyOnceWith('workshop', expect.objectContaining({
      kind: 'answer-given', requestId: 'permission', approved: true,
      attribution: expect.objectContaining({ clientId: 'desktop-window', transport: 'ipc' }),
    }))
    expect(JSON.parse(await readFile(join(f.root, 'agents.json'), 'utf8')).outbox).toContainEqual(expect.objectContaining({
      type: 'answer', threadId: 'workshop', requestId: 'permission',
    }))
    await f.answer('Allow')
    expect(recordAnswer).toHaveBeenCalledOnce()
    expect(execute).toHaveBeenCalledOnce()
  })

  it.each([
    { accepted: true, requestLeaves: false, completion: false },
    { accepted: true, requestLeaves: true, completion: false },
    { accepted: false, requestLeaves: true, completion: false },
    { accepted: false, requestLeaves: false, completion: true },
  ])('keeps a phone answer uncertainty private to its caller: %j', async ({ accepted, requestLeaves, completion }) => {
    const f = await fixture({ authorizes: () => ({ allowed: false, reason: 'no-policy' }),
      mayGrant: () => ({ allowed: true, reason: 'paired-client' }) })
    f.permission()
    const before = f.control.get().speech
    const publishedErrors: Array<string | null> = []
    const off = f.control.subscribe(state => { publishedErrors.push(state.error) })
    const execute = f.host.execute.bind(f.host)
    vi.spyOn(f.host, 'execute').mockImplementationOnce(async command => {
      if (requestLeaves) await execute(command)
      return { accepted, uncertain: true, ...(completion ? { answerCompletion: Promise.resolve(false) } : {}) }
    })
    try {
      const result = await f.control.command({ type: 'answer', threadId: 'workshop', requestId: 'permission', answer: 'Allow', approved: true },
        { clientId: 'phone', user: 'Fixture client', transport: 'socket' })
      expect(result.error).toBeTruthy()
      expect(f.control.get().error).toBeNull()
      expect(publishedErrors.every(error => error === null)).toBe(true)
      expect(f.control.get().speech.id).toBe(before.id)
    } finally { off() }
  })

  it('leaves a definitively refused answer without attribution', async () => {
    const f = await fixture()
    const recordAnswer = vi.fn()
    Object.assign(f.host, { recordAnswer })
    f.permission()
    vi.spyOn(f.host, 'execute').mockResolvedValueOnce({ accepted: false })
    expect((await f.answer('Allow')).error).toBeTruthy()
    expect(recordAnswer).not.toHaveBeenCalled()
  })
  it.each([false, true])('preserves command client context when permitted is %s', async allowed => {
    const client: ClientIdentity = { clientId: 'fixture-client', user: 'Fixture client', transport: 'socket', selectedThreadId: 'workshop' }
    const f = await fixture({ authorizes: () => ({ allowed: false, reason: 'no-policy' }),
      mayGrant: identity => identity.transport === 'ipc' ? { allowed: true, reason: 'local-window' }
        : { allowed, reason: allowed ? 'paired-client' : 'no-policy' } })
    const recordAnswer = vi.fn()
    Object.assign(f.host, { recordAnswer })
    f.host.event({ type: 'question', threadId: 'workshop', requestId: 'choice', text: 'Which color?' })
    await f.control.command({ type: 'select-thread', threadId: 'workshop' })
    await f.control.command({ type: 'compose', text: 'Blue' })
    const result = await f.control.commandShell({ type: 'send' }, client)
    if (allowed) {
      expect(result.error).toBeNull()
      expect(recordAnswer).toHaveBeenCalledWith('workshop', expect.objectContaining({ attribution: { clientId: client.clientId, user: client.user, transport: client.transport } }))
    } else {
      expect(result.error).toBe(UNPAIRED_CLIENT_ERROR)
      expect(f.host.executed.filter(command => command.type === 'answer')).toEqual([])
      expect(recordAnswer).not.toHaveBeenCalled()
    }
  })
  it.each([false, true])('retains an ordinary selected draft binding when answer permission is %s', async allowed => {
    const client: ClientIdentity = { clientId: 'fixture-client', user: 'Fixture client', transport: 'socket', selectedThreadId: 'workshop' }
    const f = await fixture({ authorizes: () => ({ allowed: false, reason: 'no-policy' }),
      mayGrant: identity => identity.transport === 'ipc' ? { allowed: true, reason: 'local-window' }
        : { allowed, reason: allowed ? 'paired-client' : 'no-policy' } })
    await f.control.commandShell({ type: 'compose', text: 'Ordinary prompt' }, client)
    f.host.event({ type: 'question', threadId: 'workshop', requestId: 'choice', text: 'Which color?' })
    await vi.waitFor(() => expect(f.control.get().queue.some(item => item.requestId === 'choice')).toBe(true))
    const edited = await f.control.commandShell({ type: 'compose', text: 'Edited prompt' }, client)
    expect(edited.error).toBeNull()
    expect(edited.threadDrafts?.find(draft => draft.threadId === 'workshop')).toMatchObject({ text: 'Edited prompt', requestId: null })
    const sent = await f.control.commandShell({ type: 'send' }, client)
    expect(sent.error).toContain('Answer the pending question')
    expect(f.host.executed.filter(command => command.type === 'answer')).toEqual([])
  })

  it('keeps the compose client check consistent with send', async () => {
    const client: ClientIdentity = { clientId: 'fixture-client', user: 'Fixture client', transport: 'socket', selectedThreadId: 'workshop' }
    const f = await fixture({ authorizes: () => ({ allowed: false, reason: 'no-policy' }),
      mayGrant: identity => identity.transport === 'ipc' ? { allowed: true, reason: 'local-window' }
        : { allowed: false, reason: 'no-policy' } })
    await f.control.command({ type: 'configure', patch: { reasoning: 'openrouter', reasoningModel: 'fixture-model' } })
    await f.control.command({ type: 'select-thread', threadId: 'workshop' })
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const intent = vi.spyOn(f.reasoner, 'intent').mockImplementation(async () => {
      await held
      return { type: 'clarify', text: 'Which action?' }
    })
    const thinking = f.control.command({ type: 'utterance', text: 'Choose the next action' })
    await vi.waitFor(() => expect(intent).toHaveBeenCalled())
    const composing = f.control.commandShell({ type: 'compose', text: 'Blue' }, client)
    try {
      f.host.event({ type: 'question', threadId: 'workshop', requestId: 'choice', text: 'Which color?' })
    } finally { release() }
    await thinking
    const result = await composing
    expect(result.error).toBe(UNPAIRED_CLIENT_ERROR)
    expect(result.draft).not.toBe('Blue')
    expect(result.composing).toBe(false)
    expect(result.draftRequestId).toBeNull()
    expect(result.threadDrafts?.some(draft => draft.requestId === 'choice')).not.toBe(true)
    expect(f.host.executed.filter(command => command.type === 'answer')).toEqual([])
  })

  it('supervision leaves a pending permission in the attention queue', async () => {
    const f = await fixture({ authorizes: () => ({ allowed: true, reason: 'allowed' }) })
    await f.control.command({ type: 'configure', patch: { reasoning: 'openrouter', reasoningModel: 'fixture-model' } })
    f.permission()
    f.host.event({ type: 'failure', threadId: 'workshop', text: 'A fixable test failure' })
    await vi.waitFor(async () => expect((await f.recorder.recent(100)).some(record => record.source === 'supervision')).toBe(true))
    expect(f.reasoner.decide).toHaveBeenCalled()
    expect(f.host.executed.filter(command => command.type === 'answer')).toEqual([])
    expect(f.control.get().queue).toContainEqual(expect.objectContaining({ requestId: 'permission', kind: 'permission' }))
  })

  it('guards a supervision answer when a question becomes a permission before dispatch', async () => {
    const f = await fixture({ authorizes: () => ({ allowed: true, reason: 'allowed' }) })
    await f.control.command({ type: 'configure', patch: { reasoning: 'openrouter', reasoningModel: 'fixture-model' } })
    f.reasoner.decide.mockImplementation(async () => {
      f.host.permissionOnSnapshot = true
      return { decision: 'followup', text: 'Approved' }
    })
    f.host.event({ type: 'question', threadId: 'workshop', requestId: 'permission', text: 'May I publish?' })
    await vi.waitFor(async () => {
      expect((await f.recorder.recent(100)).find(record => record.source === 'supervision')).toMatchObject({
        outcome: 'failed',
      })
    })
    expect(f.host.executed.filter(command => command.type === 'answer')).toEqual([])
    expect(f.control.get().queue).toContainEqual(expect.objectContaining({ requestId: 'permission', kind: 'permission' }))
  })

  it('allows the user to approve a risky permission without configured authority', async () => {
    const f = await fixture()
    f.permission()
    expect((await f.answer('Approved')).error).toBeNull()
    expect(f.host.executed).toContainEqual(expect.objectContaining({ type: 'answer', approved: true }))
  })

  it.each([
    ['Approved', true], ['Sure go ahead', true], ['Approved', false], ['Sure go ahead', false],
  ] as const)('accepts the user answer %s as confirmation and preserves policy (record turns: %s)', async (answer, recordTurns) => {
    const { policies } = await policyFixture()
    policies.grant({ action: 'publish', effect: 'always-confirm', note: 'Confirm publishing' })
    const before = policies.list()
    const f = await fixture(policies, recordTurns)
    f.permission()
    expect((await f.answer(answer)).error).toBeNull()
    expect(f.host.executed).toContainEqual(expect.objectContaining({ type: 'answer', answer, approved: true }))
    expect(policies.list()).toEqual(before)
  })

  it('consults every matching boundary at dispatch and accepts the user confirmation', async () => {
    const authorizes = vi.fn<Authority['authorizes']>(() => ({ allowed: false, reason: 'always-confirm', policyId: 'p1' }))
    const f = await fixture({ authorizes })
    f.permission('May I publish the package and buy credits?')
    expect((await f.answer('Sure go ahead')).error).toBeNull()
    expect(authorizes).toHaveBeenCalledTimes(2)
    for (const action of ['publish', 'spend']) {
      expect(authorizes).toHaveBeenCalledWith({ action, resource: '*', scope: 'project',
        at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u) })
    }
    expect(f.host.executed).toContainEqual(expect.objectContaining({ type: 'answer', approved: true }))
  })

  it('permission-shaped memory grants nothing and user approval creates no policy', async () => {
    const { memoryStore, policies } = await policyFixture()
    const at = new Date().toISOString()
    memoryStore.insert({
      id: 'permission-memory', type: 'permission', authority: 'permission', content: 'Sotto may publish',
      sourceClass: 'explicit', state: 'active', scope: 'project', evidenceCount: 1, confidence: 1, importance: 1,
      createdAt: at, validFrom: at, lastConfirmedAt: null, lastUsedAt: null, validTo: null,
      supersededBy: null, provenance: [], tags: [],
    })
    expect(policies.authorizes({ action: 'publish', resource: '*', scope: 'project' }))
      .toEqual({ allowed: false, reason: 'no-policy' })
    const f = await fixture(policies)
    f.permission()
    expect((await f.answer('Sure go ahead')).error).toBeNull()
    expect(f.host.executed).toContainEqual(expect.objectContaining({ type: 'answer', approved: true }))
    expect(policies.list()).toEqual([])
  })

  it('does not consult policy for an ordinary permission or a denial', async () => {
    const authorizes = vi.fn<Authority['authorizes']>(() => ({ allowed: false, reason: 'always-confirm' }))
    const f = await fixture({ authorizes })
    f.permission('May I edit the tests?')
    expect((await f.answer('Sure go ahead')).error).toBeNull()
    f.permission()
    expect((await f.answer('deny', false)).error).toBeNull()
    expect(authorizes).not.toHaveBeenCalled()
    expect(f.host.executed.filter(command => command.type === 'answer')).toHaveLength(2)
  })

  it.each([
    ['allow', true], ['approve', true], ['deny', false], ['reject', false],
    ['ok', undefined], ['approved', undefined],
  ] as const)('keeps the voice permission word check for %s', async (text, approved) => {
    const authorizes = vi.fn<Authority['authorizes']>(() => ({ allowed: false, reason: 'always-confirm' }))
    const f = await fixture({ authorizes })
    f.permission()
    expect((await f.control.command({ type: 'utterance', text })).error).toBeNull()
    if (approved === undefined) {
      expect(f.host.executed).toEqual([])
      expect(f.control.get().queue).toContainEqual(expect.objectContaining({ requestId: 'permission', kind: 'permission' }))
    } else {
      expect(f.host.executed).toContainEqual(expect.objectContaining({ type: 'answer', answer: text, approved }))
    }
    expect(authorizes).toHaveBeenCalledTimes(approved === true ? 1 : 0)
  })

  it.each(['allow', 'deny'] as const)('routes voice %s through the exact offered native choice', async text => {
    const f = await fixture()
    f.host.event({ type: 'permission', threadId: 'workshop', requestId: 'permission', text: 'Run command?',
      request: { id: 'permission', kind: 'permission', text: 'Run command?', options: [], permissionChoices: [
        { id: 'once:42', label: 'Allow once', kind: 'allow-once' },
        { id: 'session:42', label: 'Allow for session', kind: 'allow-session' },
        { id: 'reject:42', label: 'Deny', kind: 'deny' },
      ] } })
    await f.control.command({ type: 'utterance', text })
    expect(f.host.executed).toContainEqual(expect.objectContaining({ type: 'answer',
      permissionChoice: text === 'allow' ? 'once:42' : 'reject:42', approved: text === 'allow' }))
  })

  it.each(['empty', 'persistent-only', 'ambiguous'] as const)('keeps %s native grants pending when voice cannot identify a one-time choice', async scenario => {
    const f = await fixture()
    f.host.event({ type: 'permission', threadId: 'workshop', requestId: 'permission', text: 'Run command?',
      request: { id: 'permission', kind: 'permission', text: 'Run command?', options: [], permissionChoices:
        scenario === 'empty' ? [] : scenario === 'persistent-only'
          ? [{ id: 'always', label: 'Always allow', kind: 'allow-always' }]
          : [{ id: 'first', label: 'Allow first', kind: 'allow-once' }, { id: 'second', label: 'Allow second', kind: 'allow-once' }] } })
    await f.control.command({ type: 'utterance', text: 'allow' })
    expect(f.host.executed.filter(command => command.type === 'answer')).toHaveLength(0)
    expect(f.control.get().queue).toContainEqual(expect.objectContaining({ requestId: 'permission' }))
  })

  it.each([
    ['spend', '*', 'May I buy more credits?'],
    ['destroy', 'repository', 'May I git push -f?'],
  ] as const)('confirms questionnaire %s boundaries on %s with the user Allow', async (action, resource, text) => {
    const { policies } = await policyFixture()
    const before = policies.recordRiskBoundaries([{ action, resource, scope: 'project', note: 'Always ask first' }], 'questionnaire')
    const authorizes = vi.spyOn(policies, 'authorizes')
    const f = await fixture(policies)
    f.permission(text)
    expect((await f.answer('ok')).error).toBeNull()
    expect(authorizes).toHaveReturnedWith({ allowed: false, reason: 'always-confirm', policyId: before[0]!.id })
    expect(f.host.executed).toContainEqual(expect.objectContaining({ type: 'answer', answer: 'ok', approved: true }))
    expect(policies.list()).toEqual(before)
    expect(policies.list()[0]?.effect).toBe('always-confirm')
  })
})
