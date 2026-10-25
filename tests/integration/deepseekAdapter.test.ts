// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { describeAdapterContract } from './adapterContract'
import { deepseekFixture, deepseekFixtureSkips, FIXTURE_SERVER } from '../fixtures/fakeDeepSeekFixture'

describeAdapterContract('DeepSeek Harness ACP', session => deepseekFixture(undefined, undefined, session), deepseekFixtureSkips)

describe('DeepSeek Harness ACP adapter', () => {
  let f: Awaited<ReturnType<typeof deepseekFixture>> | undefined
  afterEach(async () => { const previous = f; f = undefined; await previous?.cleanup() })
  const open = async (title = 'DeepSeek thread', options: { runtimeMode?: 'approval-required' | 'auto-accept-edits' | 'full-access'; modelId?: string } = {}) => {
    f = await deepseekFixture()
    await f.host.connect()
    await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Project', path: f.root })
    const id = randomUUID()
    await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f.projectId, modelId: options.modelId ?? f.modelId, title, ...(options.runtimeMode ? { runtimeMode: options.runtimeMode } : {}) })
    f.host.observeThreads?.([id])
    return id
  }
  const thread = async (id: string) => (await f!.host.snapshot()).threads.find(item => item.id === id)!
  const processes = async () => (await f!.requests()).filter(record => record.method === 'fixture/process').map(record => record.params as { args: string[]; environment: Record<string, string | string[] | undefined>; version: string })

  it('lists the keyless servers’ models, grouped by server, with efforts and the three modes', async () => {
    f = await deepseekFixture()
    const snapshot = await f.host.connect()
    expect(snapshot.name).toBe('DeepSeek Harness')
    expect(snapshot.version).toContain('0.2.1-rc.2')
    expect(snapshot.models.map(model => [model.id, model.name, model.source, model.provider])).toEqual([
      ['own-fixture/fixture-model', 'Fixture Model', 'Fixture Server', 'DeepSeek Harness'],
      ['own-fixture/fixture-plain', 'Fixture Plain', 'Fixture Server', 'DeepSeek Harness'],
    ])
    const [thinking, plain] = snapshot.models
    expect(thinking!.reasoningEfforts).toEqual(['off', 'low', 'high', 'max'])
    expect(thinking!.defaultReasoningEffort).toBe('high')
    expect(plain!.reasoningEfforts).toBeUndefined()
    expect(thinking!.runtimeModes).toEqual(['approval-required', 'auto-accept-edits', 'full-access'])
    expect(thinking!.supportsImages).toBeUndefined()
  })

  it('refuses to connect with no keyless server saved, and with only a keyed one', async () => {
    f = await deepseekFixture(undefined, undefined, {}, {}, [])
    await expect(f.host.connect()).rejects.toThrow(/none it can run is saved yet/)
    const keyed = await deepseekFixture(undefined, undefined, {}, {}, [{ ...FIXTURE_SERVER, keyed: true }])
    try {
      await expect(keyed.host.connect()).rejects.toThrow(/none it can run is saved yet/)
    } finally { await keyed.cleanup() }
  })

  it('refuses a client older than the floor, read from its own --version', async () => {
    f = await deepseekFixture()
    await f.script({ cliVersion: '0.1.0' })
    await expect(f.host.connect()).rejects.toThrow(/0\.2\.1-rc\.2 or newer is needed, and this one is 0\.1\.0/)
  })

  it('starts its process in Sotto’s harness folder and sandbox, with the generated overlay and no provider key', async () => {
    const id = await open()
    const [processRecord] = await processes()
    expect(processRecord!.args).toEqual(expect.arrayContaining(['--profile', 'acp', '--patch']))
    expect(processRecord!.environment.DSH_HOME).toBe(join(f!.root, 'deepseek-home'))
    // The created thread starts on Allow edits, the workspace-write sandbox.
    expect(processRecord!.environment.DSH_PERMISSION_MODE).toBe('workspace-write')
    expect(processRecord!.environment.DEEPSEEK_API_KEY).toBeUndefined()
    expect(processRecord!.environment.OPENAI_API_KEY).toBeUndefined()
    expect(processRecord!.environment.ownKeys).toEqual(['SOTTO_OWN_OWN_FIXTURE_KEY'])
    const patch = await readFile(join(f!.root, 'deepseek-home', 'sotto-acp.patch.yml'), 'utf8')
    expect(patch).toContain('"own-fixture"')
    expect(patch).toContain('baseURL: "http://127.0.0.1:9/v1"')
    expect(patch).toContain('apiKeyEnv: "SOTTO_OWN_OWN_FIXTURE_KEY"')
    expect(patch).toContain('- id: llm-deepseek\n  disabled: true')
    expect(patch).not.toContain('sotto-no-key')
    const prompt = (await f!.requests()).find(record => record.method === 'session/new')
    expect(prompt).toBeDefined()
    expect((await thread(id)).status).toBe('idle')
  })

  it('builds an escalation card from the tool call before it: command, boundary and the model’s reason', async () => {
    const id = await open('Escalation thread', { runtimeMode: 'approval-required' })
    expect((await processes())[0]!.environment.DSH_PERMISSION_MODE).toBe('read-only')
    await f!.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: 'ask', text: 'Write the file' })
    await f!.driver.raisePermission(id, 'echo hi > out.txt')
    await expect.poll(async () => (await thread(id)).requests.length).toBe(1)
    const request = (await thread(id)).requests[0]!
    expect(request.kind).toBe('permission')
    expect(request.text).toContain('echo hi > out.txt')
    expect(request.text).toContain('workspace-write')
    expect(request.text).toContain('The model’s reason: The fixture asks to cross.')
    expect(request.context?.command).toBe('echo hi > out.txt')
    expect(request.permissionChoices?.map(choice => choice.id)).toEqual(['allow-once', 'reject-once'])
  })

  it('changes permission mode on a fresh process in the new sandbox, resuming the same session', async () => {
    const id = await open()
    const native = await f!.realId(id)
    const before = (await processes()).length
    const result = await f!.host.execute({ type: 'configure-thread', commandId: randomUUID(), threadId: id, runtimeMode: 'full-access' })
    expect(result.accepted).toBe(true)
    await expect.poll(async () => (await processes()).length).toBe(before + 1)
    expect((await processes()).at(-1)!.environment.DSH_PERMISSION_MODE).toBe('danger-full-access')
    const resumes = (await f!.requests()).filter(record => record.method === 'session/resume' && record.params?.sessionId === native)
    expect(resumes.length).toBeGreaterThan(0)
    expect((await thread(id)).runtimeMode).toBe('full-access')
  })

  it('sets model and effort on the running session in place', async () => {
    const id = await open()
    await f!.host.execute({ type: 'configure-thread', commandId: randomUUID(), threadId: id, reasoningEffort: 'low' })
    const sets = (await f!.requests()).filter(record => record.method === 'session/set_config_option')
    expect(sets.some(record => record.params?.configId === 'reasoning_effort' && record.params?.value === 'low')).toBe(true)
    expect((await thread(id)).reasoningEffort).toBe('low')
  })

  it('reads context fullness from usage updates, and no token counts', async () => {
    const id = await open()
    await f!.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: 'm', text: 'Synthetic prompt' })
    await f!.driver.completeTurn(id, 'Done')
    await expect.poll(async () => (await thread(id)).status).toBe('idle')
    const usage = (await thread(id)).usage
    expect(usage?.contextUsed).toBe(6200)
    expect(usage?.contextWindow).toBe(131072)
    expect(usage?.latest).toBeUndefined()
  })

  it('rebuilds its catalog when the record changes', async () => {
    f = await deepseekFixture()
    await f.host.connect()
    f.setServers([{ ...FIXTURE_SERVER, models: [...FIXTURE_SERVER.models, { id: 'fixture-third', name: 'Fixture Third', context: 32768, thinking: false, images: false }] }])
    await expect.poll(async () => (await f!.host.snapshot()).models.map(model => model.id)).toContain('own-fixture/fixture-third')
  })
})
