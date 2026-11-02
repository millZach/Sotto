// @vitest-environment node
// ADR-0177 over fake providers: a Council puts one question from a thread to panelists and a chair on their own
// providers' threads, in a snapshot of the thread's folder, and goes through framing, answers, reviews, the verdict and
// the fairness check to a draft for the thread. Only Synthetic words are used.
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { BranchBundles } from '../../src/main/agents/branchBundles'
import { CouncilService } from '../../src/main/council/councilService'
import type { CouncilView } from '../../src/shared/council'
import { commitFile, git } from '../fixtures/branchRepositories'
import { delegationFixture } from '../fixtures/delegationFixture'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const fence = (name: string, ...lines: string[]): string => ['```' + name, ...lines, '```'].join('\n')

async function fixture() {
  const f = await delegationFixture(cleanups)
  const origin = await f.userThread('claude')
  const folder = f.control.shell().host.threads.find(thread => thread.id === origin)!.workingDirectory!
  git(folder, 'init', '-q'); await commitFile(folder, 'README.md', '# Project\n', 'Start the project')
  git(folder, 'switch', '-q', '-c', 'feat/council')
  await commitFile(folder, 'store.ts', 'export const keep = readThreadOnce(id)\n')
  // Uncommitted work the snapshot carries, and the origin's own turn answered, as the user left it.
  await writeFile(join(folder, 'scratch.txt'), 'Synthetic scratch\n')
  await f.endTurn(origin, 'Synthetic origin reply')
  const make = () => new CouncilService({ directory: f.root, control: f.control, host: f.workspace.host, historyEnabled: () => true, stageDeadline: () => 10,
    bundles: new BranchBundles({ stagingDirectory: join(f.root, 'council-staging'), recordsPath: join(f.root, 'council-staging', 'records.json') }) })
  let council = make()
  await council.recover()
  cleanups.push(async () => { council.close() })
  const view = (): CouncilView => council.views()[0]!
  const seat = (name: string): string => view().seats.find(item => item.seat === name)!.thread
  /** Waits until a seat's thread has been sent a prompt that says `words`, and answers it. */
  const answer = async (name: string, words: string, reply: string) => {
    const thread = seat(name)
    await vi.waitFor(() => {
      expect(f.workspace.registry.byThread(thread)).toBeDefined()
      expect(f.native(thread).messages.findLast(message => message.role === 'user')?.text).toContain(words)
    }, { timeout: 20_000 })
    await f.endTurn(thread, reply)
  }
  /** The Council alone stops and starts again over its record; `between` runs while it is stopped. */
  const restart = async (between?: () => Promise<void>) => { council.close(); await between?.(); council = make(); await council.recover() }
  return { ...f, origin, folder, view, seat, answer, restart, get council() { return council } }
}

const framing = fence('council-framing', 'kind: decision', 'criterion: question | Keeps the store read once', 'criterion: assumed | Costs nothing at start',
  'headings: Answer; Evidence', 'words: 300', 'research: yes | Synthetic library docs changed', 'angle: A | Weigh startup', 'angle: B | Weigh memory', 'angle: C | Weigh tests')
const answerReply = (letter: string, cite: boolean): string => [`Synthetic answer ${letter}.`, ...cite ? ['It reads: export const keep = readThreadOnce(id)'] : [],
  fence('council-answer', `answer: Synthetic answer ${letter}`, cite ? `finding: ${letter}1 | observed | store.ts:1 | The store is read once` : `finding: ${letter}1 | judgement | Synthetic claim`)].join('\n')
const reviewReply = (order: string): string => fence('council-review', `ranking: ${order}`, 'answer: same')

