// @vitest-environment node
// #2482: the user's choice on a card Watcher asked while it worked on their request opens a request for the one turn that
// answer's news starts, so Watcher can act on it without the user sending again. #2483: a start under it, and under a
// follow-up message after a request that did nothing, keeps the model the user named in that earlier message.
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { WatcherService } from '../../src/main/agents/watcher'
import { WatcherToolServer } from '../../src/main/agents/watcherTools'
import type { AgentThread } from '../../src/shared/agents'
import { watcherToolSchemas, type WatcherToolOutput } from '../../src/shared/watcher'
import { watcherQuestionRequestId, WATCHER_QUESTION_FIELD } from '../../src/shared/watcherQuestions'
import type { WorkerRoleChoices } from '../../src/shared/workerRoles'
import { workspaceFixture } from '../fixtures/workspaceFixture'
import { agentControlFixture } from '../fixtures/agentControlFixture'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

const START_IT = { question: 'Start the Synthetic project now?', options: [{ label: 'Start it now' }, { label: 'Wait' }] }

async function fixture() {
  const workspace = await workspaceFixture(undefined, { history: true })
  cleanups.push(workspace.remove)
  const codex = workspace.adapters.codex.state
  codex.models.push({ id: 'fake:other', provider: 'Fake', name: 'Synthetic other model', ready: true,
    reasoningEfforts: ['low', 'medium', 'high'], defaultReasoningEffort: 'medium', runtimeModes: [...codex.models[0]!.runtimeModes ?? ['approval-required']] })
  const f = await agentControlFixture({ directory: workspace.root, host: workspace.host, credentialOptions: { mode: 'unavailable' },
    control: { watcherEnabled: true, historyEnabled: () => true } })
  let choices: WorkerRoleChoices = {}
  const service = new WatcherService({ directory: f.root, host: workspace.host, control: f.control, historyEnabled: () => true,
    ordinaryBatch: { quietMs: 50, maxMs: 200 }, roles: () => choices })
  const tools = new WatcherToolServer(service, { roles: true })
  workspace.host.useWatcherTools(tools)
  cleanups.push(async () => { service.close(); await tools.close(); f.control.dispose(); await f.control.closed(); await workspace.stop() })
  await f.control.start(); await f.control.commandShell({ type: 'connect', provider: 'codex' }); await service.recover()
  const models = f.control.watcherSnapshot().models.filter(item => item.providerId === 'codex')
  const base = models.find(item => item.name === 'Test model')!, other = models.find(item => item.name === 'Synthetic other model')!
  const project = f.control.watcherSnapshot().projects.find(item => item.providerId === 'codex')!
  expect(await service.open({ provider: 'codex', modelId: base.id })).toMatchObject({ status: 'ok' })
  choices = { building: { modelId: base.id, reasoningEffort: 'high' } }
  const watcherId = service.state().current!.target.threadId
  const native = (): AgentThread => workspace.adapters.codex.state.threads.find(thread => thread.id === workspace.registry.byThread(watcherId)!.sessionId)!
  const endTurn = async () => {
    const thread = native()
    thread.messages.push({ id: randomUUID(), role: 'assistant', text: 'Synthetic reply', createdAt: new Date().toISOString() })
    thread.lastTurn = { id: thread.messages.findLast(message => message.role === 'user')?.id ?? randomUUID(), status: 'completed' }
    thread.status = 'idle'
    workspace.adapters.codex.emit(); await f.control.commandShell({ type: 'refresh', provider: 'codex' })
  }
  /** The user's Send to Watcher, and the request it opened. */
  const send = async (text: string) => {
    const before = new Set(service.state().requests.map(request => request.id))
    expect((await f.control.commandShell({ type: 'manual-send', threadId: watcherId, draftId: randomUUID(), text })).error).toBeNull()
    await vi.waitFor(() => expect(service.state().requests.some(request => !before.has(request.id))).toBe(true), { timeout: 15_000 })
    return service.state().requests.find(request => !before.has(request.id))!.id
  }
  /** Watcher's turn for a request ends with nothing done under it, so the request closes. */
  const closes = async (requestId: string) => {
    await endTurn()
    await vi.waitFor(() => expect(service.state().requests.find(request => request.id === requestId)?.state).toBe('closed'), { timeout: 15_000 })
  }
  const ask = async () => (await tools.call(watcherId, 'ask_user', START_IT)).structuredContent as { status: string; questionId: string }
  const answer = (questionId: string) => f.control.commandShell({ type: 'answer', threadId: watcherId,
    requestId: watcherQuestionRequestId(questionId), answer: 'Start it now', questionAnswers: { [WATCHER_QUESTION_FIELD]: { optionIds: ['choice-1'] } } })
  const notes = () => workspace.adapters.codex.commands.flatMap(command => command.type === 'send' && command.threadId === native().id && command.watcherNews ? [command.watcherNews] : [])
  /** The news of the answer, once it has gone to Watcher. */
  const answerNews = async (questionId: string) => {
    await vi.waitFor(() => expect(notes().some(note => note.includes(questionId))).toBe(true), { timeout: 15_000 })
    return notes().find(note => note.includes(questionId))!
  }
  const start = async (requestId: string, modelId?: string): Promise<WatcherToolOutput<'start_thread'>> => watcherToolSchemas.start_thread.output.parse((await tools.call(watcherId, 'start_thread', {
    requestId, retryKey: randomUUID(), project: { hostId: f.control.hostId()!, projectId: project.id }, title: 'Synthetic worker',
    workingCopy: { kind: 'shared' }, firstPrompt: 'Synthetic first prompt', role: 'building', ...modelId ? { modelId } : {} })).structuredContent)
  return { service, send, closes, ask, answer, answerNews, start, base, other, endTurn }
}

