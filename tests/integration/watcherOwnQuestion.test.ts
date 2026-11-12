// @vitest-environment node
// Watcher's own question (#2228, ADR-0073, amendment of November 5, 2026): ask_user puts Sotto's card in Watcher's
// conversation and answers at once, so nothing holds Watcher's turn. The user's choice reaches Watcher as news, labelled as
// theirs, and a settle question's Settle it is their agreement to that one settle.
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { WatcherService } from '../../src/main/agents/watcher'
import { WatcherToolServer } from '../../src/main/agents/watcherTools'
import type { AgentThread } from '../../src/shared/agents'
import { watcherQuestionRequestId, WATCHER_QUESTION_FIELD } from '../../src/shared/watcherQuestions'
import { workspaceFixture } from '../fixtures/workspaceFixture'
import { agentControlFixture } from '../fixtures/agentControlFixture'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function fixture(settleWithoutAsking = true) {
  const workspace = await workspaceFixture()
  cleanups.push(workspace.remove)
  const f = await agentControlFixture({ directory: workspace.root, host: workspace.host, credentialOptions: { mode: 'unavailable' },
    control: { watcherEnabled: true, historyEnabled: () => true } })
  const service = new WatcherService({ directory: f.root, host: workspace.host, control: f.control, historyEnabled: () => true,
    ordinaryBatch: { quietMs: 50, maxMs: 200 }, settleWithoutAsking: () => settleWithoutAsking, settledLookAfterMs: 0 })
  const tools = new WatcherToolServer(service)
  workspace.host.useWatcherTools(tools)
  cleanups.push(async () => { service.close(); await tools.close(); f.control.dispose(); await f.control.closed(); await workspace.stop() })
  await f.control.start(); await f.control.commandShell({ type: 'connect', provider: 'codex' }); await service.recover()
  const model = f.control.watcherSnapshot().models.find(item => item.providerId === 'codex')!
  const project = f.control.watcherSnapshot().projects.find(item => item.providerId === 'codex')!
  expect(await service.open({ provider: 'codex', modelId: model.id })).toMatchObject({ status: 'ok' })
  const watcherId = service.state().current!.target.threadId
  const native = (threadId: string): AgentThread => workspace.adapters.codex.state.threads.find(thread => thread.id === workspace.registry.byThread(threadId)!.sessionId)!
  const emit = async () => { workspace.adapters.codex.emit(); await f.control.commandShell({ type: 'refresh', provider: 'codex' }) }
  const endTurn = async (threadId: string) => {
    const thread = native(threadId)
    thread.messages.push({ id: randomUUID(), role: 'assistant', text: 'Synthetic reply', createdAt: new Date().toISOString() })
    thread.lastTurn = { id: thread.messages.findLast(message => message.role === 'user')?.id ?? randomUUID(), status: 'completed' }
    thread.status = 'idle'
    await emit()
  }
  const watched = async () => {
    const threadId = randomUUID()
    expect((await f.control.commandShell({ type: 'create-thread', threadId, projectId: project.id, modelId: model.id,
      title: 'Synthetic worker', runtimeMode: 'approval-required', workingCopy: 'shared' })).error).toBeNull()
    expect((await f.control.commandShell({ type: 'manual-send', threadId, draftId: randomUUID(), text: 'Synthetic work' })).error).toBeNull()
    const target = { hostId: f.control.hostId()!, threadId }
    expect(await service.watchThread({ target })).toMatchObject({ status: 'ok' })
    return target
  }
  /** The user's Send to Watcher. One sent while a news turn runs waits in Watcher's queue, and its request starts once
   * that turn ends, so the turn is ended until the request is there. */
  const request = async () => {
    const before = service.state().requests.length
    expect((await f.control.commandShell({ type: 'manual-send', threadId: watcherId, draftId: randomUUID(), text: 'Synthetic Watcher user request' })).error).toBeNull()
    await vi.waitFor(async () => {
      if (service.state().requests.length === before && native(watcherId).status === 'running') await endTurn(watcherId)
      expect(service.state().requests.length).toBeGreaterThan(before)
    }, { timeout: 15_000 })
    return service.state().requests.at(-1)!.id
  }
  const ask = async (input: Record<string, unknown>) => (await tools.call(watcherId, 'ask_user', input)).structuredContent as { status: string; questionId: string; note: string; code?: string }
  /** The user's press on the card, as the window sends it: the ordinary answer to a card on Watcher's thread. */
  const answer = (questionId: string, option: number, words: string) => f.control.commandShell({ type: 'answer', threadId: watcherId,
    requestId: watcherQuestionRequestId(questionId), answer: words, questionAnswers: { [WATCHER_QUESTION_FIELD]: { optionIds: [`choice-${option}`] } } })
  const master = () => workspace.registry.byThread(watcherId)!.sessionId
  /** The news Watcher's provider was sent: its note, never the message. */
  const notes = () => workspace.adapters.codex.commands.flatMap(command => command.type === 'send' && command.threadId === master() && command.watcherNews ? [command.watcherNews] : [])
  const settle = async (requestId: string, target: { hostId: string; threadId: string }, extra: Record<string, unknown> = {}) =>
    (await tools.call(watcherId, 'settle_thread', { requestId, retryKey: randomUUID(), target, ...extra })).structuredContent as { status: string; code?: string }
  return { ...f, workspace, service, tools, native, emit, endTurn, watched, request, ask, answer, notes, settle, watcherId }
}

