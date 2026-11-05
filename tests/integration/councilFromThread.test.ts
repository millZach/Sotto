// @vitest-environment node
// ADR-0177, amendment of November 5, 2026, over fake providers: a thread's agent asks the Council through `sotto_council`
// only when the user's own newest message there asks for one; the seats are Settings → Council's; the pane is told to open
// the Council's tab; and the verdict comes back to that thread once its fairness check is done, once, as Sotto's message.
// Only Synthetic words are used.
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { BranchBundles } from '../../src/main/agents/branchBundles'
import { councilUserMessage, CouncilToolServer } from '../../src/main/agents/councilTools'
import { CouncilService } from '../../src/main/council/councilService'
import type { CouncilOpen, CouncilView } from '../../src/shared/council'
import { COUNCIL_VERDICT_NOTE } from '../../src/shared/councilTools'
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
  await f.endTurn(origin, 'Synthetic origin reply')
  const panel = { panelists: [{ modelId: f.model('codex').id, reasoningEffort: 'high' }, { modelId: f.model('grok').id, reasoningEffort: 'high' }, null],
    chair: { modelId: f.model('claude').id, reasoningEffort: null } }
  const clock = { ahead: 0 }
  const council = new CouncilService({ directory: f.root, control: f.control, host: f.workspace.host, historyEnabled: () => true, stageDeadline: () => 10, panel: () => panel,
    now: () => Date.now() + clock.ahead,
    bundles: new BranchBundles({ stagingDirectory: join(f.root, 'council-staging'), recordsPath: join(f.root, 'council-staging', 'records.json') }) })
  await council.recover()
  const opened: CouncilOpen[] = []
  council.onChanged((_ids, open) => { opened.push(...open ?? []) })
  // The same handlers main gives the server.
  const tools = new CouncilToolServer({
    admits: threadId => { const thread = f.control.watcherSnapshot().threads.find(item => item.id === threadId); return thread !== undefined && thread.delegatedBy === undefined && thread.councilJudge !== true },
    userMessage: async threadId => {
      const thread = f.control.watcherSnapshot().threads.find(item => item.id === threadId)
      return thread ? councilUserMessage(thread, { message: messageId => f.workspace.host.threadMessage(threadId, messageId), newest: () => f.workspace.host.threadMessages(threadId) }, messageId => f.control.delegationMessage(messageId)) : undefined
    },
    ask: (threadId, input, user) => council.askFromThread(threadId, input.question, user),
    climb: (threadId, input, user) => council.climbFromThread(threadId, input, user),
    read: (threadId, id) => council.readForThread(threadId, id),
  })
  cleanups.push(async () => { await council.close(); await tools.close() })
  const view = (): CouncilView => council.views()[0]!
  const seat = (name: string): string => view().seats.find(item => item.seat === name)!.thread
  const answer = async (name: string, words: string, reply: string) => {
    const thread = seat(name)
    await vi.waitFor(() => {
      expect(f.workspace.registry.byThread(thread)).toBeDefined()
      expect(f.native(thread).messages.findLast(message => message.role === 'user')?.text).toContain(words)
    }, { timeout: 20_000 })
    await f.endTurn(thread, reply)
  }
  /** The user sends the origin thread a message, which starts a turn that is still running. */
  const say = async (threadId: string, text: string) => {
    expect((await f.control.commandShell({ type: 'manual-send', threadId, draftId: randomUUID(), text })).error).toBeNull()
    await vi.waitFor(() => expect(f.native(threadId).messages.findLast(message => message.role === 'user')?.text).toBe(text))
  }
  const call = async (threadId: string, name: string, args: unknown) => JSON.parse(((await tools.call(threadId, name, args)).content[0] as { text: string }).text) as Record<string, unknown>
  /** Answers the framing, the answers, the reviews and the verdict, up to the fairness check. */
  const toVerdict = async () => {
    await answer('chair', 'Don\'t answer it', fence('council-framing', 'kind: review', 'criterion: question | Safe to merge', 'headings: Answer', 'words: 200', 'research: no | Synthetic'))
    for (const letter of ['A', 'B', 'C']) await answer(letter, `as panelist ${letter}`, fence('council-answer', `answer: Synthetic answer ${letter}`, `finding: ${letter}1 | judgement | Synthetic claim ${letter}`))
    await answer('A', 'Here are answers B, C', fence('council-review', 'ranking: B > C', 'findings: B1 confirmed, C1 confirmed', 'answer: same'))
    await answer('B', 'Here are answers C, A', fence('council-review', 'ranking: A > C', 'findings: C1 confirmed, A1 confirmed', 'answer: same'))
    await answer('C', 'Here are answers A, B', fence('council-review', 'ranking: A > B', 'findings: A1 confirmed, B1 confirmed', 'answer: same'))
    await answer('chair', 'Weigh evidence, not headcount', 'Synthetic verdict: safe to merge.')
  }
  return { ...f, origin, clock, council: () => council, tools, opened, view, seat, answer, say, call, toVerdict }
}

