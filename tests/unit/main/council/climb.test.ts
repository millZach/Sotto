// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { ClimbService } from '../../../../src/main/council/climbService'
import { CouncilEvidenceStore, createCouncilJudgeWorkspace } from '../../../../src/main/council/councilEvidence'
import { assessClimb, readClimbJudgment } from '../../../../src/main/council/climbAssessment'
import { assertCouncilJudgeDirectory, COUNCIL_JUDGE_CLAUDE_ARGS } from '../../../../src/main/council/councilJudge'
import { climbRecordSchema, type ClimbRecord, type ClimbRound, type ClimbSpec, type ClimbTurn } from '../../../../src/shared/councilClimb'
import { EMPTY_AGENT_HOST, type AgentHostSnapshot, type AgentMessage, type AgentState, type AgentThread } from '../../../../src/shared/agents'
import type { AgentHostCommand } from '../../../../src/main/agents/host'
import { SottoThreadHost, ThreadRegistry } from '../../../../src/main/agents/threads'
import { WorkspaceHost } from '../../../../src/main/agents/workspace'
import { ThreadWorktrees } from '../../../../src/main/agents/threadWorktrees'
import { FakeProviderHost } from '../../../fixtures/fakeProviderHost'
import { claudeFixture } from '../../../fixtures/claudeFixture'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
const block = (value: unknown): string => `<climb-result>${JSON.stringify(value)}</climb-result>`
const seat = { modelId: 'fixture-model', reasoningEffort: null }
const rubric: ClimbSpec['criteria'] = [{ id: 'clarity', name: 'Clarity', rubric: '0: unclear; 10: clear and complete', kind: 'goal', direction: 'higher', min: 0, max: 10, target: 'relative', threshold: 2, tolerance: 0, meaningfulGain: 1 }]
const source = { kind: 'artifacts' as const, items: [{ path: 'draft.txt', artifactId: 'draft', content: { kind: 'text' as const, text: 'First draft' } }] }
const spec: ClimbSpec = { goal: 'Make this explanation clearer', constraints: 'Keep its meaning', source, judges: [seat, seat, seat], chair: seat, criteria: rubric, attempts: 5, modelTurns: 30 }
const message = (id: string, role: 'user' | 'assistant', text: string): AgentMessage => ({ id, role, text, createdAt: new Date().toISOString() })