it('runs a Council end to end in a snapshot, keeps the user\'s checkout as it was, and drafts the verdict once the fairness check allows it', async () => {
  const f = await fixture()
  const status = git(f.folder, 'status', '--porcelain')
  const panel = [{ modelId: f.model('codex').id, reasoningEffort: 'high' }, { modelId: f.model('grok').id, reasoningEffort: 'high' }, { modelId: f.model('claude').id, reasoningEffort: 'low' }]
  const started = await f.council.command({ type: 'start', originThread: f.origin, question: 'Synthetic question: keep the store read once?', panelists: panel, chair: { modelId: f.model('claude').id, reasoningEffort: null } })
  expect(started).toMatchObject({ ok: true })
  const snapshot = f.view()
  expect(snapshot.snapshot).toMatchObject({ branch: 'feat/council', untracked: 1, removed: false })
  expect(snapshot.seats.map(item => [item.seat, item.role])).toEqual([['A', 'panelist'], ['B', 'panelist'], ['C', 'panelist'], ['chair', 'chair']])

  // Framing by the chair, with the conversation quoted as history; then every panelist answers alone.
  await f.answer('chair', 'Don\'t answer it', framing)
  const chairPrompt = f.native(f.seat('chair')).messages.find(message => message.role === 'user')!.text
  expect(chairPrompt).toContain('quoted as history')
  expect(chairPrompt).toContain('Synthetic origin reply')
  // The prompt is Sotto's, never the user's: the host recorded it as it records a wake-up, before the provider heard it.
  const chairThread = f.control.watcherSnapshot().threads.find(thread => thread.id === f.seat('chair'))!
  const chairMessage = f.native(f.seat('chair')).messages.find(message => message.role === 'user')!
  expect(chairPrompt.startsWith('[Sotto Council]')).toBe(true)
  expect(chairThread.wakeUpMessageIds).toContain(chairMessage.id)
  await f.answer('A', 'Also weigh: Weigh startup', answerReply('A', true))
  // The chair said the question needs outside research: each panelist is told to research with its own tools and cite sources.
  expect(f.native(f.seat('A')).messages.findLast(message => message.role === 'user')!.text).toContain('needs outside research')
  expect(f.view().rounds[0]!.framing).toMatchObject({ research: { needed: true, reason: 'Synthetic library docs changed', byUser: false } })
  await f.answer('B', 'as panelist B', answerReply('B', false))
  await f.answer('C', 'as panelist C', answerReply('C', false))

  // Every seat's thread works in the snapshot, linked to the origin thread as a delegated thread is.
  const threads = f.control.shell().host.threads
  const path = threads.find(thread => thread.id === f.seat('A'))!.worktree?.path
  expect(path).toBeDefined()
  expect((await readFile(join(path!, 'scratch.txt'), 'utf8')).replace(/\r\n/gu, '\n')).toBe('Synthetic scratch\n')
  for (const name of ['A', 'B', 'C', 'chair']) {
    expect(threads.find(thread => thread.id === f.seat(name))).toMatchObject({ delegatedBy: f.origin })
    const session = f.workspace.registry.byThread(f.seat(name))!.sessionId
    expect(f.adapterOf(f.seat(name)).commands.find(command => command.type === 'create-thread' && command.threadId === session)).toMatchObject({ runtimeMode: 'approval-required', workingDirectory: path })
  }

  // Reviews under letters, each reader the others in its own order; then the verdict, then the fairness check.
  await f.answer('A', 'Here are answers B, C', reviewReply('B > C'))
  await f.answer('B', 'Here are answers C, A', reviewReply('A > C'))
  await f.answer('C', 'Here are answers A, B', reviewReply('A > B'))
  await f.answer('chair', 'Weigh evidence, not headcount', 'Synthetic verdict: keep the store read once. A observed it.')
  await vi.waitFor(() => expect(f.view().rounds[0]!.stage).toBe('fairness'), { timeout: 20_000 })
  expect(f.view().rounds[0]!.draft).toBeNull()
  for (const name of ['A', 'B', 'C']) await f.answer(name, 'represented fairly', fence('council-fairness', 'fair: yes'))

  await vi.waitFor(() => expect(f.view().rounds[0]).toMatchObject({ stage: 'done', verdict: { fairnessDone: true } }), { timeout: 20_000 })
  const round = f.view().rounds[0]!
  expect(round.verdict!.text).toBe('Synthetic verdict: keep the store read once. A observed it.')
  expect(round.verdict!.counts.rankings).toEqual([{ letter: 'A', first: 2, of: 2 }, { letter: 'B', first: 1, of: 2 }, { letter: 'C', first: 0, of: 2 }])
  expect(round.draft).toContain('Panelists: A = ')
  await vi.waitFor(() => expect(f.view().rounds[0]!.rows.find(row => row.stage === 'answer' && row.seat === 'A')?.citations).toEqual([{ finding: 'A1', path: 'store.ts', lines: '1', check: 'matches' }]))
  // Nothing was sent to the origin thread, and its checkout is as the user left it.
  expect(f.native(f.origin).messages.filter(message => message.role === 'user')).toHaveLength(1)
  expect(git(f.folder, 'status', '--porcelain')).toBe(status)

  // Settling the Council settles its threads and removes its snapshot.
  expect(await f.council.command({ type: 'settle', council: snapshot.id })).toMatchObject({ ok: true })
  await vi.waitFor(() => expect(f.view()).toMatchObject({ status: 'settled', snapshot: { removed: true } }), { timeout: 20_000 })
  expect(existsSync(path!)).toBe(false)
  expect(git(f.folder, 'worktree', 'list')).not.toContain('council-worktrees')
  expect(f.control.shell().host.threads.find(thread => thread.id === f.seat('A'))?.workspaceSettledAt).toEqual(expect.any(String))
})

