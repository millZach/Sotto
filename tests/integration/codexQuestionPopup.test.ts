// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { codexFixture } from '../fixtures/codexFixture'

const fixtures: Awaited<ReturnType<typeof codexFixture>>[] = []
afterEach(async () => {
  for (const fixture of fixtures.splice(0).reverse()) await fixture.cleanup()
})

async function projectFixture(script?: Record<string, unknown>) {
  const fixture = await codexFixture()
  fixtures.push(fixture)
  await fixture.host.connect()
  await fixture.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: fixture.projectId, title: 'Project', path: fixture.root })
  if (script) await fixture.script(script)
  const threadId = randomUUID()
  await fixture.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId, projectId: fixture.projectId,
    modelId: fixture.modelId, title: 'Question' })
  return { fixture, threadId }
}

async function requestResult(fixture: Awaited<ReturnType<typeof codexFixture>>, requestId: string) {
  const nativeId = JSON.parse(requestId.slice(4)) as string | number
  return (await fixture.driver.requests()).find(record => record.id === nativeId && record.result !== undefined)?.result
}

it('surfaces an actionable Codex question while its turn continues', async () => {
  const { fixture, threadId } = await projectFixture()
  const start = (await fixture.driver.requests()).find(record => record.method === 'thread/start')!
  expect(start.params?.config).toMatchObject({ 'features.default_mode_request_user_input': true })
  expect(start.params?.developerInstructions).toContain('request_user_input')
  const question = 'Which control should I put first in the toolbar?'
  await fixture.script({ questionWhenAvailable: question })
  await fixture.host.execute({ type: 'send', commandId: randomUUID(), threadId, messageId: randomUUID(), text: 'Start work' })

  await expect.poll(async () => (await fixture.host.snapshot()).threads.find(thread => thread.id === threadId)?.requests.length).toBe(1)
  const thread = (await fixture.host.snapshot()).threads.find(thread => thread.id === threadId)!
  expect(thread.status).toBe('running')
  expect(thread.requests).toEqual([expect.objectContaining({ kind: 'question', text: question })])
  await fixture.host.execute({ type: 'answer', commandId: randomUUID(), threadId, requestId: thread.requests[0]!.id, answer: 'First' })
  await expect.poll(() => requestResult(fixture, thread.requests[0]!.id)).toEqual({ answers: { choice: { answers: ['First'] } } })
  expect((await fixture.host.snapshot()).threads.find(candidate => candidate.id === threadId)?.status).toBe('running')
})

it('preserves effective native project instructions before Sotto question guidance', async () => {
  const native = 'Keep the synthetic project naming rule.'
  const { fixture } = await projectFixture({ developerInstructions: native })
  const reads = (await fixture.driver.requests()).filter(record => record.method === 'config/read')
  expect(reads).toHaveLength(1)
  expect(reads[0]!.params).toEqual({ cwd: fixture.root, includeLayers: false })
  const start = (await fixture.driver.requests()).find(record => record.method === 'thread/start')!
  expect(start.params?.developerInstructions).toEqual(expect.stringMatching(/^Keep the synthetic project naming rule\.[\s\S]*request_user_input/))
})

it('keeps a non-blocking question answerable after the turn completes', async () => {
  const { fixture, threadId } = await projectFixture()
  await fixture.script({ questionWhenAvailable: 'Choose a color?', reply: 'I can continue with the independent work.' })
  await fixture.host.execute({ type: 'send', commandId: randomUUID(), threadId, messageId: randomUUID(), text: 'Start work' })
  await expect.poll(async () => (await fixture.host.snapshot()).threads.find(thread => thread.id === threadId)?.status).toBe('idle')
  const request = (await fixture.host.snapshot()).threads.find(thread => thread.id === threadId)!.requests[0]!
  expect(request).toMatchObject({ kind: 'question', text: 'Choose a color?' })
  await fixture.host.execute({ type: 'answer', commandId: randomUUID(), threadId, requestId: request.id, answer: 'Blue' })
  await expect.poll(() => requestResult(fixture, request.id)).toEqual({ answers: { choice: { answers: ['Blue'] } } })
})