async function fixture(keep = true) {
  const directory = await mkdtemp(join(tmpdir(), 'sotto-climb-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const origin: AgentThread = { id: 'origin', projectId: 'project', title: 'Explanation', modelId: seat.modelId, providerId: 'claude', status: 'idle', messages: [message('human', 'user', 'Private origin conversation')], requests: [] }
  const snapshot: AgentHostSnapshot = { ...EMPTY_AGENT_HOST, connected: true, models: [{ id: seat.modelId, name: 'Judge', provider: 'Claude', ready: true, providerId: 'claude' }], projects: [{ id: 'project', title: 'Project', path: directory }], threads: [origin] }
  const sent: AgentHostCommand[] = [], interrupts: string[] = []
  let userDraft = false, uncertain = false, saveCount = 0
  const thread = (id: string) => snapshot.threads.find(thread => thread.id === id)!
  const options: ConstructorParameters<typeof ClimbService>[0] = {
    directory, historyEnabled: () => keep, stageDeadline: () => 10,
    save: async () => { saveCount++; for (const record of service.saved(keep)) climbRecordSchema.parse(record) }, changed: () => undefined, unavailable: () => undefined,
    control: {
      hostId: () => 'local', watcherSnapshot: () => snapshot, configuration: () => ({}), useCouncil: () => () => undefined,
      hasPendingThreadWork: () => false, hasUserDraft: () => userDraft, refreshCouncilObservation: () => undefined,
      commandFromCouncil: async (command, guard) => {
        guard()
        if (command.type === 'interrupt') interrupts.push(command.threadId)
        if (command.type === 'manual-send') {
          const turn = service.turnForDraft(command.draftId!)!.turn
          expect(turn.delivery).toBe('dispatching')
          const builder = thread(command.threadId)
          builder.messages.push(message(turn.messageId, 'user', command.text)); builder.status = 'running'
          builder.lastTurn = { id: turn.messageId, messageId: turn.messageId, status: 'running' }
          return { deliveries: [{ draftId: command.draftId, status: uncertain ? 'uncertain' : 'accepted' }] } as unknown as AgentState
        }
        return {} as AgentState
      },
    },
    host: {
      execute: async command => {
        sent.push(command)
        if (command.type === 'create-thread') snapshot.threads.push({ id: command.threadId, projectId: 'project', title: command.title, modelId: command.modelId, providerId: 'claude', councilJudge: true, workingDirectory: command.workingDirectory, status: 'idle', messages: [], requests: [] })
        if (command.type === 'send') {
          const owner = service.records.find(record => record.turns.some(turn => turn.messageId === command.messageId))!
          expect(owner.turns.find(turn => turn.messageId === command.messageId)?.delivery).toBe('dispatching')
          const target = thread(command.threadId); target.messages.push(message(command.messageId, 'user', command.text)); target.status = 'running'
          target.lastTurn = { id: command.messageId, messageId: command.messageId, status: 'running' }
        }
        return { accepted: true }
      },
      setDelegatedBy: async (id, parent) => { thread(id).delegatedBy = parent }, recordSottoMessage: async () => undefined,
      threadMessages: id => thread(id).messages, threadActivities: id => thread(id).activities ?? [],
      threadMessage: (id, messageId) => thread(id).messages.find(message => message.id === messageId),
    },
  }
  const service = new ClimbService(options); cleanup.push(async () => service.close())
  const record = (): ClimbRecord => service.records[0]!
  const next = async (): Promise<ClimbTurn> => {
    await vi.waitFor(() => expect(record().turns.find(turn => !turn.outcome)?.delivery).toMatch(/accepted|unconfirmed/u))
    return record().turns.find(turn => !turn.outcome)!
  }
  const answer = async (reply: string): Promise<ClimbTurn> => {
    const turn = await next(), target = thread(turn.thread)
    target.messages.push({ ...message(randomUUID(), 'assistant', reply), turnMessageId: turn.messageId }); target.status = 'idle'
    target.lastTurn = { id: turn.messageId, messageId: turn.messageId, status: 'completed' }
    service.observe(snapshot)
    await vi.waitFor(() => expect(turn.outcome).toBe('answered'))
    return turn
  }
  const start = async (config = spec) => {
    const preview = await service.command({ type: 'preview', source: config.source })
    expect(await service.command({ type: 'start', origin: origin.id, spec: config, preview: preview.preview!.fingerprint, context: 'Selected context only' })).toMatchObject({ ok: true })
    await answer(block({ criteria: config.criteria, constraints: config.constraints }))
    await vi.waitFor(() => expect(record().phase).toBe('approval'))
  }
  const approve = async () => { expect(await service.command({ type: 'approve', climb: record().id, spec: record().spec! })).toMatchObject({ ok: true }) }
  const assessment = async (candidateScore: number) => {
    for (let index = 0; index < 3; index++) {
      await next()
      const round = record().rounds.at(-1)!, store = new CouncilEvidenceStore(directory, record().id, keep)
      const rows = []
      for (const exhibit of round.exhibits) {
        const frozen = record().evidence.find(item => item.id === exhibit.evidence)!, bytes = await store.read(frozen, 'draft.txt', 1000)
        rows.push({ criterion: 'clarity', exhibit: exhibit.letter, score: exhibit.evidence === round.candidate ? candidateScore : 2, reason: 'Specific clarity evidence', citations: [{ path: 'draft.txt', start: 1, end: 1, quote: bytes.toString('utf8') }] })
      }
      await answer(block({ scores: rows }))
    }
    await answer(block({ summary: 'Independent judges agree.' }))
  }
  return { directory, service, snapshot, origin, sent, interrupts, start, approve, next, answer, assessment, record,
    draft: () => { userDraft = true; service.observe(snapshot) }, uncertain: () => { uncertain = true }, saves: () => saveCount }
}

it('runs setup, baseline and a fresh matched assessment without Git, retaining and exporting the winning text', async () => {
  const f = await fixture()
  expect(await f.service.command({ type: 'start', origin: 'origin', spec: { ...spec, judges: [{ ...seat, reasoningEffort: 'ultracode' }, seat, seat] }, preview: 'unused', context: '' })).toMatchObject({ ok: false })
  await f.start()
  const setup = f.sent.find(command => command.type === 'send')!
  expect(setup).toMatchObject({ text: expect.stringContaining('Selected context only') })
  expect(setup).not.toMatchObject({ text: expect.stringContaining('Private origin conversation') })
  await f.approve(); await f.assessment(2)
  const builder = await f.next(); expect(builder.stage).toBe('builder')
  await f.answer('<climb-artifacts>{"items":[{"path":"draft.txt","text":"Clear final explanation"}]}</climb-artifacts>')
  await f.assessment(5)
  await vi.waitFor(() => expect(f.record().phase).toBe('done'))
  expect(f.record()).toMatchObject({ completedTurns: 10, noImprovement: 0 })
  expect(f.record().rounds[1]).toMatchObject({ targetMet: true, improved: true })
  const creates = f.sent.filter(command => command.type === 'create-thread')
  expect(creates).toHaveLength(9); expect(new Set(creates.map(command => command.threadId)).size).toBe(9)
  expect(creates.every(command => command.councilJudge && command.workingDirectory?.includes('council-evidence'))).toBe(true)
  for (const turn of f.record().turns.filter(turn => turn.stage === 'judge')) {
    const prompt = f.sent.find(command => command.type === 'send' && command.messageId === turn.messageId)
    expect(prompt).not.toMatchObject({ text: expect.stringContaining('threshold') })
    expect(prompt).not.toMatchObject({ text: expect.stringContaining('Selected context only') })
    expect(prompt).not.toMatchObject({ text: expect.stringContaining('Private origin conversation') })
  }
  const destination = join(f.directory, 'export')
  expect(await f.service.command({ type: 'export', climb: f.record().id, round: 1, destination })).toMatchObject({ ok: true })
  expect(await readFile(join(destination, 'files', 'draft.txt'), 'utf8')).toBe('Clear final explanation')
  expect(await f.service.command({ type: 'export', climb: f.record().id, round: 1, destination })).toMatchObject({ ok: false })
})

it('keeps identical exhibits once and stops after two completed attempts without improvement with both caps removed', async () => {
  const f = await fixture(); await f.start({ ...spec, attempts: null, modelTurns: null }); await f.approve(); await f.assessment(2)
  for (let i = 0; i < 2; i++) { await f.answer('<climb-artifacts>{"items":[{"path":"draft.txt","text":"First draft"}]}</climb-artifacts>'); await f.assessment(2) }
  await vi.waitFor(() => expect(f.record().phase).toBe('done'))
  expect(f.record()).toMatchObject({ noImprovement: 2, completedTurns: 15 })
  expect(f.record().evidence).toHaveLength(1)
  expect(f.record().rounds.map(round => round.exhibits.length)).toEqual([1, 1, 1])
})

it('repairs malformed judging once, then holds without counting an attempt or silently skipping a seat', async () => {
  const f = await fixture(); await f.start(); await f.approve()
  const first = await f.answer(block({ scores: [] })), repair = await f.next()
  expect(repair).toMatchObject({ thread: first.thread, repair: true })
  await f.answer(block({ scores: [] }))
  await vi.waitFor(() => expect(f.record().phase).toBe('paused'))
  expect(f.record().noImprovement).toBe(0)
  expect(f.record().rounds[0]!.judgments).toHaveLength(0)
})

it('holds on user activity, and Stop interrupts only the exact builder turn after saving cancellation', async () => {
  const f = await fixture(); await f.start(); await f.approve(); await f.assessment(2)
  const turn = await f.next(); expect(turn.stage).toBe('builder')
  f.draft(); await vi.waitFor(() => expect(f.record().phase).toBe('paused'))
  f.origin.lastTurn = { id: 'human-new-turn', messageId: 'human-new-turn', status: 'running' }
  expect(await f.service.command({ type: 'stop', climb: f.record().id })).toMatchObject({ ok: true })
  expect(f.interrupts).not.toContain('origin')
  expect(f.record().phase).toBe('stopped')
})

it('does not replay an uncertain builder after recovery and strips history-off words', async () => {
  const f = await fixture(false); await f.start(); await f.approve(); await f.assessment(2)
  // Simulate losing the acknowledgement after dispatch. Recovery must never turn it back into queued.
  const turn = await f.next(); turn.delivery = 'dispatching'
  const saved = structuredClone(f.record()); f.service.recover([saved])
  expect(saved.turns.at(-1)?.delivery).toBe('unconfirmed')
  expect(await f.service.command({ type: 'resume', climb: saved.id })).toMatchObject({ ok: false })
  const words = JSON.stringify(f.service.saved(false))
  for (const text of ['First draft', 'Selected context only', 'Specific clarity evidence', 'Explanation']) expect(words).not.toContain(text)
})

it('requires all seats and criteria, including lower-is-better guardrails, without averaging', () => {
  const round: ClimbRound = { index: 1, baseline: 'base', incumbent: 'base', candidate: 'next', exhibits: [{ letter: 'A', evidence: 'base' }, { letter: 'B', evidence: 'next' }], judgments: [] }
  const guarded = { ...spec, criteria: [...rubric, { ...rubric[0]!, id: 'errors', kind: 'guardrail' as const, direction: 'lower' as const, target: 'absolute' as const, threshold: 0 }] }
  for (let seat = 0; seat < 3; seat++) round.judgments.push({ seat, thread: String(seat), modelId: 'fixture-model', result: { scores: [
    ...['A', 'B'].flatMap(exhibit => [{ criterion: 'clarity', exhibit, score: exhibit === 'A' ? 2 : 5, reason: 'Evidence', citations: [] }, { criterion: 'errors', exhibit, score: 0, reason: 'Evidence', citations: [] }]),
  ] } })
  expect(assessClimb(guarded, round)).toEqual({ targetMet: true, improved: true })
  round.judgments[2]!.result.scores[3]!.score = 1
  expect(assessClimb(guarded, round)).toEqual({ targetMet: false, improved: false })
  round.judgments.pop(); expect(assessClimb(guarded, round).targetMet).toBe(false)
})

it('refuses duplicate, missing, out-of-range and fabricated frozen citations', async () => {
  const f = await fixture(); await f.start(); await f.approve(); await f.next()
  const store = new CouncilEvidenceStore(f.directory, f.record().id, true), round = f.record().rounds[0]!
  const row = { criterion: 'clarity', exhibit: 'A', score: 3, reason: 'Specific', citations: [{ path: 'draft.txt', start: 1, end: 1, quote: 'First draft' }] }
  for (const rows of [[row, row], [], [{ ...row, score: 11 }], [{ ...row, citations: [{ ...row.citations[0]!, quote: 'Fabricated' }] }]]) await expect(readClimbJudgment(block({ scores: rows }), spec, round, store, f.record().evidence)).rejects.toThrow()
})

it('enforces the Claude judge launch boundary, denies tools and refuses configuration changes', async () => {
  const f = await claudeFixture(); cleanup.push(f.cleanup)
  await f.host.connect(); await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Project', path: f.root })
  const id = randomUUID(), store = new CouncilEvidenceStore(f.root, randomUUID(), false)
  const workspace = await createCouncilJudgeWorkspace(f.root, store.councilId, id, store, [])
  cleanup.push(workspace.remove)
  await expect(assertCouncilJudgeDirectory(f.root, f.root)).rejects.toThrow('owned')
  await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f.projectId, title: 'Judge', modelId: f.modelId, workingDirectory: workspace.path, councilJudge: true })
  await f.host.execute({ type: 'send', commandId: randomUUID(), messageId: randomUUID(), threadId: id, text: 'Score supplied evidence only.' })
  const launch = (await f.driver.requests()).find(record => record.method === 'launch' && (record.params!.frame as { cwd: string }).cwd === workspace.path)!
  const args = (launch.params!.frame as { args: string[] }).args
  for (const argument of COUNCIL_JUDGE_CLAUDE_ARGS) expect(args).toContain(argument)
  expect(args).not.toContain('--agents')
  await f.driver.raisePermission(id, 'Write outside the exhibit')
  await vi.waitFor(async () => expect((await f.driver.requests()).some(record => f.protocol!.permissionDecision(record) === false)).toBe(true))
  expect((await f.host.snapshot()).threads.find(thread => thread.id === id)?.requests).toEqual([])
  await expect(f.host.execute({ type: 'configure-thread', commandId: randomUUID(), threadId: id, runtimeMode: 'full-access' })).rejects.toThrow('read-only')
  const wrapped = new SottoThreadHost('claude', f.host, new ThreadRegistry(f.root))
  const publicId = (await wrapped.snapshot()).threads.find(thread => thread.councilJudge)!.id
  await wrapped.closeCouncilJudge(publicId)
  expect(await f.sessions!.stopped(id)).toBe(true)
})


