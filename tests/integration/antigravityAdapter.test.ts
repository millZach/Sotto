// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentActivity } from '../../src/shared/agentActivity'
import type { AgentRuntimeMode } from '../../src/shared/agents'
import { describeAdapterContract } from './adapterContract'
import { antigravityFixture, antigravityFixtureSkips } from '../fixtures/fakeAntigravityFixture'

describeAdapterContract('Antigravity ACP', session => antigravityFixture(undefined, undefined, session), antigravityFixtureSkips)

describe('Antigravity ACP adapter', () => {
  let f: Awaited<ReturnType<typeof antigravityFixture>> | undefined
  afterEach(async () => { const previous = f; f = undefined; await previous?.cleanup() })
  const open = async (options: { runtimeMode?: AgentRuntimeMode; fixture?: Parameters<typeof antigravityFixture>[3] } = {}) => {
    f = await antigravityFixture(undefined, undefined, {}, options.fixture)
    await f.host.connect()
    await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Project', path: f.root })
    const id = randomUUID()
    expect(await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f.projectId, modelId: f.modelId, title: 'Antigravity thread',
      ...(options.runtimeMode ? { runtimeMode: options.runtimeMode } : {}) })).toMatchObject({ accepted: true })
    f.host.observeThreads?.([id])
    return id
  }
  const thread = async (id: string) => (await f!.host.snapshot()).threads.find(item => item.id === id)!
  const processes = async () => (await f!.requests()).filter(record => record.method === 'fixture/process').map(record => record.params as { args: string[]; environment: Record<string, unknown>; cwd: string })
  const answers = async () => (await f!.requests()).filter(record => record.method === undefined && String(record.id).startsWith('antigravity-')).map(record => record.result?.outcome)

  it('reads the account’s Gemini models only, each with its own thinking levels, and never switches agy to another', async () => {
    f = await antigravityFixture()
    const snapshot = await f.host.connect()
    // The fake lists Claude Sonnet 5.5 too, as real agy lists Claude and GPT models; Google's terms keep them out (ADR-0212).
    expect(snapshot.models.map(model => [model.id, model.source, model.reasoningEfforts])).toEqual([
      ['gemini-3.8-flash', undefined, ['low', 'medium', 'high']],
      ['gemini-4-carbon', undefined, ['low', 'high']],
    ])
    const switched = (await f.requests()).filter(record => record.method === 'session/set_config_option' && (record.params as { configId?: string }).configId === 'model')
    expect(switched.map(record => (record.params as { value: string }).value)).toEqual(['gemini-4-carbon'])
    expect(snapshot.models[0]).toMatchObject({ provider: 'Antigravity', recommended: true, runtimeModes: ['approval-required', 'auto-accept-edits', 'auto', 'full-access'] })
    expect(snapshot.version).toContain('1.5.13')
  })

  it('offers Auto only where the account’s sessions offer agy’s own Auto, as T3 does', async () => {
    f = await antigravityFixture()
    await f.script({ noAuto: true })
    const snapshot = await f.host.connect()
    expect(snapshot.models[0]!.runtimeModes).toEqual(['approval-required', 'auto-accept-edits', 'full-access'])
  })

  it('runs agy with Sotto’s own Gemini folder and environment, never the user’s keys', async () => {
    const id = await open({ fixture: { environment: { ...process.env, GEMINI_API_KEY: 'user-key', GOOGLE_APPLICATION_CREDENTIALS: '/tmp/creds.json', BROWSER: 'firefox' } } })
    void id
    const started = (await processes()).at(-1)!
    expect(started.args.slice(0, 5)).toEqual(['acp', '--gemini-dir', join(f!.root, 'antigravity', 'gemini'), '--app-data-dir', 'antigravity-acp'])
    expect(started.environment).toMatchObject({ GEMINI_HOME: join(f!.root, 'antigravity', 'gemini'), AGY_ACP_FORCE_FILE_STORAGE: '1', AGY_CLI_DISABLE_AUTO_UPDATE: '1',
      SSH_CONNECTION: '127.0.0.1 0 127.0.0.1 0', hasGeminiKey: false, hasCredentials: false })
    expect(started.environment.BROWSER).toBeUndefined()
  })

  it('says it is not signed in, in words, when agy asks for a sign-in', async () => {
    f = await antigravityFixture()
    await f.script({ signedOut: true })
    await expect(f.host.connect()).rejects.toThrow('Antigravity is not signed in. Sign in from Antigravity’s row in Settings › Providers, then connect again. Your threads are kept.')
  })

  it('refuses a client older than 1.5.0, naming its version', async () => {
    f = await antigravityFixture()
    await f.script({ cliVersion: '1.4.9' })
    await expect(f.host.connect()).rejects.toThrow('Antigravity 1.5.0 or newer is needed, and this one is 1.4.9.')
  })

  it('gives a Gemini API key sign-in its key in the environment only', async () => {
    await open({ fixture: { signIn: async () => ({ method: 'gemini-api-key', apiKey: 'sotto-held-key' }) } })
    const started = (await processes()).at(-1)!
    expect(started.environment).toMatchObject({ hasGeminiKey: true })
    expect(started.environment.SSH_CONNECTION).toBeUndefined()
    expect(JSON.stringify(started.args)).not.toContain('sotto-held-key')
    expect((await f!.requests()).find(record => record.method === 'authenticate')?.params).toEqual({ methodId: 'gemini-api-key' })
  })

  it('leaves every permission to the user on Ask for approval, and never answers allow always', async () => {
    const id = await open()
    expect(await f!.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: 'm1', text: 'Build it' })).toEqual({ accepted: true })
    await f!.action(id, { type: 'permission', text: 'npm run build' })
    await expect.poll(async () => (await thread(id)).requests.length).toBe(1)
    const request = (await thread(id)).requests[0]!
    expect(request.permissionChoices?.map(choice => [choice.id, choice.label])).toEqual([['allow-once', 'Allow once'], ['reject-once', 'Reject']])
    expect(request.context?.command).toBe('npm run build')
    expect(await f!.host.execute({ type: 'answer', commandId: randomUUID(), threadId: id, requestId: request.id, answer: '', approved: true })).toEqual({ accepted: true })
    await expect.poll(answers).toEqual([{ outcome: 'selected', optionId: 'allow-once' }])
  })

  it('answers file changes for the user on Allow edits and asks about commands', async () => {
    const id = await open({ runtimeMode: 'auto-accept-edits' })
    await f!.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: 'm1', text: 'Edit it' })
    await f!.action(id, { type: 'edit-permission' })
    await expect.poll(answers).toEqual([{ outcome: 'selected', optionId: 'allow-once' }])
    expect((await thread(id)).requests).toEqual([])
    await f!.action(id, { type: 'permission', text: 'rm -rf build' })
    await expect.poll(async () => (await thread(id)).requests.length).toBe(1)
    expect(await answers()).toHaveLength(1)
  })

  it('answers every permission for the user on Full access, and never a question', async () => {
    const id = await open({ runtimeMode: 'full-access' })
    await f!.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: 'm1', text: 'Go' })
    await f!.action(id, { type: 'permission', text: 'npm test' })
    await expect.poll(answers).toEqual([{ outcome: 'selected', optionId: 'allow-once' }])
    await f!.action(id, { type: 'question', text: 'Which colour?' })
    await expect.poll(async () => (await thread(id)).requests.length).toBe(1)
    const question = (await thread(id)).requests[0]!
    expect(question.kind).toBe('question')
    expect(question.options.map(option => option.label)).toEqual(['Blue', 'Red'])
    await f!.host.execute({ type: 'answer', commandId: randomUUID(), threadId: id, requestId: question.id, answer: 'Red' })
    await expect.poll(answers).toEqual([{ outcome: 'selected', optionId: 'allow-once' }, { outcome: 'selected', optionId: 'Red' }])
  })

  const formReplies = async () => (await f!.requests()).filter(record => record.method === undefined && String(record.id).startsWith('antigravity-')).map(record => record.result ?? { refused: true })
  const ask = async (id: string, questions: { question: string; options: string[]; several?: boolean }[], form?: Record<string, unknown>, required?: string[]) => {
    const before = (await thread(id)).requests.length
    await f!.action(id, { type: 'ask-question', questions, ...(form ? { form } : {}), ...(required ? { required } : {}) })
    if (form) return undefined
    await expect.poll(async () => (await thread(id)).requests.length).toBe(before + 1)
    return (await thread(id)).requests.at(-1)!
  }

  it('asks agy’s own questions as one card, offering forms, and answers its form with each question’s choices and words, even on Full access', async () => {
    const id = await open({ runtimeMode: 'full-access' })
    await f!.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: 'm1', text: 'Go' })
    // The thread's own process takes forms; the probe that reads the account's models does not.
    expect((await f!.requests()).filter(record => record.method === 'initialize').map(record => (record.params?.clientCapabilities as { elicitation?: unknown }).elicitation))
      .toEqual([undefined, { form: {} }])
    const card = await ask(id, [{ question: 'Tea or coffee?', options: ['Tea', 'Coffee'] }, { question: 'Which days are you free?', options: ['Monday', 'Tuesday', 'Friday'], several: true }])
    expect(card).toMatchObject({ kind: 'question', text: 'The agent has 2 questions.', skippable: true, questions: [
      { id: 'q1', question: 'Tea or coffee?', options: [{ id: '1', label: 'Tea' }, { id: '2', label: 'Coffee' }], multiSelect: false, allowFreeText: true, required: false },
      { id: 'q2', question: 'Which days are you free?', options: [{ id: '1', label: 'Monday' }, { id: '2', label: 'Tuesday' }, { id: '3', label: 'Friday' }], multiSelect: true, allowFreeText: true, required: false },
    ] })
    expect(await f!.host.execute({ type: 'answer', commandId: randomUUID(), threadId: id, requestId: card!.id, answer: '',
      questionAnswers: { q1: { optionIds: ['2'] }, q2: { optionIds: ['1', '3'], text: 'Sunday too' } } })).toMatchObject({ accepted: true })
    // A required question takes one of its choices, never words alone, so its own field is always filled.
    const needed = await ask(id, [{ question: 'Tea or coffee?', options: ['Tea', 'Coffee'] }], undefined, ['q1'])
    expect(needed!.questions![0]).toMatchObject({ id: 'q1', required: true, allowFreeText: false })
    await expect(f!.host.execute({ type: 'answer', commandId: randomUUID(), threadId: id, requestId: needed!.id, answer: '', questionAnswers: { q1: { optionIds: [], text: 'Green tea' } } })).rejects.toThrow()
    await f!.host.execute({ type: 'answer', commandId: randomUUID(), threadId: id, requestId: needed!.id, answer: 'Tea' })
    // agy's form as 1.5.14 sends it requires no question, so one may be left unanswered.
    const second = await ask(id, [{ question: 'Tea or coffee?', options: ['Tea', 'Coffee'] }, { question: 'Milk?', options: ['Yes', 'No'] }])
    await f!.host.execute({ type: 'answer', commandId: randomUUID(), threadId: id, requestId: second!.id, answer: '', questionAnswers: { q2: { optionIds: ['1'] } } })
    await expect.poll(formReplies).toEqual([{ action: 'accept', content: { q1: '2', q2: ['1', '3'], q2_other: 'Sunday too' } }, { action: 'accept', content: { q1: '1' } }, { action: 'accept', content: { q2: '1' } }])
    expect((await thread(id)).requests).toEqual([])
  })

  it('answers one of agy’s questions from words, as its option or as the user’s own, declines a skipped one and cancels one left when the turn stops', async () => {
    const id = await open()
    await f!.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: 'm1', text: 'Go' })
    const tea = [{ question: 'Tea or coffee?', options: ['Tea', 'Coffee'] }]
    let card = await ask(id, tea)
    expect(card).toMatchObject({ text: 'Tea or coffee?', options: [{ id: '1', label: 'Tea' }, { id: '2', label: 'Coffee' }] })
    await f!.host.execute({ type: 'answer', commandId: randomUUID(), threadId: id, requestId: card!.id, answer: 'tea' })
    card = await ask(id, tea)
    await f!.host.execute({ type: 'answer', commandId: randomUUID(), threadId: id, requestId: card!.id, answer: 'Green tea, please' })
    card = await ask(id, tea)
    await f!.host.execute({ type: 'answer', commandId: randomUUID(), threadId: id, requestId: card!.id, answer: '', skipped: true })
    await ask(id, tea)
    await f!.host.execute({ type: 'interrupt', commandId: randomUUID(), threadId: id })
    // A form still open when its turn ends, as after a Stop that only cancelled, goes with the turn.
    await expect.poll(async () => (await thread(id)).status).not.toBe('running')
    await f!.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: 'm2', text: 'Again' })
    await ask(id, tea)
    await f!.action(id, { type: 'complete', reason: 'cancelled' })
    await expect.poll(formReplies).toEqual([{ action: 'accept', content: { q1: '1' } }, { action: 'accept', content: { q1_other: 'Green tea, please' } }, { action: 'decline' }, { action: 'cancel' }, { action: 'cancel' }])
    expect((await thread(id)).requests).toEqual([])
  })

  it('refuses a form of another shape, so agy asks in its reply instead, and leaves the user no card', async () => {
    const id = await open()
    await f!.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: 'm1', text: 'Go' })
    await ask(id, [{ question: 'How many?', options: [] }], { count: { type: 'number', title: 'How many?' } })
    // A constraint Sotto would not keep makes another shape too.
    await expect.poll(async () => (await thread(id)).status).not.toBe('running')
    await f!.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: 'm2', text: 'Again' })
    await ask(id, [{ question: 'Pick two days', options: [] }], { q1: { type: 'array', title: 'Pick two days', minItems: 2, items: { anyOf: [{ const: '1', title: 'Monday' }, { const: '2', title: 'Friday' }] } } })
    // So does `required` naming a field that is not one of its questions.
    await expect.poll(async () => (await thread(id)).status).not.toBe('running')
    await f!.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: 'm3', text: 'Once more' })
    await ask(id, [{ question: 'Tea?', options: [] }], { q1: { type: 'string', title: 'Tea?', oneOf: [{ const: '1', title: 'Yes' }] }, q1_other: { type: 'string', title: 'Other' } }, ['q1_other'])
    await expect.poll(formReplies).toEqual([{ refused: true }, { refused: true }, { refused: true }])
    await expect.poll(async () => (await thread(id)).messages.filter(message => message.role === 'assistant').map(message => message.text)).toEqual(['How many?', 'Pick two days', 'Tea?'])
    expect((await thread(id)).requests).toEqual([])
  })

  it('takes a waiting request off the user when the thread moves to Full access', async () => {
    const id = await open()
    await f!.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: 'm1', text: 'Go' })
    await f!.action(id, { type: 'permission', text: 'npm test' })
    await expect.poll(async () => (await thread(id)).requests.length).toBe(1)
    expect(await f!.host.execute({ type: 'configure-thread', commandId: randomUUID(), threadId: id, runtimeMode: 'full-access' })).toMatchObject({ accepted: true })
    await expect.poll(answers).toEqual([{ outcome: 'selected', optionId: 'allow-once' }])
    expect((await thread(id)).requests).toEqual([])
  })

  it('runs Auto as agy’s own Auto mode and sets the model and thinking before the prompt', async () => {
    const id = await open({ runtimeMode: 'auto' })
    await f!.host.execute({ type: 'configure-thread', commandId: randomUUID(), threadId: id, modelId: 'gemini-4-carbon', reasoningEffort: 'low' })
    await f!.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: 'm1', text: 'Go' })
    const settings = (await f!.requests()).filter(record => record.method === 'session/set_config_option').map(record => [record.params?.configId, record.params?.value])
    expect(settings).toEqual(expect.arrayContaining([['mode', 'auto'], ['model', 'gemini-4-carbon'], ['thinking_level', 'low']]))
    expect(settings.indexOf(settings.find(entry => entry[0] === 'model')!)).toBeLessThan(settings.findIndex(entry => entry[0] === 'thinking_level' && entry[1] === 'low'))
  })

  it('takes agy out of its own Auto at once when a working thread leaves Auto, not at the next prompt', async () => {
    const id = await open({ runtimeMode: 'auto' })
    await f!.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: 'm1', text: 'Work on it' })
    await expect.poll(async () => (await thread(id)).status).toBe('running')
    const modes = async () => (await f!.requests()).filter(record => record.method === 'session/set_config_option' && record.params?.configId === 'mode').map(record => record.params?.value)
    expect(await modes()).toEqual(['auto'])
    await f!.host.execute({ type: 'configure-thread', commandId: randomUUID(), threadId: id, runtimeMode: 'approval-required' })
    await expect.poll(modes).toEqual(['auto', 'default'])
    expect((await thread(id)).status).toBe('running')
  })

  it('steers a running turn with a second prompt in the same session, as T3 does on 1.5', async () => {
    const id = await open()
    await f!.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: 'm1', text: 'Write the report' })
    await expect.poll(async () => (await thread(id)).status).toBe('running')
    expect(await f!.host.execute({ type: 'steer', threadId: id, commandId: randomUUID(), messageId: 'm2', text: 'Make it shorter' })).toEqual({ accepted: true })
    // The adapter has written the steer when it answers; the fake agy records it a moment later.
    await expect.poll(async () => (await f!.requests()).filter(record => record.method === 'session/prompt').length).toBe(2)
    expect((await thread(id)).status).toBe('running')
    await f!.driver.completeTurn(id, 'Short report')
    await expect.poll(async () => (await thread(id)).status).toBe('idle')
    expect((await thread(id)).messages.map(message => [message.role, message.text])).toEqual([['user', 'Write the report'], ['user', 'Make it shorter'], ['assistant', 'Short report']])
  })

  it('counts a thread’s tokens and its context from what agy sends with each turn', async () => {
    const id = await open()
    // The numbers agy 1.5.13 sent for two short turns: inputTokens leaves out the cache, output holds the thinking.
    await f!.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: 'm1', text: 'Say ok' })
    await f!.action(id, { type: 'complete', text: 'ok', fullness: { used: 9101, size: 1048576 },
      usage: { inputTokens: 9075, outputTokens: 26, cachedReadTokens: 0, cachedWriteTokens: 0, thoughtTokens: 23, totalTokens: 9101 } })
    await expect.poll(async () => (await thread(id)).status).toBe('idle')
    expect((await thread(id)).usage).toMatchObject({ contextUsed: 9101, contextWindow: 1048576, modelId: f!.modelId, partial: true,
      latest: { input: 9075, output: 26, cached: 0, cacheWrite: 0 }, total: { input: 9075, output: 26 } })
    await f!.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: 'm2', text: 'Say ok again' })
    await f!.action(id, { type: 'complete', text: 'ok', fullness: { used: 9203, size: 1048576 },
      usage: { inputTokens: 2162, outputTokens: 23, cachedReadTokens: 7018, cachedWriteTokens: 0, thoughtTokens: 20, totalTokens: 9203 } })
    // The answer comes after the context reading, so wait for the total it adds.
    await expect.poll(async () => (await thread(id)).usage?.total?.output).toBe(49)
    expect((await thread(id)).usage).toMatchObject({ contextUsed: 9203, latest: { input: 9180, output: 23, cached: 7018 }, total: { input: 18255, output: 49, cached: 7018 } })
  })

  it('compacts a thread with agy’s own /compact, a quiet turn, and leaves its context size to the next turn', async () => {
    const id = await open()
    const prompts = async () => (await f!.requests()).filter(record => record.method === 'session/prompt').map(record => (record.params as { prompt: { text?: string }[] }).prompt[0]?.text)
    // The numbers agy 1.5.13 sent on Gemini 3.8 Flash: a turn, /compact, then the next turn on the folded conversation.
    await f!.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: 'm1', text: 'Write about bicycles' })
    await f!.action(id, { type: 'complete', text: 'Bicycles', fullness: { used: 11964, size: 1048576 },
      usage: { inputTokens: 9086, outputTokens: 2878, cachedReadTokens: 0, cachedWriteTokens: 0, thoughtTokens: 1876, totalTokens: 11964 } })
    await expect.poll(async () => (await thread(id)).usage?.total?.output).toBe(2878)
    const before = (await thread(id)).activities?.filter(row => row.kind !== 'turn').length
    // agy 1.5.13 lists /compact, so the thread offers Compact context.
    expect((await thread(id)).manualCompactionSupported).toBe(true)
    expect(await f!.host.execute({ type: 'compact-thread', threadId: id, commandId: 'compact-1' })).toEqual({ accepted: true })
    await expect.poll(prompts).toEqual(['Write about bicycles', '/compact'])
    expect((await thread(id)).compaction).toEqual({ commandId: 'compact-1', status: 'running' })
    // A message waits for the compaction rather than folding into it.
    await expect(f!.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: 'm2', text: 'Too soon' })).rejects.toThrow('Antigravity is compacting this thread.')
    await f!.action(id, { type: 'complete', fullness: { used: 14623, size: 1048576 },
      usage: { inputTokens: 2089, outputTokens: 1321, cachedReadTokens: 11213, cachedWriteTokens: 0, thoughtTokens: 763, totalTokens: 14623 } })
    await expect.poll(async () => (await thread(id)).compaction?.status).toBe('completed')
    const compacted = await thread(id)
    expect(compacted.status).toBe('idle')
    // Its tokens count toward the total, the last turn's stay the latest, and the size from before the fold is dropped.
    expect(compacted.usage).toMatchObject({ latest: { output: 2878 }, total: { output: 4199 } })
    expect(compacted.usage?.contextUsed).toBeUndefined()
    // No reply, and what agy said while it folded is not shown as a turn's work; the transcript shows the boundary.
    expect(compacted.messages.map(message => message.text)).toEqual(['Write about bicycles', 'Bicycles'])
    expect(compacted.activities?.filter(row => row.kind !== 'turn' && row.kind !== 'compaction').length).toBe(before)
    expect(compacted.activities?.find(row => row.kind === 'compaction')).toMatchObject({ title: 'Context compacted', context: { before: 11964 } })
    // A reading with only the window leaves the boundary open; the next turn's smaller size closes it.
    await f!.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: 'm4', text: 'Say hi' })
    await f!.action(id, { type: 'complete', text: 'hi', fullness: { size: 1048576 } })
    await expect.poll(async () => (await thread(id)).messages.length).toBe(4)
    await expect.poll(async () => (await thread(id)).status).toBe('idle')
    expect((await thread(id)).activities?.find(row => row.kind === 'compaction')?.context).toEqual({ before: 11964 })
    await f!.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: 'm3', text: 'Say ok' })
    await f!.action(id, { type: 'complete', text: 'ok', fullness: { used: 9816, size: 1048576 },
      usage: { inputTokens: 9774, outputTokens: 42, cachedReadTokens: 0, cachedWriteTokens: 0, thoughtTokens: 40, totalTokens: 9816 } })
    await expect.poll(async () => (await thread(id)).usage?.contextUsed).toBe(9816)
    expect((await thread(id)).activities?.find(row => row.kind === 'compaction')?.context).toEqual({ before: 11964, after: 9816 })
  })

  it('offers compaction only on a client that lists /compact, and never sends it to one that does not', async () => {
    f = await antigravityFixture()
    await f.script({ noCompact: true })
    await f.host.connect()
    await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Project', path: f.root })
    const id = randomUUID()
    await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f.projectId, modelId: f.modelId, title: 'Antigravity thread' })
    f.host.observeThreads?.([id])
    await expect.poll(async () => (await thread(id)).manualCompactionSupported).toBe(false)
    await expect(f.host.execute({ type: 'compact-thread', threadId: id, commandId: 'compact-1' })).rejects.toThrow('This Antigravity client does not offer /compact.')
    expect((await f.requests()).some(record => record.method === 'session/prompt')).toBe(false)
  })

  it('does not call a /compact agy answered in words a compaction', async () => {
    const id = await open()
    await f!.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: 'm1', text: 'Say ok' })
    await f!.driver.completeTurn(id, 'ok')
    await expect.poll(async () => (await thread(id)).status).toBe('idle')
    await f!.host.execute({ type: 'compact-thread', threadId: id, commandId: 'compact-1' })
    await expect.poll(async () => (await thread(id)).compaction?.status).toBe('running')
    await f!.driver.completeTurn(id, 'What would you like me to compact?')
    await expect.poll(async () => (await thread(id)).compaction?.status).toBe('failed')
    expect((await thread(id)).compaction?.error).toBe('Antigravity answered /compact in words rather than compacting this thread. Nothing was lost. Update Antigravity, then compact again.')
    expect((await thread(id)).activities?.some(row => row.kind === 'compaction')).toBe(false)
  })

  it('says a compaction failed when agy stops before it finishes, and keeps the thread', async () => {
    const id = await open()
    await f!.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: 'm1', text: 'Say ok' })
    await f!.driver.completeTurn(id, 'ok')
    await expect.poll(async () => (await thread(id)).status).toBe('idle')
    await f!.host.execute({ type: 'compact-thread', threadId: id, commandId: 'compact-1' })
    await expect.poll(async () => (await thread(id)).compaction?.status).toBe('running')
    await f!.host.execute({ type: 'interrupt', threadId: id, commandId: randomUUID() })
    await expect.poll(async () => (await thread(id)).compaction).toEqual({ commandId: 'compact-1', status: 'failed', error: 'The compaction was stopped. Nothing was lost. Compact the thread again when you want to.' })
    expect((await thread(id)).messages.map(message => message.text)).toEqual(['Say ok', 'ok'])
    expect((await thread(id)).activities?.some(row => row.kind === 'compaction')).toBe(false)
  })

  it('shows a command with agy’s own fields', async () => {
    const id = await open()
    await f!.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: 'm1', text: 'List files' })
    await f!.action(id, { type: 'tool', command: 'ls -la', output: 'README.md' })
    await expect.poll(async () => (await thread(id)).activities?.find(row => row.kind === 'command')).toMatchObject({ command: 'ls -la', output: 'README.md', exitCode: 0, status: 'completed' })
  })

  it('signs Gemini Enterprise in with agy’s own authenticate, and refuses it without a project', async () => {
    let project = ''
    f = await antigravityFixture(undefined, undefined, {}, { signIn: async () => ({ method: 'oauth-business', ...(project ? { project, location: 'us-central1' } : {}) }) })
    await expect(f.host.signInWithBrowser()).rejects.toThrow('Gemini Enterprise needs a Google Cloud project and location.')
    project = 'my-project'
    await f.host.signInWithBrowser()
    expect((await f.requests()).filter(record => record.method === 'authenticate').map(record => record.params)).toEqual([{ methodId: 'oauth-business' }])
    expect(JSON.parse(await readFile(join(f.root, 'antigravity', 'gemini', 'antigravity-acp', 'settings.json'), 'utf8'))).toEqual({ auth: { type: 'oauth-business' }, gcp: { project: 'my-project', location: 'us-central1' } })
  })

  it('signs out of Sotto’s own folder, stopping its processes and keeping its threads', async () => {
    const id = await open()
    await f!.host.signOut()
    expect((await f!.host.snapshot()).connected).toBe(false)
    expect((await f!.requests()).some(record => record.method === 'logout')).toBe(true)
    expect((await f!.host.snapshot()).threads.map(thread => thread.id)).toContain(id)
  })

  it('removes its scratch folder even when agy cannot be started at all', async () => {
    // A NUL in the program's name makes Node refuse the start at once, the way Windows refuses a batch file without a shell.
    f = await antigravityFixture(undefined, undefined, {}, { executable: 'agy\u0000' })
    await expect(f.host.signOut()).rejects.toThrow('Antigravity could not sign out.')
    expect(await readdir(join(f.root, 'antigravity', 'scratch')).catch(() => [])).toEqual([])
  })

  const probeTools = [{ name: 'sotto_probe', definitions: [], mcpServer: async () => ({ name: 'sotto_probe', type: 'http' as const, url: 'http://127.0.0.1:9/mcp', headers: [] }) }]
  it('hands Sotto’s tools to agy, which advertises no MCP capability yet takes HTTP servers, and none when agy says it cannot', async () => {
    const servers = async () => (await f!.requests()).filter(record => record.method === 'session/new' && record.params?.cwd === f!.root).map(record => (record.params?.mcpServers as { name: string }[]).map(server => server.name))
    for (const httpMcp of [undefined, false]) {
      await f?.cleanup()
      f = await antigravityFixture()
      if (httpMcp === false) await f.script({ httpMcp })
      f.host.useThreadTools(probeTools)
      await f.host.connect()
      await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Project', path: f.root })
      const id = randomUUID()
      await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f.projectId, modelId: f.modelId, title: 'Tools' })
      f.host.observeThreads?.([id])
      await f.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: 'm1', text: 'Go' })
      await expect.poll(servers).toEqual([httpMcp === false ? [] : ['sotto_probe']])
    }
  })

  it('hands the user’s own agy servers beside Sotto’s, on a new session and a resumed one, and leaves out one with a name Sotto uses', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-antigravity-thread-')), config = join(root, 'user-mcp_config.json')
    await writeFile(config, JSON.stringify({ mcpServers: {
      files: { command: 'files-mcp', args: ['--root', '.'], env: { FILES_TOKEN: 'user-secret' } },
      remote: { serverUrl: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer user-secret' } },
      sotto_probe: { command: 'not-sotto' },
      off: { command: 'off-mcp', disabled: true },
    } }))
    f = await antigravityFixture(root, undefined, {}, { userMcpConfig: config })
    f.host.useThreadTools(probeTools)
    await f.host.connect()
    await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Project', path: f.root })
    const id = randomUUID()
    await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f.projectId, modelId: f.modelId, title: 'Tools' })
    f.host.observeThreads?.([id])
    await f!.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: 'm1', text: 'Go' })
    const handed = async (method: string) => (await f!.requests()).filter(record => record.method === method && record.params?.cwd === f!.root).map(record => record.params?.mcpServers)
    const expected = [
      { name: 'sotto_probe', type: 'http', url: 'http://127.0.0.1:9/mcp', headers: [] },
      { name: 'files', command: 'files-mcp', args: ['--root', '.'], env: [{ name: 'FILES_TOKEN', value: 'user-secret' }] },
      { name: 'remote', type: 'http', url: 'https://mcp.example.com/mcp', headers: [{ name: 'Authorization', value: 'Bearer user-secret' }] },
    ]
    await expect.poll(() => handed('session/new')).toEqual([expected])
    // A new process resumes the session and needs the servers again; the user's file is read afresh.
    await writeFile(config, JSON.stringify({ mcpServers: { files: { command: 'files-mcp' } } }))
    await f!.host.disconnect(); await f!.host.connect()
    f!.host.observeThreads?.([id])
    await f!.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: 'm2', text: 'Again' })
    await expect.poll(() => handed('session/resume')).toEqual([[expected[0], { name: 'files', command: 'files-mcp', args: [], env: [] }]])
  })

  it('places a finished edit on its lines, numbered as the file is now, and leaves one it cannot place as agy reported it', async () => {
    const id = await open()
    await f!.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: 'm1', text: 'Go' })
    const before = 'alpha\nbravo\ncharlie\ndelta\n', after = 'alpha\nbravo\nCHARLIE\nextra\ndelta\n'
    const path = join(f!.root, 'notes.txt')
    await writeFile(path, after)
    // agy 1.5.14 names a Windows file with a leading slash: /C:/Users/….
    const named = process.platform === 'win32' ? `/${path.replace(/\\/gu, '/')}` : path
    await f!.action(id, { type: 'edit', path: named, oldText: before, newText: after })
    const edits = async () => (await thread(id)).activities?.filter(row => row.kind === 'file-change').map(row => row.changes?.map(change => change.diff))
    await expect.poll(edits).toEqual([['@@ -3 +3,2 @@\n-charlie\n+CHARLIE\n+extra']])
    // A file that no longer holds the new text cannot say where the edit is.
    await f!.action(id, { type: 'edit', path: join(f!.root, 'gone.txt'), oldText: 'a\n', newText: 'b\n' })
    await expect.poll(async () => (await edits())?.length).toBe(2)
    expect((await edits())?.[1]).toEqual(['--- before\na\n\n+++ after\nb\n'])
  })

  it('reads the account’s models again when agy updates, and keeps the list it had when that read fails', async () => {
    f = await antigravityFixture()
    await f.host.connect()
    const before = (await f.host.snapshot()).models.map(model => model.id)
    expect(before).not.toContain('gemini-4-pro')
    await f.script({ cliVersion: '1.5.14', newModels: [{ value: 'gemini-4-pro', name: 'Gemini 4 Pro', thinking: ['low', 'high'] }, { value: 'gpt-7', name: 'GPT-7' }] })
    await f.host.clientUpdated!()
    const after = await f.host.snapshot()
    expect(after.version).toMatch(/^1\.5\.14 /u)
    // Still Gemini only (ADR-0212's amendment), each with the thinking it offers.
    expect(after.models.map(model => model.id)).toEqual([...before, 'gemini-4-pro'])
    expect(after.models.find(model => model.id === 'gemini-4-pro')?.reasoningEfforts).toEqual(['low', 'high'])
    // A newer agy whose models cannot be read keeps the list from before; the update itself still holds.
    await f.script({ cliVersion: '1.5.15', newModels: [{ value: 'gemini-5', name: 'Gemini 5' }], signedOut: true })
    await f.host.clientUpdated!()
    expect((await f.host.snapshot()).version).toMatch(/^1\.5\.15 /u)
    expect((await f.host.snapshot()).models.map(model => model.id)).toEqual([...before, 'gemini-4-pro'])
  })

  it('shows a child agy launched as working, with its role and prompt, until its answer reaches the parent', async () => {
    const id = await open()
    await f!.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: 'm1', text: 'Go' })
    const child = async () => (await thread(id)).activities?.find(row => row.kind === 'subagent')?.agents?.[0]
    await f!.action(id, { type: 'subagent', role: 'Kestrel Responder', prompt: 'Reply with the word KESTREL.' })
    // The launch ends at once, as agy 1.5 runs the child detached; the child is still at work.
    await expect.poll(child).toMatchObject({ status: 'running', title: 'Kestrel Responder', prompt: 'Reply with the word KESTREL.' })
    // Seen at work now, so the Agents pane shows it working rather than last seen working.
    expect(Date.now() - Date.parse((await child())!.observedAt!)).toBeLessThan(60_000)
    expect((await child())?.model).toBeUndefined()
    await f!.action(id, { type: 'subagent-answer', text: 'KESTREL' })
    await expect.poll(child, { timeout: 15_000 }).toMatchObject({ status: 'completed', message: 'KESTREL', completedAt: '2026-11-22T03:14:03.510Z' })
    // agy marks no final answer, so a later answer from the same child, on a later pass, takes the earlier one's place.
    await f!.action(id, { type: 'subagent-answer', text: 'KESTREL, final', timestamp: '2026-11-22T03:15:00.000000000Z' })
    await expect.poll(child, { timeout: 15_000 }).toMatchObject({ status: 'completed', message: 'KESTREL, final', completedAt: '2026-11-22T03:15:00.000Z' })
    // A child whose row has left the thread's newest records is put back with its answer, never lost.
    await f!.action(id, { type: 'subagent', role: 'Third', prompt: 'Later.' })
    await expect.poll(async () => (await thread(id)).activities?.filter(row => row.kind === 'subagent').length).toBe(2)
    const live = (f!.host as unknown as { threads: Map<string, { activities?: unknown[] }> }).threads.get(id)!
    live.activities = (live.activities as { kind: string; agents?: { title?: string }[] }[]).filter(row => row.agents?.[0]?.title !== 'Third')
    await f!.action(id, { type: 'subagent-answer', text: 'LATE' })
    await expect.poll(async () => (await thread(id)).activities?.find(row => row.agents?.[0]?.title === 'Third')?.agents?.[0], { timeout: 15_000 })
      .toMatchObject({ status: 'completed', message: 'LATE' })
    // A second child whose record says it was killed is shown stopped.
    await f!.action(id, { type: 'subagent', role: 'Second', prompt: 'Wait.', model: 'gemini-3.8-flash' })
    const second = async () => (await thread(id)).activities?.find(row => row.agents?.[0]?.title === 'Second')?.agents?.[0]
    await expect.poll(second).toMatchObject({ status: 'running', title: 'Second', model: 'gemini-3.8-flash' })
    await f!.action(id, { type: 'subagent-killed' })
    await expect.poll(second, { timeout: 15_000 }).toMatchObject({ status: 'interrupted' })
  })

  it('leaves a child never heard from in all its watch as last seen working, not as live', async () => {
    const id = await open({ fixture: { childWatchMs: 1_500 } })
    await f!.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: 'm1', text: 'Go' })
    await f!.action(id, { type: 'subagent', role: 'Silent', prompt: 'Never answer.' })
    const child = async () => (await thread(id)).activities?.find(row => row.kind === 'subagent')?.agents?.[0]
    await expect.poll(child).toMatchObject({ status: 'running' })
    await expect.poll(child, { timeout: 15_000 }).toMatchObject({ status: 'unknown', title: 'Silent' })
  })

  it('lists agy’s commands as skills', async () => {
    const id = await open()
    await expect.poll(async () => (await f!.host.listThreadSkills!(id)).skills.map(skill => skill.invocation)).toEqual(['/plan', '/compact'])
  })

  it('keeps answering ordinary Full access execute permissions once across disconnect and resume, leaves always-only on a card, and leaves Auto asks to the user', async () => {
    const id = await open({ runtimeMode: 'full-access' })
    await f!.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: 'm1', text: 'Read fixture file' })
    await f!.action(id, { type: 'permission', text: 'cat ../outside-fixture.txt' })
    await expect.poll(answers).toEqual([{ outcome: 'selected', optionId: 'allow-once' }])
    expect((await thread(id)).requests).toEqual([])
    await f!.driver.completeTurn(id, 'Read it.')
    await expect.poll(async () => (await thread(id)).status).toBe('idle')

    // Reconnect and resume the session: Full access stays active and still answers once without a card.
    f!.host.disconnect(); await f!.host.closed()
    await f!.host.connect()
    f!.host.observeThreads?.([id])
    await f!.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: 'm2', text: 'Read again after resume' })
    await f!.action(id, { type: 'permission', text: 'cat ../outside-fixture.txt' })
    await expect.poll(answers).toEqual([{ outcome: 'selected', optionId: 'allow-once' }, { outcome: 'selected', optionId: 'allow-once' }])
    expect((await thread(id)).requests).toEqual([])

    // When agy offers only allow_always (no allow_once), Sotto never selects allow_always and leaves the card for the user.
    await f!.action(id, { type: 'permission-always-only', text: 'npm run risky' })
    await expect.poll(async () => (await thread(id)).requests.length).toBe(1)
    expect((await thread(id)).requests[0]!.kind).toBe('permission')
    expect((await answers()).some(item => (item as { optionId?: string } | undefined)?.optionId === 'remember-this')).toBe(false)
    await f!.host.execute({ type: 'answer', commandId: randomUUID(), threadId: id, requestId: (await thread(id)).requests[0]!.id, answer: '', approved: false })
    await expect.poll(answers).toEqual([
      { outcome: 'selected', optionId: 'allow-once' },
      { outcome: 'selected', optionId: 'allow-once' },
      { outcome: 'selected', optionId: 'reject-once' },
    ])

    // Auto mode leaves still-raised execute requests with the user.
    await f!.driver.completeTurn(id, 'Done.')
    await expect.poll(async () => (await thread(id)).status).toBe('idle')
    await f!.host.execute({ type: 'configure-thread', commandId: randomUUID(), threadId: id, runtimeMode: 'auto' })
    await f!.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: 'm3', text: 'Check auto ask' })
    await f!.action(id, { type: 'permission', text: 'cat ../outside-fixture.txt' })
    await expect.poll(async () => (await thread(id)).requests.length).toBe(1)
    expect((await thread(id)).requests[0]!.context?.command).toBe('cat ../outside-fixture.txt')
  })

  it('marks a turn failed when agy logs a new SQLite error step behind end_turn, then ignores it on the next clean turn', async () => {
    const id = await open()
    const sessionId = await f!.realId(id)
    const convDir = join(f!.root, 'antigravity', 'gemini', 'antigravity-acp', 'conversations')
    const dbFile = join(convDir, `${sessionId}.db`)
    const writeStep = (idx: number, type: number, payload: string) => {
      const db = new DatabaseSync(dbFile)
      try {
        db.exec('CREATE TABLE IF NOT EXISTS steps (idx INTEGER PRIMARY KEY, step_type INTEGER NOT NULL, step_payload BLOB)')
        db.prepare('INSERT OR REPLACE INTO steps (idx, step_type, step_payload) VALUES (?, ?, ?)').run(idx, type, Buffer.from(payload, 'utf8'))
      } finally { db.close() }
    }

    await f!.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: 'm1', text: 'First turn' })
    await mkdir(convDir, { recursive: true })
    writeStep(0, 17, 'Error 429, Message: upstream limit secret, reason:QUOTA_EXHAUSTED, Status: RESOURCE_EXHAUSTED')
    await f!.driver.completeTurn(id, 'Rate limited text from agent.')

    await expect.poll(async () => (await thread(id)).status).toBe('error')
    expect((await thread(id)).lastTurn).toEqual({ id: 'm1', status: 'failed' })
    expect((await thread(id)).messages.map(message => message.text)).toEqual(['First turn', 'Rate limited text from agent.'])
    expect((await thread(id)).activities?.find(row => row.kind === 'turn')).toMatchObject({
      turnId: 'm1', status: 'failed', error: 'Antigravity reached its usage limit for this period. Your thread is kept. Try again later.',
    })

    // The earlier step 0 sits in SQLite, yet a clean next turn settles as completed.
    await f!.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: 'm2', text: 'Retry' })
    writeStep(1, 15, 'Recovered reply')
    await f!.driver.completeTurn(id, 'Recovered.')
    await expect.poll(async () => (await thread(id)).status).toBe('idle')
    expect((await thread(id)).lastTurn).toEqual({ id: 'm2', status: 'completed' })
  })

  it('resumes watching a detached child across a Sotto restart, keeps newer answers, and settles killed or expired watches', async () => {
    const id = await open()
    const parent = await f!.realId(id)
    const appData = join(f!.root, 'antigravity', 'gemini', 'antigravity-acp')
    const aliasesFile = join(f!.root, 'antigravity-threads.json')
    const readWatches = async () => ((JSON.parse(await readFile(aliasesFile, 'utf8')) as Record<string, { childWatches?: { childConversation?: string; answeredAt?: string; until: number }[] }>)[id]?.childWatches ?? [])

    // 1. Running child before restart answers while the restarted host watches it (without storing prompt text).
    await f!.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: 'm1', text: 'Launch' })
    await f!.action(id, { type: 'subagent', role: 'Kestrel Responder', prompt: 'Reply with KESTREL.' })
    await expect.poll(async () => (await readWatches()).length).toBe(1)
    expect(await readFile(aliasesFile, 'utf8')).not.toContain('Reply with KESTREL.')
    const childFiles = await readdir(join(appData, 'brain', parent, '.system_generated', 'subagents'))
    const childId = childFiles[0]!.replace(/\.json$/u, '')

    f = await f!.driver.restart()
    await f!.host.connect()
    await mkdir(join(appData, 'brain', parent, '.system_generated', 'messages'), { recursive: true })
    await writeFile(join(appData, 'brain', parent, '.system_generated', 'messages', 'first.json'), JSON.stringify({
      id: 'first', recipient: parent, sender: childId, content: 'Working on it', timestamp: '2026-11-22T03:14:01.000Z',
    }))
    const subagent = async () => (await thread(id)).activities?.find(row => row.kind === 'subagent')?.agents?.[0]
    await expect.poll(subagent, { timeout: 15_000 }).toMatchObject({ status: 'completed', title: 'Kestrel Responder', message: 'Working on it' })
    await expect.poll(async () => (await readWatches())[0]?.answeredAt).toBe('2026-11-22T03:14:01.000Z')
    expect(await readFile(aliasesFile, 'utf8')).not.toContain('Working on it')

    // 2. Restart again with the interim answer already saved, then a newer answer arrives on disk.
    f = await f!.driver.restart()
    await f!.host.connect()
    await writeFile(join(appData, 'brain', parent, '.system_generated', 'messages', 'second.json'), JSON.stringify({
      id: 'second', recipient: parent, sender: childId, content: 'KESTREL, final', timestamp: '2026-11-22T03:15:00.000Z',
    }))
    await expect.poll(subagent, { timeout: 15_000 }).toMatchObject({ status: 'completed', title: 'Kestrel Responder', message: 'KESTREL, final' })

    // 3. Restart after an interrupt + kill on disk settles interrupted and drops the watch.
    await expect.poll(async () => (await thread(id)).status).toBe('idle')
    f!.host.observeThreads?.([id])
    await f!.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: 'm2', text: 'Second launch' })
    await f!.action(id, { type: 'subagent', role: 'Stopped Child', prompt: 'Wait forever.' })
    await expect.poll(async () => (await readWatches()).length).toBe(2)
    await f!.host.execute({ type: 'interrupt', threadId: id, commandId: randomUUID() })
    f!.host.disconnect(); await f!.host.closed()
    const allSubs = await readdir(join(appData, 'brain', parent, '.system_generated', 'subagents'))
    const secondChild = allSubs.map(name => name.replace(/\.json$/u, '')).find(candidate => candidate !== childId)!
    await writeFile(join(appData, 'brain', parent, '.system_generated', 'subagents', `${secondChild}.json`), JSON.stringify({ conversationId: secondChild, state: 'SUBAGENT_STATE_KILLED' }))
    f = await f!.driver.restart()
    await f!.host.connect()
    await expect.poll(async () => (await thread(id)).activities?.find(row => row.agents?.[0]?.title === 'Stopped Child')?.agents?.[0], { timeout: 15_000 })
      .toMatchObject({ status: 'interrupted' })
    await expect.poll(async () => (await readWatches()).some(item => item.answeredAt === undefined)).toBe(false)

    // 4. Restart after watch deadline expired while down: one with a waiting answer settles completed, one with none settles unknown.
    f!.host.observeThreads?.([id])
    await f!.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: 'm3', text: 'Expire test' })
    await f!.action(id, { type: 'subagent', role: 'Silent Expired', prompt: 'Never answers.' })
    await expect.poll(async () => (await readWatches()).filter(item => item.answeredAt === undefined).length).toBe(1)
    await f!.action(id, { type: 'subagent', role: 'Answered While Down', prompt: 'Answers offline.' })
    await expect.poll(async () => (await readWatches()).filter(item => item.answeredAt === undefined).length).toBe(2)
    f!.host.disconnect(); await f!.host.closed()

    const afterSubs = await readdir(join(appData, 'brain', parent, '.system_generated', 'subagents'))
    const newestIds = afterSubs.map(name => name.replace(/\.json$/u, '')).filter(candidate => candidate !== childId && candidate !== secondChild)
    expect(newestIds).toHaveLength(2)
    let answeredChild = ''
    for (const candidate of newestIds) {
      const inbox = await readdir(join(appData, 'brain', candidate, '.system_generated', 'messages'))
      const launchText = await readFile(join(appData, 'brain', candidate, '.system_generated', 'messages', inbox[0]!), 'utf8')
      if (launchText.includes('Answers offline.')) answeredChild = candidate
    }
    expect(answeredChild).not.toBe('')
    await writeFile(join(appData, 'brain', parent, '.system_generated', 'messages', 'offline-answer.json'), JSON.stringify({
      id: 'offline-answer', recipient: parent, sender: answeredChild, content: 'OFFLINE', timestamp: '2026-11-22T03:20:00.000Z',
    }))
    // Expire every watch's deadline while Sotto is stopped.
    const savedAliases = JSON.parse(await readFile(aliasesFile, 'utf8')) as Record<string, { childWatches: { until: number }[] }>
    for (const watch of savedAliases[id]!.childWatches) watch.until = Date.now() - 10_000
    await writeFile(aliasesFile, JSON.stringify(savedAliases, null, 2))

    f = await f!.driver.restart()
    await f!.host.connect()
    await expect.poll(async () => (await thread(id)).activities?.find(row => row.agents?.[0]?.title === 'Answered While Down')?.agents?.[0], { timeout: 15_000 })
      .toMatchObject({ status: 'completed', message: 'OFFLINE' })
    await expect.poll(async () => (await thread(id)).activities?.find(row => row.agents?.[0]?.title === 'Silent Expired')?.agents?.[0], { timeout: 15_000 })
      .toMatchObject({ status: 'unknown' })
    await expect.poll(async () => (await readWatches()).length).toBe(0)
  })

  it('bounds long child titles and models in saved watches and settles a running watch evicted past 64', async () => {
    const id = await open()
    const parent = await f!.realId(id)
    const appData = join(f!.root, 'antigravity', 'gemini', 'antigravity-acp')
    const aliasesFile = join(f!.root, 'antigravity-threads.json')
    const longRole = 'Role-' + 'R'.repeat(800)
    const longModel = 'gemini-model-' + 'M'.repeat(400)

    await f!.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: 'm1', text: 'Long watch' })
    await f!.action(id, { type: 'subagent', role: longRole, model: longModel, prompt: 'Keep going.' })
    await expect.poll(async () => {
      const watches = (JSON.parse(await readFile(aliasesFile, 'utf8')) as Record<string, { childWatches?: { agentTitle: string; model?: string }[] }>)[id]?.childWatches ?? []
      return watches.length
    }).toBe(1)
    const saved = (JSON.parse(await readFile(aliasesFile, 'utf8')) as Record<string, { childWatches: { agentTitle: string; model?: string }[] }>)[id]!.childWatches[0]!
    expect(saved.agentTitle.length).toBe(512)
    expect(saved.model?.length).toBe(256)

    // Restart loads the bounded watch cleanly without rejecting antigravity-threads.json, then delivers its answer.
    const childFiles = await readdir(join(appData, 'brain', parent, '.system_generated', 'subagents'))
    const childId = childFiles[0]!.replace(/\.json$/u, '')
    f = await f!.driver.restart()
    await f!.host.connect()
    await mkdir(join(appData, 'brain', parent, '.system_generated', 'messages'), { recursive: true })
    await writeFile(join(appData, 'brain', parent, '.system_generated', 'messages', 'long-answer.json'), JSON.stringify({
      id: 'long-answer', recipient: parent, sender: childId, content: 'LONG_OK', timestamp: '2026-11-22T03:30:00.000Z',
    }))
    await expect.poll(async () => (await thread(id)).activities?.find(row => row.kind === 'subagent')?.agents?.[0], { timeout: 15_000 })
      .toMatchObject({ status: 'completed', message: 'LONG_OK' })

    // Adding watches past 64 evicts the oldest running watch and settles it as unknown rather than leaving it running.
    type InternalHost = { watchChild(watch: { threadId: string; row: AgentActivity; toolCallId: string; parent: string; until: number; reading: { ruledOut: Set<string>; readAnswers: Set<string> } }): void }
    const internal = f!.host as unknown as InternalHost
    for (let index = 0; index < 65; index++) {
      const rowId = `antigravity-tool-m2-${index}`
      const row: AgentActivity = {
        id: rowId, turnId: 'm2', sequence: index, kind: 'subagent', status: 'completed', title: 'Run invoke_subagent', cwd: f!.root,
        agents: [{ id: `antigravity-child-${index}`, status: 'running', title: `Worker ${index}` }],
      }
      internal.watchChild({ threadId: id, row, toolCallId: `call_cap_${index}`, parent, until: Date.now() + 60_000, reading: { ruledOut: new Set(), readAnswers: new Set() } })
    }
    await expect.poll(async () => (JSON.parse(await readFile(aliasesFile, 'utf8')) as Record<string, { childWatches: { rowId: string }[] }>)[id]!.childWatches.at(-1)?.rowId).toBe('antigravity-tool-m2-64')
    const allWatches = (JSON.parse(await readFile(aliasesFile, 'utf8')) as Record<string, { childWatches: { rowId: string }[] }>)[id]!.childWatches
    expect(allWatches).toHaveLength(64)
    expect(allWatches.some(item => item.rowId === 'antigravity-tool-m1-0')).toBe(false)
    expect(allWatches.some(item => item.rowId === 'antigravity-tool-m2-0')).toBe(false)
    expect((await thread(id)).activities?.find(row => row.id === 'antigravity-tool-m2-0')?.agents?.[0]?.status).toBe('unknown')
  })
})