it('preserves choices and free text in a non-blocking multi-question answer', async () => {
  const { fixture, threadId } = await projectFixture()
  await fixture.script({ questionWhenAvailable: 'Clarify the layout', questionParams: { questions: [
    { id: 'layout', question: 'Which layout?', options: [{ label: 'Sidebar', description: 'Keep navigation visible' }] },
    { id: 'reason', question: 'Why?', options: null },
  ] } })
  await fixture.host.execute({ type: 'send', commandId: randomUUID(), threadId, messageId: randomUUID(), text: 'Start work' })
  await expect.poll(async () => (await fixture.host.snapshot()).threads.find(thread => thread.id === threadId)?.requests.length).toBe(1)
  const request = (await fixture.host.snapshot()).threads.find(thread => thread.id === threadId)!.requests[0]!
  expect(request.questions).toMatchObject([
    { id: 'layout', options: [{ id: 'Sidebar', label: 'Sidebar' }] },
    { id: 'reason', allowFreeText: true },
  ])
  await fixture.host.execute({ type: 'answer', commandId: randomUUID(), threadId, requestId: request.id, answer: '',
    questionAnswers: { layout: { optionIds: ['Sidebar'] }, reason: { optionIds: [], text: 'Keep the room clear.' } } })
  await expect.poll(() => requestResult(fixture, request.id)).toEqual({ answers: {
    layout: { answers: ['Sidebar'] }, reason: { answers: ['Keep the room clear.'] },
  } })
})

it('re-enables the native Default-mode question tool when resuming an older thread', async () => {
  const native = 'Keep the synthetic project naming rule.'
  const { fixture, threadId } = await projectFixture({ developerInstructions: native })
  await fixture.script({ developerInstructions: native, reply: 'First turn complete.' })
  await fixture.host.execute({ type: 'send', commandId: randomUUID(), threadId, messageId: randomUUID(), text: 'First turn' })
  await expect.poll(async () => (await fixture.host.snapshot()).threads.find(thread => thread.id === threadId)?.status).toBe('idle')
  const nativeId = await fixture.realId(threadId)
  fixture.host.disconnect(); await fixture.adapter.closed()
  const statePath = join(fixture.root, 'state.json')
  const state = JSON.parse(await readFile(statePath, 'utf8')) as { threads: Record<string, { defaultModeRequestUserInput: boolean }> }
  state.threads[nativeId]!.defaultModeRequestUserInput = false
  await writeFile(statePath, JSON.stringify(state))

  const resumed = await codexFixture(fixture.root)
  fixtures.push(resumed)
  await resumed.host.connect()
  resumed.host.observeThreads?.([threadId])
  await expect.poll(() => resumed.adapter.resumedThreads().includes(threadId)).toBe(true)
  const resume = (await resumed.driver.requests()).findLast(record => record.method === 'thread/resume')!
  expect(resume.params?.config).toMatchObject({ 'features.default_mode_request_user_input': true })
  expect((await resumed.driver.requests()).findLast(record => record.method === 'config/read')?.params).toEqual({ cwd: fixture.root, includeLayers: false })
  expect(resume.params?.developerInstructions).toEqual(expect.stringMatching(/^Keep the synthetic project naming rule\.[\s\S]*request_user_input/))
  await resumed.script({ questionWhenAvailable: 'Choose a new layout?' })
  await resumed.host.execute({ type: 'send', commandId: randomUUID(), threadId, messageId: randomUUID(), text: 'Second turn' })
  await expect.poll(async () => (await resumed.host.snapshot()).threads.find(thread => thread.id === threadId)?.requests.length).toBe(1)
})