const RUN_AGAIN = { question: 'Run Owl build’s CI again? The same test failed twice on forge.',
  options: [{ label: 'Run it again', description: 'Starts CI again on forge.' }, { label: 'Leave it failed' }] }

it('puts the question on a card in Watcher’s room at once and holds nothing of Watcher’s', async () => {
  const f = await fixture()
  const asked = await f.ask(RUN_AGAIN)
  expect(asked).toMatchObject({ status: 'ok', note: expect.stringContaining('Carry on with your work') })
  expect(f.service.state().questions).toEqual([expect.objectContaining({ id: asked.questionId, state: 'open', question: RUN_AGAIN.question,
    options: [{ label: 'Run it again', description: 'Starts CI again on forge.' }, { label: 'Leave it failed' }] })])
  // No request of the provider's: nothing waits in Watcher's thread, so its sends, news and grants go on.
  expect(f.control.watcherSnapshot().threads.find(thread => thread.id === f.watcherId)!.requests).toEqual([])
  expect(await f.ask({ question: 'Pick one', options: [{ label: 'Same' }, { label: 'same' }] })).toMatchObject({ status: 'refused', code: 'INVALID_INPUT' })
  expect(await f.ask({ question: 'No choices' })).toMatchObject({ status: 'refused', code: 'INVALID_INPUT' })
})

it('tells Watcher the user’s own choice as news, once, and the card gives way to it', async () => {
  const f = await fixture()
  const asked = await f.ask(RUN_AGAIN)
  expect((await f.answer(asked.questionId, 1, 'Run it again')).error).toBeNull()
  expect(f.service.state().questions).toEqual([expect.objectContaining({ id: asked.questionId, state: 'answered', choice: 'Run it again' })])
  await vi.waitFor(() => expect(f.notes().join('\n')).toContain('The user answered your question'), { timeout: 15_000 })
  const told = f.notes().find(note => note.includes(asked.questionId))!
  expect(told).toContain(JSON.stringify(RUN_AGAIN.question))
  expect(told).toContain('"Run it again"')
  expect(told).toContain('the user\'s own choice')
  // No provider heard the answer: it was Sotto's card.
  expect(f.workspace.adapters.codex.commands.filter(command => command.type === 'answer')).toHaveLength(0)
  // A second press finds nothing waiting, and says so.
  expect((await f.answer(asked.questionId, 2, 'Leave it failed')).error).toContain('no longer waits on you')
  expect(f.service.state().questions![0]).toMatchObject({ choice: 'Run it again' })
})

