// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { classifyRiskyAction, isExplicitApproval, type Authority, type RiskyAction } from '../../../src/main/agents/authority'
import { AgentControl } from '../../../src/main/agents/control'
import { AgentCredentials, type CredentialEncryption } from '../../../src/main/agents/credentials'
import type { AgentHostCommand } from '../../../src/main/agents/host'
import { TurnRecorder, turnRecordSchema } from '../../../src/main/agents/turns'
import { E2EAgentHost, e2eAgentReasoner } from '../../../src/main/e2e/agentEffects'
import { PolicyStore } from '../../../src/main/memory/policies'
import { MemoryStore } from '../../../src/main/memory/store'

const roots: string[] = []
const controls: AgentControl[] = []
const stores: MemoryStore[] = []
const confirmationError = "This action always needs your confirmation. Say 'approve' to allow it once."
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

async function fixture(authority?: Authority) {
  const root = await mkdtemp(join(tmpdir(), 'sotto-agent-authority-'))
  roots.push(root)
  const credentials = new AgentCredentials(join(root, 'vault'), encryption)
  await credentials.load()
  const recorder = new TurnRecorder({ directory: root, historyEnabled: () => true,
    resolveSession: id => ({ provider: 't3', sessionId: `session-${id}` }) })
  const reasoner = { ...e2eAgentReasoner, decide: vi.fn(e2eAgentReasoner.decide) }
  const host = new RecordingHost()
  const control = new AgentControl({ directory: root, host, credentials, reasoner, turns: recorder,
    ...(authority === undefined ? {} : { authority }),
    membership: {
      status: async () => ({ status: 'beta', label: 'Fixture beta', expiresAt: null }),
      action: async () => ({ status: 'beta', label: 'Fixture beta', expiresAt: null }),
    },
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

async function lastRawRecord(root: string) {
  const raw = await readFile(join(root, 'turns.jsonl'), 'utf8')
  return turnRecordSchema.parse(JSON.parse(raw.trim().split(/\r?\n/u).at(-1)!))
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
  ['destroy', 'delete'], ['destroy', 'remove'], ['destroy', 'rm -rf'], ['destroy', 'force push'],
  ['destroy', '--force'], ['destroy', 'drop table'], ['destroy', 'drop database'],
  ['destroy', 'reset --hard'], ['destroy', 'wipe'], ['destroy', 'purge'],
  ['relax-verification', 'skip tests'], ['relax-verification', 'skip the tests'],
  ['relax-verification', '--no-verify'], ['relax-verification', 'disable checks'],
  ['relax-verification', 'bypass'], ['relax-verification', 'without verification'], ['relax-verification', 'skip verification'],
  ['publish', 'publish'], ['publish', 'release'], ['publish', 'deploy'], ['publish', 'push to main'],
  ['publish', 'push to master'], ['publish', 'merge to main'],
  ['spend', 'spend'], ['spend', 'spending'], ['spend', 'billing'], ['spend', 'payment'],
  ['spend', 'purchase'], ['spend', 'buy'], ['spend', 'credits'], ['spend', 'upgrade the plan'], ['spend', 'charge'],
]

describe('risky action classification', () => {
  it.each(classes)('classifies %s keyword %s and carries the project scope', (action, text) => {
    expect(classifyRiskyAction({ kind: 'permission', text: `May I ${text.toUpperCase()}?` }, true, 'project'))
      .toEqual({ action, resource: '*', scope: 'project' })
  })
  it('never classifies questions, denials, unapproved requests or unrelated permissions', () => {
    expect(classifyRiskyAction({ kind: 'question', text: 'publish?' }, true, 'project')).toBeNull()
    for (const approved of [false, undefined]) {
      expect(classifyRiskyAction({ kind: 'permission', text: 'publish?' }, approved, 'project')).toBeNull()
    }
    for (const text of ['May I edit the tests?', 'republish deployments buyer discharged', 'x--forceful']) {
      expect(classifyRiskyAction({ kind: 'permission', text }, true, 'project')).toBeNull()
    }
  })
  it.each([
    ['publish then delete', 'destroy'], ['buy and skip tests before release', 'relax-verification'],
    ['spend to deploy', 'publish'],
  ])('uses class precedence for %s', (text, action) => {
    expect(classifyRiskyAction({ kind: 'permission', text }, true, 'project')?.action).toBe(action)
  })
  it.each(['allow', ' Approve! ', 'Approved', ' YES...?! ', 'yes。'])('recognizes explicit approval %s', answer => {
    expect(isExplicitApproval(answer)).toBe(true)
  })
  it.each(['', 'ok', 'Sure go ahead', 'not approved', 'yes please', 'deny', 'approval'])('rejects implicit approval %s', answer => {
    expect(isExplicitApproval(answer)).toBe(false)
  })
})

describe('authority at dispatch', () => {
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
        outcome: 'failed', error: 'Permissions are never answered automatically. This request stays in your attention queue.',
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

  it.each(['Approved', 'Sure go ahead'])('enforces always-confirm for the user answer %s and records errors', async answer => {
    const f = await fixture({ authorizes: () => ({ allowed: false, reason: 'always-confirm', policyId: 'p1' }) })
    f.permission()
    const state = await f.answer(answer)
    if (answer === 'Approved') {
      expect(state.error).toBeNull()
      expect(f.host.executed).toContainEqual(expect.objectContaining({ type: 'answer', approved: true }))
    } else {
      expect(state.error).toBe(confirmationError)
      expect(f.host.executed).toEqual([])
      expect(await lastRawRecord(f.root)).toMatchObject({ source: 'command', outcome: 'failed', error: confirmationError })
      expect(state.queue).toContainEqual(expect.objectContaining({ requestId: 'permission', kind: 'permission' }))
    }
  })

  it.each([
    ['publish', 'May I publish the release to npm?'], ['spend', 'May I buy more credits?'],
    ['destroy', 'May I delete the repository?'], ['relax-verification', 'May I skip the tests?'],
  ])('consults policy at dispatch for %s', async (action, text) => {
    const authorizes = vi.fn<Authority['authorizes']>(() => ({ allowed: true, reason: 'allowed', policyId: 'p1' }))
    const f = await fixture({ authorizes })
    f.permission(text)
    expect((await f.answer('Approved')).error).toBeNull()
    expect(authorizes).toHaveBeenCalledExactlyOnceWith({ action, resource: '*', scope: 'project',
      at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u) })
    expect(f.host.executed).toContainEqual(expect.objectContaining({ type: 'answer', approved: true }))
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

  it('enforces questionnaire spending boundaries using the real PolicyStore', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-agent-authority-'))
    roots.push(root)
    const memoryStore = new MemoryStore(join(root, 'memory.sqlite'))
    stores.push(memoryStore)
    memoryStore.open()
    const policies = new PolicyStore(memoryStore)
    policies.recordRiskBoundaries([{ action: 'spend', note: 'always ask before spending' }], 'questionnaire')
    const f = await fixture(policies)
    f.permission('May I buy more credits?')
    expect((await f.answer('ok')).error).toBe(confirmationError)
    expect(f.host.executed).toEqual([])
    expect((await f.answer('approve')).error).toBeNull()
    expect(f.host.executed).toContainEqual(expect.objectContaining({ type: 'answer', approved: true }))
    expect(policies.list()).toHaveLength(1)
    expect(policies.list()[0]?.effect).toBe('always-confirm')
  })
})