it('starts a Council from the user\'s own request with the Settings panel, opens its pane, and sends the verdict back once', async () => {
  const f = await fixture()
  await f.say(f.origin, 'Synthetic: have the council review the store before I merge.')
  const result = await f.tools.call(f.origin, 'ask_council', { question: 'Synthetic question: is the store safe to merge?' })
  const started = JSON.parse((result.content[0] as { text: string }).text) as Record<string, unknown>
  expect(started).toMatchObject({ status: 'started' })
  expect(result.isError).toBeUndefined()
  const view = f.view()
  expect(view.askedBy).toEqual({ provider: 'claude', words: 'Synthetic: have the council review the store before I merge.' })
  // The seats are Settings → Council's, the empty one filled as the Ask screen fills it; the agent chose only the question.
  expect(view.seats.slice(0, 2).map(item => item.modelId)).toEqual([f.model('codex').id, f.model('grok').id])
  expect(view.seats.find(item => item.seat === 'chair')!.modelId).toBe(f.model('claude').id)
  expect(f.opened).toEqual([{ thread: f.origin, mode: 'ask' }])
  // One message asks for one Council.
  const again = await f.tools.call(f.origin, 'ask_council', { question: 'Synthetic second question' })
  expect(again.isError).toBe(true)
  expect(f.council().views()).toHaveLength(1)

  // The origin's agent ends its turn; the Council runs to its verdict and fairness check.
  await f.endTurn(f.origin, 'Synthetic: I asked the Council.')
  await f.toVerdict()
  for (const letter of ['A', 'B', 'C']) await f.answer(letter, 'represented fairly', fence('council-fairness', 'fair: yes'))

  // The verdict reaches the origin thread as Sotto's message, tagged as the Council's, once.
  await vi.waitFor(() => expect(f.native(f.origin).messages.findLast(message => message.role === 'user')?.text).toContain('Synthetic verdict: safe to merge.'), { timeout: 20_000 })
  const sent = f.native(f.origin).messages.findLast(message => message.role === 'user')!
  expect(sent.text.startsWith('[Sotto Council]')).toBe(true)
  expect(sent.text).toContain(COUNCIL_VERDICT_NOTE)
  expect(f.control.watcherSnapshot().threads.find(thread => thread.id === f.origin)!.wakeUpMessageIds).toContain(sent.id)
  await f.endTurn(f.origin, 'Synthetic: the Council says it is safe.')
  expect(f.native(f.origin).messages.filter(message => message.text.includes('Synthetic verdict: safe to merge.') && message.role === 'user')).toHaveLength(1)
  expect(await f.call(f.origin, 'read_council', { council: f.view().id })).toMatchObject({ status: 'verdict', delivery: 'sent' })
  // A turn the verdict began is not the user's: it cannot ask the Council again.
  expect((await f.tools.call(f.origin, 'ask_council', { question: 'Synthetic follow-up' })).isError).toBe(true)
}, 120_000)