it('keeps owned judge creation and sending outside Git, checkpoints and side writing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sotto-climb-workspace-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const provider = new FakeProviderHost()
  provider.state.threads = []
  provider.state.projects[0]!.path = directory
  provider.state.models[0]!.providerId = 'claude'
  const host = new WorkspaceHost(provider, directory, () => true, undefined, true, false, false, undefined, null, true)
  cleanup.push(() => host.close())
  await host.connect()
  const store = new CouncilEvidenceStore(directory, randomUUID(), false), id = randomUUID()
  const workspace = await createCouncilJudgeWorkspace(directory, store.councilId, id, store, [])
  cleanup.push(workspace.remove)
  const git = vi.fn(async () => { throw new Error('A judge must not read Git') })
  const blocked = vi.fn(() => true), checkpoint = vi.fn(async () => { throw new Error('A judge must not checkpoint') })
  host.setGitStatus({ read: git, invalidate: () => undefined }, { pollIntervalMs: () => 0 })
  host.setCheckpointHooks({ beforeTurn: checkpoint, isBlocked: blocked })
  const discover = vi.spyOn(ThreadWorktrees.prototype, 'discover'), inspect = vi.spyOn(ThreadWorktrees.prototype, 'inspect'), ready = vi.spyOn(ThreadWorktrees.prototype, 'readyOnDisk')
  try {
    await host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: 'project', title: 'Judge', modelId: 'fake:model', workingDirectory: workspace.path, councilJudge: true })
    await host.execute({ type: 'send', commandId: randomUUID(), messageId: randomUUID(), threadId: id, text: 'Read this frozen exhibit.' })
    expect(await host.writeShortText(id, { purpose: 'thread-title', instruction: 'Name this', material: 'Evidence' })).toBeNull()
    expect(git).not.toHaveBeenCalled(); expect(blocked).not.toHaveBeenCalled(); expect(checkpoint).not.toHaveBeenCalled()
    expect(discover).not.toHaveBeenCalled(); expect(inspect).not.toHaveBeenCalled(); expect(ready).not.toHaveBeenCalled()
    expect(provider.sideWrites).toEqual([])
    await expect(host.execute({ type: 'configure-thread', commandId: randomUUID(), threadId: id, runtimeMode: 'full-access' })).rejects.toThrow('read-only')
  } finally { discover.mockRestore(); inspect.mockRestore(); ready.mockRestore() }
})
