// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
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
    const prompts = (await f!.requests()).filter(record => record.method === 'session/prompt')
    expect(prompts).toHaveLength(2)
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

  it('hands Sotto’s tools to agy, which advertises no MCP capability yet takes HTTP servers, and none when agy says it cannot', async () => {
    const tools = [{ name: 'sotto_probe', definitions: [], mcpServer: async () => ({ name: 'sotto_probe', type: 'http' as const, url: 'http://127.0.0.1:9/mcp', headers: [] }) }]
    const servers = async () => (await f!.requests()).filter(record => record.method === 'session/new' && record.params?.cwd === f!.root).map(record => (record.params?.mcpServers as { name: string }[]).map(server => server.name))
    for (const httpMcp of [undefined, false]) {
      await f?.cleanup()
      f = await antigravityFixture()
      if (httpMcp === false) await f.script({ httpMcp })
      f.host.useThreadTools(tools)
      await f.host.connect()
      await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Project', path: f.root })
      const id = randomUUID()
      await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f.projectId, modelId: f.modelId, title: 'Tools' })
      f.host.observeThreads?.([id])
      await f.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: 'm1', text: 'Go' })
      await expect.poll(servers).toEqual([httpMcp === false ? [] : ['sotto_probe']])
    }
  })

  it('lists agy’s commands as skills', async () => {
    const id = await open()
    await expect.poll(async () => (await f!.host.listThreadSkills!(id)).skills.map(skill => skill.invocation)).toEqual(['/plan'])
  })
})