it('refuses a thread whose user did not ask for the Council, and a Council\'s own thread', async () => {
  const f = await fixture()
  await f.say(f.origin, 'Synthetic: please review the store before I merge.')
  const refused = await f.call(f.origin, 'ask_council', { question: 'Synthetic question' })
  expect(refused).toMatchObject({ status: 'refused' })
  expect(String(refused['message'])).toContain('does not ask for the Council')
  expect(f.council().views()).toHaveLength(0)
  expect(f.opened).toEqual([])
  // A Climb is refused the same way.
  expect(await f.call(f.origin, 'start_climb', { goal: 'Synthetic goal' })).toMatchObject({ status: 'refused' })

  // A Council's own seat thread never gets the tool, whatever its newest message says.
  await f.endTurn(f.origin, 'Synthetic: I reviewed it myself.')
  await f.say(f.origin, 'Synthetic: ask the council.')
  expect(await f.call(f.origin, 'ask_council', { question: 'Synthetic question' })).toMatchObject({ status: 'started' })
  await vi.waitFor(() => expect(f.control.watcherSnapshot().threads.find(thread => thread.id === f.seat('chair'))?.delegatedBy).toBe(f.origin), { timeout: 20_000 })
  expect(await f.tools.mcpServer(f.seat('chair'))).toBeUndefined()
  expect(await f.call(f.seat('chair'), 'ask_council', { question: 'Synthetic question' })).toMatchObject({ status: 'refused' })
}, 120_000)

it('starts only a Climb\'s setup from the user\'s request, which waits for the user\'s approval in the drawer', async () => {
  const f = await fixture()
  await f.say(f.origin, 'Synthetic: put the README through a council climb.')
  const started = await f.call(f.origin, 'start_climb', { goal: 'Synthetic goal: a clearer README', paths: ['README.md'] })
  expect(started).toMatchObject({ status: 'started' })
  const climb = f.council().climb.records.find(record => record.id === started['council'])!
  expect(climb).toMatchObject({ originThread: f.origin, askedBy: { provider: 'claude', words: 'Synthetic: put the README through a council climb.' } })
  // Judges come from Settings → Council's panel, kept to the models that can judge a Climb.
  expect(climb.spec!.judges.every(judge => [f.model('claude').id, f.model('codex').id].includes(judge.modelId))).toBe(true)
  expect(f.opened).toEqual([{ thread: f.origin, mode: 'climb' }])
  expect(await f.call(f.origin, 'read_council', {})).toMatchObject({ councils: [{ council: climb.id, kind: 'climb' }] })
  // Nothing is judged until the user approves the setup: the Climb is in setup or waiting for approval, never past it.
  expect(['setup', 'approval', 'paused']).toContain(climb.phase)
  expect(climb.rounds).toHaveLength(0)
  // One message asks for one.
  expect(await f.call(f.origin, 'start_climb', { goal: 'Synthetic goal again' })).toMatchObject({ status: 'refused' })
}, 120_000)

it('starts one Council for two calls at once on one message, and sends the verdict once the fairness check\'s two minutes pass', async () => {
  const f = await fixture()
  await f.say(f.origin, 'Synthetic: have the council look at the store.')
  const both = await Promise.all([f.call(f.origin, 'ask_council', { question: 'Synthetic one' }), f.call(f.origin, 'ask_council', { question: 'Synthetic two' })])
  expect(both.map(result => result['status']).sort()).toEqual(['refused', 'started'])
  expect(f.council().views()).toHaveLength(1)
  await f.endTurn(f.origin, 'Synthetic: I asked the Council.')
  await f.toVerdict()
  // A and B answer the fairness check; C never does. Send to is allowed two minutes after the check went, and so is the delivery.
  for (const letter of ['A', 'B']) await f.answer(letter, 'represented fairly', fence('council-fairness', 'fair: yes'))
  expect(f.native(f.origin).messages.some(message => message.role === 'user' && message.text.includes('Synthetic verdict'))).toBe(false)
  f.clock.ahead = 3 * 60_000
  await f.emit(f.origin)
  await vi.waitFor(() => expect(f.native(f.origin).messages.findLast(message => message.role === 'user')?.text).toContain('Synthetic verdict: safe to merge.'), { timeout: 20_000 })
  expect(await f.call(f.origin, 'read_council', { council: f.view().id })).toMatchObject({ status: 'verdict', verdict: expect.stringContaining('Synthetic verdict: safe to merge.') })
}, 120_000)