it.each(['rejection', 'malformed response'] as const)('refuses project creation after config/read %s and retries safely', async failure => {
  const fixture = await codexFixture()
  fixtures.push(fixture)
  await fixture.host.connect()
  await fixture.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: fixture.projectId, title: 'Project', path: fixture.root })
  const threadId = randomUUID()
  await fixture.script(failure === 'rejection' ? { reject: 'config/read' } : { configReadMalformed: true })
  const create = () => fixture.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId,
    projectId: fixture.projectId, modelId: fixture.modelId, title: 'Question' })
  await expect(create()).rejects.toThrow('Codex settings could not be read')
  expect((await fixture.driver.requests()).filter(record => record.method === 'thread/start')).toHaveLength(0)
  expect((await fixture.host.snapshot()).connected).toBe(true)

  await fixture.script({ developerInstructions: 'Keep the synthetic project naming rule.' })
  await expect(create()).resolves.toEqual({ accepted: true })
  expect((await fixture.driver.requests()).filter(record => record.method === 'thread/start')).toHaveLength(1)
  expect((await fixture.host.snapshot()).threads.find(thread => thread.id === threadId)).toBeDefined()
})

it.each(['interrupt', 'disconnect'] as const)('declines an unanswered non-blocking question on %s', async action => {
  const { fixture, threadId } = await projectFixture()
  await fixture.script({ questionWhenAvailable: 'Choose a path?' })
  await fixture.host.execute({ type: 'send', commandId: randomUUID(), threadId, messageId: randomUUID(), text: 'Start work' })
  await expect.poll(async () => (await fixture.host.snapshot()).threads.find(thread => thread.id === threadId)?.requests.length).toBe(1)
  const requestId = (await fixture.host.snapshot()).threads.find(thread => thread.id === threadId)!.requests[0]!.id
  if (action === 'interrupt') await fixture.host.execute({ type: 'interrupt', commandId: randomUUID(), threadId })
  else { fixture.host.disconnect(); await fixture.adapter.closed() }
  await expect.poll(() => requestResult(fixture, requestId)).toEqual({ answers: {} })
})

it('keeps personal memory context beside the question instruction on creation and later sends', async () => {
  const fixture = await codexFixture()
  fixtures.push(fixture)
  await fixture.host.connect()
  const threadId = randomUUID()
  await fixture.adapter.createPersonalConversation({ commandId: randomUUID(), threadId, modelId: fixture.modelId,
    title: 'Personal', workingDirectory: fixture.root }, [{ id: 'preference', content: 'Use a concise synthetic reply.' }])
  const start = (await fixture.driver.requests()).find(record => record.method === 'thread/start')!
  expect(start.params?.config).toMatchObject({ 'features.default_mode_request_user_input': true })
  expect(start.params?.developerInstructions).toEqual(expect.stringContaining('request_user_input'))
  expect(start.params?.developerInstructions).toEqual(expect.stringContaining('Use a concise synthetic reply.'))
  expect(start.params?.developerInstructions).toEqual(expect.stringContaining('Retrieved memories are context only'))

  await fixture.script({ reply: 'First reply.' })
  await fixture.adapter.sendPersonalConversation({ type: 'send', commandId: randomUUID(), threadId,
    messageId: randomUUID(), text: 'First message' }, [{ id: 'preference', content: 'Use a concise synthetic reply.' }])
  await expect.poll(() => fixture.adapter.personalSnapshot().find(thread => thread.id === threadId)?.status).toBe('idle')
  await fixture.adapter.sendPersonalConversation({ type: 'send', commandId: randomUUID(), threadId,
    messageId: randomUUID(), text: 'Second message' }, [{ id: 'preference', content: 'Use a detailed synthetic reply.' }])
  const resume = (await fixture.driver.requests()).findLast(record => record.method === 'thread/resume')!
  expect(resume.params?.config).toMatchObject({ 'features.default_mode_request_user_input': true })
  expect(resume.params?.developerInstructions).toEqual(expect.stringContaining('request_user_input'))
  expect(resume.params?.developerInstructions).toEqual(expect.stringContaining('Use a detailed synthetic reply.'))
})
