// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CURSOR_ALLOW_EDITS_NOTICE } from '../../src/main/agents/cursor'
import { CURSOR_PLAN_TOOL } from '../../src/main/agents/cursorRequests'
import { describeAdapterContract } from './adapterContract'
import { cursorFixture, cursorFixtureSkips } from '../fixtures/fakeCursorFixture'

describeAdapterContract('Cursor ACP', session => cursorFixture(undefined, undefined, session), cursorFixtureSkips)

describe('Cursor ACP adapter', () => {
  let f: Awaited<ReturnType<typeof cursorFixture>> | undefined
  afterEach(async () => { const previous = f; f = undefined; await previous?.cleanup() })
  const open = async (title = 'Cursor thread', options: { runtimeMode?: 'approval-required' | 'auto' | 'full-access' | 'auto-accept-edits'; modelId?: string } = {}) => {
    f = await cursorFixture()
    await f.host.connect()
    await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Project', path: f.root })
    const id = randomUUID()
    await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f.projectId, modelId: options.modelId ?? f.modelId, title, ...(options.runtimeMode ? { runtimeMode: options.runtimeMode } : {}) })
    f.host.observeThreads?.([id])
    return id
  }
  const thread = async (id: string) => (await f!.host.snapshot()).threads.find(item => item.id === id)!
  const processes = async () => (await f!.requests()).filter(record => record.method === 'fixture/process').map(record => record.params as { args: string[]; environment: Record<string, string | undefined>; version: string })

  it('lists one model per entry, grouped by maker, with each model’s effort in Sotto’s order', async () => {
    f = await cursorFixture()
    const snapshot = await f.host.connect()
    expect(snapshot.models.map(model => [model.id, model.provider, model.source])).toEqual([['default', 'Cursor', 'Cursor'], ['claude-fixture', 'Cursor', 'Anthropic'], ['gpt-fixture', 'Cursor', 'OpenAI']])
    expect(snapshot.models.find(model => model.id === 'gpt-fixture')).toMatchObject({ reasoningEfforts: ['none', 'low', 'medium', 'high'], defaultReasoningEffort: 'medium', supportsImages: true,
      runtimeModes: ['approval-required', 'auto', 'full-access'] })
    // Claude's on/off thinking is not an effort; its effort option is.
    expect(snapshot.models.find(model => model.id === 'claude-fixture')).toMatchObject({ reasoningEfforts: ['low', 'medium', 'high', 'max'], defaultReasoningEffort: 'high' })
    expect(snapshot.models.find(model => model.id === 'default')?.reasoningEfforts).toEqual([])
    expect(snapshot.version).toBe('2026.10.22-27dcf5f / ACP 1')
    expect(snapshot.capabilities).toMatchObject({ steer: false, compact: false, configureThreadModel: true, skills: true })
  })

  it('runs every process with Sotto’s Cursor folder and no keys, and writes Sotto’s rules there first', async () => {
    const id = await open()
    expect(await f!.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: 'm1', text: 'Hello' })).toEqual({ accepted: true })
    const started = await processes()
    expect(started.length).toBeGreaterThan(0)
    for (const process of started) {
      expect(process.environment).toMatchObject({ CURSOR_CONFIG_DIR: join(f!.root, 'cursor-config'), NO_OPEN_BROWSER: '1', CURSOR_INVOKED_AS: 'agent' })
      expect(process.environment.CURSOR_API_KEY).toBeUndefined(); expect(process.environment.CURSOR_AUTH_TOKEN).toBeUndefined(); expect(process.environment.OPENAI_API_KEY).toBeUndefined()
    }
    const config = JSON.parse(await readFile(join(f!.root, 'cursor-config', 'cli-config.json'), 'utf8')) as Record<string, unknown>
    expect(config).toMatchObject({ version: 1, editor: { vimMode: false }, approvalMode: 'allowlist', permissions: { deny: [] } })
  })

  it('sets the model and effort before the prompt and reads them back', async () => {
    const id = await open()
    await f!.host.execute({ type: 'configure-thread', commandId: randomUUID(), threadId: id, reasoningEffort: 'high' })
    expect(await f!.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: 'm1', text: 'Hello' })).toEqual({ accepted: true })
    const settings = (await f!.requests()).filter(record => record.method === 'session/set_config_option').map(record => [record.params?.configId, record.params?.value])
    // The model comes on its default effort, medium, so only the change to high is sent.
    expect(settings).toEqual([['model', 'gpt-fixture'], ['reasoning', 'high']])
    expect(await thread(id)).toMatchObject({ modelId: 'gpt-fixture', reasoningEffort: 'high' })
  })

  it('starts each permission mode as Cursor’s own approval mode, and a new mode on a fresh process', async () => {
    const id = await open('Modes', { runtimeMode: 'full-access' })
    expect((await processes()).at(-1)?.args).toEqual(['--force', 'acp'])
    const result = await f!.host.execute({ type: 'configure-thread', commandId: randomUUID(), threadId: id, runtimeMode: 'auto' })
    expect(result.snapshot?.threads.find(item => item.id === id)?.runtimeMode).toBe('auto')
    await expect.poll(async () => (await processes()).at(-1)?.args).toEqual(['--auto-review', 'acp'])
    await f!.host.execute({ type: 'configure-thread', commandId: randomUUID(), threadId: id, runtimeMode: 'approval-required' })
    await expect.poll(async () => (await processes()).at(-1)?.args).toEqual(['acp'])
  })

  it('starts a thread that came with Allow edits as Ask for approval, and says so once', async () => {
    const id = await open('Allow edits', { runtimeMode: 'auto-accept-edits' })
    expect(await thread(id)).toMatchObject({ runtimeMode: 'approval-required', requestNotice: CURSOR_ALLOW_EDITS_NOTICE })
    expect((await processes()).at(-1)?.args).toEqual(['acp'])
    await f!.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: 'm1', text: 'Hello' })
    expect((await thread(id)).requestNotice).toBeUndefined()
  })

  it('offers a permission as allow once or reject, never allow always', async () => {
    const id = await open()
    await f!.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: 'm1', text: 'Run it' })
    await f!.action(id, { type: 'permission', text: 'git status' })
    await expect.poll(async () => (await thread(id)).requests.length).toBe(1)
    const request = (await thread(id)).requests[0]!
    expect(request.permissionChoices?.map(choice => [choice.id, choice.kind])).toEqual([['allow-once', 'allow-once'], ['reject-once', 'deny']])
    expect(request.context).toMatchObject({ command: 'git status', details: 'Not in allowlist: git status' })
    await expect(f!.host.execute({ type: 'answer', threadId: id, commandId: randomUUID(), requestId: request.id, answer: '', approved: true, permissionChoice: 'allow-always' })).rejects.toThrow('not offered')
    await f!.host.execute({ type: 'answer', threadId: id, commandId: randomUUID(), requestId: request.id, answer: '', approved: true })
    await expect.poll(async () => (await f!.requests()).some(record => (record.result?.outcome as { optionId?: string } | undefined)?.optionId === 'allow-once')).toBe(true)
  })

  it('shows Cursor’s plan as a plan request, and answers accepted or rejected', async () => {
    const id = await open()
    await f!.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: 'm1', text: 'Plan it' })
    await f!.action(id, { type: 'plan', text: 'Add a contributing guide.' })
    await expect.poll(async () => (await thread(id)).requests.length).toBe(1)
    const request = (await thread(id)).requests[0]!
    expect(request).toMatchObject({ kind: 'permission', context: { toolName: CURSOR_PLAN_TOOL } })
    expect(request.text).toContain('Add a contributing guide.')
    expect(request.permissionChoices?.map(choice => choice.label)).toEqual(['Accept plan', 'Reject'])
    await f!.host.execute({ type: 'answer', threadId: id, commandId: randomUUID(), requestId: request.id, answer: 'Reject', approved: false, permissionChoice: 'reject-plan' })
    await expect.poll(async () => (await f!.requests()).some(record => (record.result?.outcome as { outcome?: string } | undefined)?.outcome === 'rejected')).toBe(true)
  })

  it('skips a question the user answers with nothing, and refuses an answer Cursor did not offer', async () => {
    const id = await open()
    await f!.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: 'm1', text: 'Ask me' })
    await f!.action(id, { type: 'question', text: 'Which color?' })
    await expect.poll(async () => (await thread(id)).requests.length).toBe(1)
    const request = (await thread(id)).requests[0]!
    expect(request.questions?.[0]).toMatchObject({ id: 'color', allowFreeText: false, options: [{ id: 'Blue', label: 'Blue' }, { id: 'Red', label: 'Red' }] })
    await expect(f!.host.execute({ type: 'answer', threadId: id, commandId: randomUUID(), requestId: request.id, answer: 'Green' })).rejects.toThrow('its own options')
    await f!.host.execute({ type: 'answer', threadId: id, commandId: randomUUID(), requestId: request.id, answer: '', questionAnswers: { color: { optionIds: [] } } })
    await expect.poll(async () => (await f!.requests()).some(record => (record.result?.outcome as { outcome?: string } | undefined)?.outcome === 'skipped')).toBe(true)
  })

  it('keeps a tool’s row and the reply’s place across a restart, with Cursor’s replayed IDs', async () => {
    const id = await open()
    await f!.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: 'm1', text: 'Run git status' })
    await f!.action(id, { type: 'tool', command: 'git status', output: 'clean' })
    await expect.poll(async () => (await thread(id)).activities?.some(row => row.kind === 'command')).toBe(true)
    await f!.driver.completeTurn(id, 'All clean.')
    await expect.poll(async () => (await thread(id)).status).toBe('idle')
    const before = await thread(id)
    f = await f!.driver.restart(); f.host.observeThreads?.([id]); await f.host.connect()
    const after = await thread(id)
    expect(after.messages.map(message => [message.id, message.text])).toEqual(before.messages.map(message => [message.id, message.text]))
    const commands = (rows: typeof before.activities) => rows?.filter(row => row.kind === 'command').map(row => [row.id, row.command, row.status, row.output])
    expect(commands(after.activities)).toEqual(commands(before.activities))
  })

  it('lists Cursor’s skills as slash commands', async () => {
    const id = await open()
    const catalog = await f!.host.listThreadSkills!(id)
    expect(catalog.status).toBe('ready')
    expect(catalog.skills.map(skill => [skill.name, skill.invocation, skill.scope])).toEqual([['review', '/review', 'user'], ['fixture-skill', '/fixture-skill', 'system']])
  })

  it('writes short text in ask mode on the thread’s model at its least effort', async () => {
    const id = await open()
    await f!.sideWriting.answer('Short title')
    await expect(f!.host.writeShortText!(id, { instruction: 'Name it.', material: 'Marker' })).resolves.toBe('Short title')
    expect(await f!.sideWriting.calls()).toEqual([{ cwd: expect.any(String), model: 'gpt-fixture', effort: 'none', mode: 'ask', material: 'Name it.\n\nMarker' }])
  })

  it('reads a signed-out Cursor as signed out', async () => {
    f = await cursorFixture()
    await f.script({ signedOut: true })
    await expect(f.host.connect()).rejects.toMatchObject({ problem: 'signed-out' })
  })

  it('refuses a client older than the floor with the version it reported', async () => {
    f = await cursorFixture()
    await f.script({ cliVersion: '2026.10.21-0123abc' })
    await expect(f.host.connect()).rejects.toMatchObject({ problem: 'too-old', version: '2026.10.21-0123abc', requiredVersion: '2026.10.22-27dcf5f' })
  })

  it('refuses Watcher on Cursor before Cursor hears anything', async () => {
    const id = await open()
    const revoked: string[] = []
    f!.host.useLaunchProfiles!({ profileFor: async () => ({ kind: 'watcher', revoke: (reason: string) => { revoked.push(reason) } }) as never })
    await expect(f!.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: 'm1', text: 'Hello' })).rejects.toThrow('Watcher does not run on Cursor')
    expect(revoked).toHaveLength(1)
    expect((await f!.requests()).some(record => record.method === 'session/prompt')).toBe(false)
  })
})
