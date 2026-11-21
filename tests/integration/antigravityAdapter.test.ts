// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
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

  it('reads the account’s models, each with its own thinking levels, grouped by maker', async () => {
    f = await antigravityFixture()
    const snapshot = await f.host.connect()
    expect(snapshot.models.map(model => [model.id, model.source, model.reasoningEfforts])).toEqual([
      ['gemini-3.8-flash', 'Google', ['low', 'medium', 'high']],
      ['gemini-4-carbon', 'Google', ['low', 'high']],
      ['claude-sonnet-5-5', 'Anthropic', []],
    ])
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

  it('steers a running turn with a second prompt in the same session, as T3 does on 1.5', async () => {
    const id = await open()
    await f!.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: 'm1', text: 'Write the report' })
    await expect.poll(async () => (await thread(id)).status).toBe('running')
    expect(await f!.host.execute({ type: 'steer', threadId: id, commandId: randomUUID(), messageId: 'm2', text: 'Make it shorter' })).toEqual({ accepted: true })
    const prompts = (await f!.requests()).filter(record => record.method === 'session/prompt')
    expect(prompts).toHaveLength(2)
    expect((await thread(id)).status).toBe('running')
    await f!.driver.completeTurn(id, 'Short report')
    await expect.poll(async () => (await thread(id)).status).toBe('idle')
    expect((await thread(id)).messages.map(message => [message.role, message.text])).toEqual([['user', 'Write the report'], ['user', 'Make it shorter'], ['assistant', 'Short report']])
  })

  it('shows a command with agy’s own fields', async () => {
    const id = await open()
    await f!.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: 'm1', text: 'List files' })
    await f!.action(id, { type: 'tool', command: 'ls -la', output: 'README.md' })
    await expect.poll(async () => (await thread(id)).activities?.find(row => row.kind === 'command')).toMatchObject({ command: 'ls -la', output: 'README.md', exitCode: 0, status: 'completed' })
  })

  it('lists agy’s commands as skills', async () => {
    const id = await open()
    await expect.poll(async () => (await f!.host.listThreadSkills!(id)).skills.map(skill => skill.invocation)).toEqual(['/plan'])
  })
})