it('tells Watcher the user skipped with no answer, once, and the card gives way to it (#2477)', async () => {
  const f = await fixture()
  const asked = await f.ask(RUN_AGAIN)
  // The card's own skip, as the window and the phone send it for a skippable card.
  expect((await f.control.commandShell({ type: 'answer', threadId: f.watcherId, requestId: watcherQuestionRequestId(asked.questionId), answer: '', skipped: true })).error).toBeNull()
  expect(f.service.state().questions).toEqual([expect.objectContaining({ id: asked.questionId, state: 'skipped' })])
  expect(f.service.state().questions![0]!.choice).toBeUndefined()
  await vi.waitFor(() => expect(f.notes().join('\n')).toContain('The user skipped your question'), { timeout: 15_000 })
  const told = f.notes().find(note => note.includes(asked.questionId))!
  expect(told).toContain(JSON.stringify(RUN_AGAIN.question))
  expect(told).toContain('gave no answer')
  expect(told).toContain('Do not ask it again.')
  expect(f.workspace.adapters.codex.commands.filter(command => command.type === 'answer')).toHaveLength(0)
  // Nothing waits any more: neither a choice nor a second skip goes.
  expect((await f.answer(asked.questionId, 1, 'Run it again')).error).toContain('no longer waits on you')
  expect(f.service.state().questions![0]).toMatchObject({ state: 'skipped' })
})

it('takes only a choice the card offers', async () => {
  const f = await fixture()
  const asked = await f.ask(RUN_AGAIN)
  expect((await f.answer(asked.questionId, 9, 'Something else')).error).toContain('Choose one of the answers')
  expect(f.service.state().questions![0]).toMatchObject({ state: 'open' })
})

it('lets the user’s Settle it on a settle question agree that one settle, and Keep watching agrees none', async () => {
  const f = await fixture(false), kept = await f.watched(), finished = await f.watched()
  await f.endTurn(kept.threadId); await f.endTurn(finished.threadId)
  // Refused before the request is read: the user has not agreed.
  expect(await f.settle(randomUUID(), finished)).toMatchObject({ status: 'refused', code: 'ASK_USER_FIRST' })
  // A settle question takes Sotto's own two choices, whatever Watcher offers.
  const keep = await f.ask({ question: 'Settle Synthetic worker? It has nothing left to do.', settle: kept })
  const go = await f.ask({ question: 'Settle the other Synthetic worker?', settle: finished })
  expect(f.service.state().questions!.map(question => question.options.map(option => option.label))).toEqual([['Settle it', 'Keep watching'], ['Settle it', 'Keep watching']])
  expect((await f.answer(keep.questionId, 2, 'Keep watching')).error).toBeNull()
  expect(await f.settle(randomUUID(), kept)).toMatchObject({ status: 'refused', code: 'ASK_USER_FIRST' })
  expect((await f.answer(go.questionId, 1, 'Settle it')).error).toBeNull()
  // Watcher hears each piece of news in a turn of its own, and the answer's comes once the turn before it ends.
  await vi.waitFor(async () => {
    if (f.native(f.watcherId).status === 'running') await f.endTurn(f.watcherId)
    expect(f.notes().join('\n')).toContain('They agree to settle this thread')
  }, { timeout: 15_000 })
  expect(f.notes().join('\n')).toContain('They want this thread kept')
  if (f.native(f.watcherId).status === 'running') await f.endTurn(f.watcherId)
  const requestId = await f.request()
  expect(await f.settle(requestId, kept)).toMatchObject({ status: 'refused', code: 'ASK_USER_FIRST' })
  expect(await f.settle(requestId, finished)).toMatchObject({ status: 'ok' })
  await vi.waitFor(() => expect(f.service.state().questions!.find(question => question.id === go.questionId)).toMatchObject({ spent: true }), { timeout: 15_000 })
})

it('asks again rather than keep two settle questions open for one thread', async () => {
  const f = await fixture(false), target = await f.watched()
  const first = await f.ask({ question: 'Settle Synthetic worker?', settle: target })
  const second = await f.ask({ question: 'Settle Synthetic worker now?', settle: target })
  expect(f.service.state().questions!.map(question => question.id)).toEqual([second.questionId])
  expect((await f.answer(first.questionId, 1, 'Settle it')).error).toContain('no longer waits on you')
})