it('lets Watcher act on the user’s answer to a card it asked under their request, on the model that request named', async () => {
  const f = await fixture()
  const asked = await f.send('Start the Synthetic project, run by the Synthetic other model.')
  expect((await f.ask()).status).toBe('ok')
  await f.closes(asked)
  // Today's refusal still stands for the request that closed: the answer's news opens its own.
  expect(await f.start(asked, f.other.id)).toMatchObject({ status: 'refused', code: 'REQUEST_NOT_ACTIVE' })
  const question = f.service.state().questions!.at(-1)!
  expect(question.askedUnder).toBe(asked)
  expect((await f.answer(question.id)).error).toBeNull()
  const news = await f.answerNews(question.id)
  const opened = f.service.state().requests.find(request => request.rootUserMessageId === `answered:${question.id}:${asked}`)!
  expect(opened).toMatchObject({ state: 'active' })
  expect(news).toContain('Sotto opened a request for this answer')
  expect(news).toContain(`Use requestId ${opened.id} for what it asks.`)
  const started = await f.start(opened.id, f.other.id)
  expect(started).toMatchObject({ status: 'ok', effectiveChoices: { modelId: f.other.id } })
  expect(started.status === 'ok' && 'role' in started ? started.role?.named : undefined).toEqual(['model'])
  // A question asked in the answer's own turn is a news turn's, so its answer opens nothing more.
  const again = await f.ask()
  expect(f.service.state().questions!.find(item => item.id === again.questionId)!.askedUnder).toBeUndefined()
})

it('opens no request for an answer to a question Watcher asked outside the user’s request, or for a Skip', async () => {
  const f = await fixture()
  // No request: as a news turn asks.
  const outside = await f.ask()
  expect(f.service.state().questions!.find(item => item.id === outside.questionId)!.askedUnder).toBeUndefined()
  expect((await f.answer(outside.questionId)).error).toBeNull()
  const news = await f.answerNews(outside.questionId)
  expect(news).not.toContain('Sotto opened a request')
  expect(f.service.state().requests.some(request => request.rootUserMessageId.startsWith('answered:'))).toBe(false)
  await f.endTurn()
  const asked = await f.send('Start the Synthetic project, run by the Synthetic other model.')
  const skipped = await f.ask()
  await f.closes(asked)
  expect((await f.service.answerOwnQuestion(f.service.state().current!.target.threadId, { requestId: watcherQuestionRequestId(skipped.questionId), answer: '', skipped: true }))).toBeNull()
  await f.answerNews(skipped.questionId)
  expect(f.service.state().requests.some(request => request.rootUserMessageId.startsWith('answered:'))).toBe(false)
})

it('keeps the model a request named for a follow-up “go” while no thread was started under it, and not after (#2483)', async () => {
  const f = await fixture()
  const first = await f.send('Start the Synthetic project, run by the Synthetic other model.')
  await f.closes(first)
  const go = await f.send('go')
  expect(await f.start(go, f.other.id)).toMatchObject({ status: 'ok', effectiveChoices: { modelId: f.other.id } })
  await f.endTurn()
  // That request started a thread, so a later message carries its words no further.
  const next = await f.send('Start another one')
  expect(await f.start(next, f.other.id)).toMatchObject({ status: 'ok', effectiveChoices: { modelId: f.base.id } })
})