it('asks once for a missing result block, and goes on with a stage only once a failed thread is retried or left out', async () => {
  const f = await fixture()
  await f.council.command({ type: 'start', originThread: f.origin, question: 'Synthetic question?', panelists: [{ modelId: f.model('codex').id, reasoningEffort: 'high' },
    { modelId: f.model('grok').id, reasoningEffort: 'high' }], chair: { modelId: f.model('claude').id, reasoningEffort: null } })
  await f.answer('chair', 'Don\'t answer it', framing.replace(/angle: C.*\n/u, ''))
  await f.answer('A', 'as panelist A', 'Synthetic answer with no block.')
  await f.answer('A', 'could not be read', answerReply('A', false))
  await vi.waitFor(() => expect(f.view().rounds[0]!.rows.find(row => row.stage === 'answer' && row.seat === 'A' && !row.repair)?.result).toBe('valid'), { timeout: 20_000 })
  // B's turn fails: its row offers the user's choices and the stage waits for one.
  await vi.waitFor(() => expect(f.native(f.seat('B')).messages.some(message => message.role === 'user')).toBe(true), { timeout: 20_000 })
  await f.endTurn(f.seat('B'), '', 'failed')
  await vi.waitFor(() => expect(f.view().rounds[0]!.rows.find(row => row.stage === 'answer' && row.seat === 'B')).toMatchObject({ state: 'failed', actions: ['retry', 'replace', 'skip'] }), { timeout: 20_000 })
  expect(f.view()).toMatchObject({ status: 'waiting', rounds: [{ stage: 'answers' }] })
  const failed = f.view().rounds[0]!.rows.find(row => row.stage === 'answer' && row.seat === 'B')!
  expect(await f.council.command({ type: 'skip', council: f.view().id, turn: failed.turn })).toMatchObject({ ok: true })
  // With one answer left there is no review: the chair is asked for the verdict at once.
  await f.answer('chair', 'rests on one answer', 'Synthetic verdict on one answer.')
  await vi.waitFor(() => expect(f.view().rounds[0]).toMatchObject({ stage: 'fairness', leftOut: ['B'] }), { timeout: 20_000 })
})

it('never sends again a prompt Sotto had not seen arrive before it restarted', async () => {
  const f = await fixture()
  await f.council.command({ type: 'start', originThread: f.origin, question: 'Synthetic question?', panelists: [{ modelId: f.model('codex').id, reasoningEffort: 'high' },
    { modelId: f.model('grok').id, reasoningEffort: 'high' }], chair: { modelId: f.model('claude').id, reasoningEffort: null } })
  await vi.waitFor(() => expect(f.workspace.registry.byThread(f.seat('chair')) && f.native(f.seat('chair')).messages.some(message => message.role === 'user')).toBe(true), { timeout: 20_000 })
  // As if Sotto stopped while the framing was on its way: once the record has settled, it is made to say dispatching.
  const file = join(f.root, 'councils.json')
  type Saved = { councils: { turns: { delivery: string }[] }[] }
  const saved = async (): Promise<Saved> => JSON.parse(await readFile(file, 'utf8')) as Saved
  await vi.waitFor(async () => expect((await saved()).councils[0]!.turns[0]!.delivery).toBe('accepted'), { timeout: 20_000 })
  const prompts = () => f.native(f.seat('chair')).messages.filter(message => message.role === 'user').length
  const sent = prompts()
  await f.restart(async () => {
    const record = await saved()
    record.councils[0]!.turns[0]!.delivery = 'dispatching'
    await writeFile(file, JSON.stringify(record))
  })
  expect(f.view().rounds[0]!.rows.find(row => row.stage === 'framing')).toMatchObject({ state: 'unknown', actions: ['retry', 'replace', 'skip'] })
  await f.endTurn(f.origin, 'Synthetic later reply')
  expect(prompts()).toBe(sent)
})
