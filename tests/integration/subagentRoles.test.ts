// @vitest-environment node
// #1042 over the fake providers: each thread's own sub-agents follow the worker roles. Claude Code gets one agent per
// role at `initialize`, Codex gets Sotto's role files in `thread/start`, `thread/resume` and `thread/fork`, Grok Build gets the table in
// its rules, and each thread's instructions name the agent, the model or the delegation for every kind of work.
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodexRoleFiles, WorkerRoles } from '../../src/main/agents/subagentRoles'
import { questionInstructions } from '../../src/main/agents/questionInstructions'
import type { ScopedThreadTools } from '../../src/main/agents/threadToolServer'
import { DevinAcpHost } from '../../src/main/agents/devin'
import { MuseMspHost } from '../../src/main/agents/muse'
import type { AgentRuntimeMode, ProviderId } from '../../src/shared/agents'
import type { SubagentRole, WorkerKind } from '../../src/shared/workerRoles'
import type { RecordedRpc } from '../fixtures/adapterFixture'
import { claudeFixture } from '../fixtures/claudeFixture'
import { codexFixture } from '../fixtures/codexFixture'
import { grokFixture } from '../fixtures/fakeGrokThreadFixture'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const flag = (args: string[], name: string) => args[args.indexOf(name) + 1]
const NAMES: Record<WorkerKind, string> = { building: 'Building', ui: 'UI', 'code-review': 'Code review', research: 'Research', 'computer-use': 'Computer use' }
function role(kind: WorkerKind, provider: ProviderId, model: string, reasoningEffort: string | null, runtimeMode: AgentRuntimeMode | undefined): SubagentRole {
  return { kind, name: NAMES[kind], what: 'Synthetic work.', provider, model, modelName: `Synthetic ${model}`, reasoningEffort, speed: null, runtimeMode }
}
/** `sotto_delegate` as main offers it to a thread that may delegate: a second-level delegated thread is offered none. */
function delegateTool(offered = true): ScopedThreadTools {
  return { name: 'sotto_delegate', definitions: [{ name: 'delegate', description: 'Synthetic', inputSchema: {} }],
    mcpServer: async () => offered ? { name: 'sotto_delegate', type: 'http', url: 'http://127.0.0.1:12345/mcp', headers: [] } : undefined }
}

describe('Claude Code threads', () => {
  const TABLE = [role('building', 'claude', 'fixture-model', 'high', 'full-access'), role('research', 'claude', 'fixture-second-model', null, 'approval-required'),
    role('code-review', 'codex', 'gpt-synthetic', 'xhigh', 'approval-required')]
  async function claude(roles: readonly SubagentRole[] | undefined, delegate = true) {
    const f = await claudeFixture(undefined, 10_000); cleanups.push(f.cleanup)
    await writeFile(join(f.root, 'models.json'), JSON.stringify(['fixture-model', 'fixture-second-model'].map(value => ({ value, displayName: value, supportsEffort: true, supportedEffortLevels: ['low', 'high'] }))))
    const source = roles ? new WorkerRoles(vi.fn(() => roles)) : undefined
    if (source) f.adapter.useWorkerRoles(source)
    f.adapter.useThreadTools([delegateTool(delegate)])
    await f.host.connect()
    await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Synthetic', path: f.root })
    const id = randomUUID()
    await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f.projectId, title: 'Synthetic', modelId: f.modelId, runtimeMode: 'auto-accept-edits' })
    await f.host.execute({ type: 'send', commandId: randomUUID(), threadId: id, messageId: randomUUID(), text: 'Synthetic first turn' })
    await f.driver.completeTurn(id, 'Synthetic complete')
    await expect.poll(async () => (await f.host.snapshot()).threads.find(thread => thread.id === id)?.status).toBe('idle')
    const launches = async () => (await f.driver.requests()).filter(record => ['launch', 'resume'].includes(record.method ?? '') && !(record.params!.frame as { args: string[] }).args.includes('--no-session-persistence'))
    const initializes = async () => (await f.driver.requests()).filter(record => record.method === 'initialize')
      .map(record => (record.params!.frame as { request: { agents?: Record<string, Record<string, unknown>> } }).request)
    return { f, id, source, launches, initializes }
  }

  it('gives one agent per role on Claude at launch, each held to the thread\'s permission, and names them in its instructions', async () => {
    const { launches, initializes } = await claude(TABLE)
    // The first initialize may be the catalog probe's, which is no thread's launch.
    const initialize = (await initializes()).find(request => request.agents)
    expect(initialize!.agents).toEqual({
      sotto_building: expect.objectContaining({ model: 'fixture-model', effort: 'high', permissionMode: 'acceptEdits' }),
      sotto_research: expect.objectContaining({ model: 'fixture-second-model', permissionMode: 'default' }),
    })
    expect(initialize!.agents!.sotto_research).not.toHaveProperty('effort')
    const prompt = flag((((await launches())[0]!.params!.frame) as { args: string[] }).args, '--append-system-prompt')!
    expect(prompt.startsWith(`${questionInstructions('AskUserQuestion', false)}\n\n`)).toBe(true)
    expect(prompt).toContain('- Building (synthetic work): use the Agent tool with subagent_type "sotto_building" (Synthetic fixture-model at high effort).')
    expect(prompt).toContain('- Research (synthetic work): use the Agent tool with subagent_type "sotto_research" (Synthetic fixture-second-model).')
    expect(prompt).toContain('- Code review (synthetic work): Synthetic gpt-synthetic at xhigh effort on Codex, another provider: call delegate with work "code-review".')
  })

  it('starts the CLI again when the thread narrows below what its agents were given', async () => {
    const { f, id, launches, initializes } = await claude(TABLE)
    const before = (await launches()).length
    expect((await f.host.execute({ type: 'configure-thread', commandId: randomUUID(), threadId: id, runtimeMode: 'approval-required' })).accepted).toBe(true)
    await expect.poll(async () => (await launches()).length).toBeGreaterThan(before)
    expect((await initializes()).at(-1)!.agents!.sotto_building).toMatchObject({ permissionMode: 'default' })
    // Widening takes no restart: agents launched narrower stay within the thread's permission.
    const narrowed = (await launches()).length
    expect((await f.host.execute({ type: 'configure-thread', commandId: randomUUID(), threadId: id, runtimeMode: 'auto' })).accepted).toBe(true)
    expect((await launches()).length).toBe(narrowed)
  })

  it('tells a thread that cannot delegate to do another provider\'s work itself', async () => {
    const { launches } = await claude(TABLE, false)
    const prompt = flag((((await launches())[0]!.params!.frame) as { args: string[] }).args, '--append-system-prompt')!
    expect(prompt).toContain('- Code review (synthetic work): Synthetic gpt-synthetic at xhigh effort on Codex, which this thread cannot start: do that work yourself.')
    expect(prompt).not.toContain('call delegate')
  })

  it('sends none of it while worker roles are off', async () => {
    const { launches, initializes } = await claude(undefined)
    expect((await initializes()).length).toBeGreaterThan(0)
    for (const request of await initializes()) expect(request).not.toHaveProperty('agents')
    expect(flag((((await launches())[0]!.params!.frame) as { args: string[] }).args, '--append-system-prompt')).toBe(questionInstructions('AskUserQuestion', false))
  })
})

describe('Codex threads', () => {
  const TABLE = [role('computer-use', 'codex', 'fixture-model', 'high', 'full-access'), role('code-review', 'codex', 'fixture-second-model', 'low', 'approval-required'),
    role('research', 'codex', 'retired-model', 'low', 'approval-required'), role('building', 'claude', 'opus', 'xhigh', 'auto-accept-edits')]
  async function codex(roles: readonly SubagentRole[] | undefined, runtimeMode: AgentRuntimeMode = 'auto', options: { version?: string; requestTimeoutMs?: number } = {}) {
    const log = vi.fn()
    const f = await codexFixture(undefined, false, options.requestTimeoutMs ?? 10_000, { logEvent: log }); cleanups.push(f.cleanup)
    await f.script({ version: options.version ?? 'codex/0.162.1', developerInstructions: 'Synthetic project developer instructions',
      models: ['fixture-model', 'fixture-second-model'].map(model => ({ id: model, model, displayName: model, isDefault: model === 'fixture-model', defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] })) })
    let table = roles
    const source = roles ? new WorkerRoles(() => table!) : undefined
    if (source) f.adapter.useWorkerRoles(source)
    f.adapter.useThreadTools([delegateTool()])
    await f.host.connect()
    await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Synthetic', path: f.root })
    const id = randomUUID()
    await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f.projectId, title: 'Synthetic', modelId: f.modelId, runtimeMode })
    const loads = async (method?: string): Promise<RecordedRpc[]> => (await f.driver.requests()).filter(record => method ? record.method === method : ['thread/start', 'thread/resume'].includes(record.method ?? ''))
    const agents = (record: RecordedRpc) => (record.params!.config as { agents?: Record<string, { description: string; config_file: string }> }).agents
    return { f, id, log, source, loads, agents, setTable: (next: readonly SubagentRole[]) => { table = next } }
  }

  it('passes Sotto\'s role files for the roles on a ready Codex model when a thread starts, and names them in its instructions', async () => {
    const { f, loads, agents, log } = await codex(TABLE)
    const [start] = await loads('thread/start')
    expect(Object.keys(agents(start!)!)).toEqual(['sotto_computer_use', 'sotto_code_review'])
    expect(agents(start!)!.sotto_computer_use!.config_file).toBe(join(f.root, 'codex-roles', 'auto', 'sotto_computer_use.toml'))
    const computerUse = await readFile(agents(start!)!.sotto_computer_use!.config_file, 'utf8')
    // Computer use wants full access; the thread is on Auto, so its sub-agent gets no more.
    expect(computerUse).toContain('model = "fixture-model"\nmodel_reasoning_effort = "high"\nsandbox_mode = "workspace-write"\napproval_policy = "on-request"\napprovals_reviewer = "auto_review"')
    expect(computerUse).not.toContain('Synthetic first')
    const instructions = start!.params!.developerInstructions as string
    expect(instructions.startsWith('Synthetic project developer instructions')).toBe(true)
    expect(instructions).toContain('- Computer use (synthetic work): call spawn_agent with agent_type "sotto_computer_use" (Synthetic fixture-model at high effort).')
    expect(instructions).toContain('- Code review (synthetic work): call spawn_agent with agent_type "sotto_code_review" (Synthetic fixture-second-model at low effort).')
    expect(instructions).toContain('- Building (synthetic work): Synthetic opus at xhigh effort on Claude Code, another provider: call delegate with work "building".')
    // A model Codex does not list as ready gets no role file; the thread is told the model to ask for instead.
    expect(instructions).toContain('- Research (synthetic work): call spawn_agent with model "retired-model" and reasoning_effort "low".')
    expect(log).not.toHaveBeenCalled()
  })

  it('passes them again on a fresh load, held to a narrowed permission, and rewrites them when Settings change', async () => {
    const { f, id, loads, agents, source, setTable } = await codex(TABLE, 'full-access')
    const [start] = await loads('thread/start')
    expect(agents(start!)!.sotto_computer_use!.config_file).toBe(join(f.root, 'codex-roles', 'full-access', 'sotto_computer_use.toml'))
    expect(await readFile(agents(start!)!.sotto_computer_use!.config_file, 'utf8')).toContain('sandbox_mode = "danger-full-access"')
    // Narrowing below what the role files were loaded with lets the thread's app-server go, so the next send loads it again.
    expect((await f.host.execute({ type: 'configure-thread', commandId: randomUUID(), threadId: id, runtimeMode: 'approval-required' })).accepted).toBe(true)
    await f.host.execute({ type: 'send', commandId: randomUUID(), threadId: id, messageId: randomUUID(), text: 'Synthetic narrowed turn' })
    const resumed = (await loads('thread/resume')).at(-1)!
    expect(agents(resumed)!.sotto_computer_use!.config_file).toBe(join(f.root, 'codex-roles', 'approval-required', 'sotto_computer_use.toml'))
    expect(await readFile(agents(resumed)!.sotto_computer_use!.config_file, 'utf8')).toContain('sandbox_mode = "read-only"\napproval_policy = "untrusted"')
    expect(resumed.params!.developerInstructions).toContain('agent_type "sotto_computer_use"')
    // A Settings change writes every folder in use again, for each thread's next load.
    setTable(TABLE.map(item => item.kind === 'computer-use' ? { ...item, reasoningEffort: 'low' } : item))
    source!.changed()
    for (const mode of ['full-access', 'approval-required']) {
      await expect.poll(() => readFile(join(f.root, 'codex-roles', mode, 'sotto_computer_use.toml'), 'utf8')).toContain('model_reasoning_effort = "low"')
    }
  })

  /** A turn on the thread that has finished, so the thread can be forked whole. */
  async function finishedTurn(f: Awaited<ReturnType<typeof codexFixture>>, id: string): Promise<void> {
    await f.host.execute({ type: 'send', commandId: randomUUID(), threadId: id, messageId: randomUUID(), text: 'Synthetic turn to fork' })
    await f.driver.completeTurn(id, 'Synthetic reply')
    await expect.poll(async () => (await f.host.snapshot()).threads.find(thread => thread.id === id)?.status).toBe('idle')
  }
  const fork = (f: Awaited<ReturnType<typeof codexFixture>>, source: string, threadId: string, runtimeMode: AgentRuntimeMode) =>
    f.host.forkThread!({ commandId: randomUUID(), threadId, title: 'Synthetic fork', modelId: f.modelId, runtimeMode, source: { threadId: source } })
  /** Whether a thread has an app-server of its own, and the permission its role files were loaded with, as the adapter holds them. */
  const held = (f: Awaited<ReturnType<typeof codexFixture>>, id: string) => {
    const adapter = f.adapter as unknown as { runtimes: Map<string, unknown>; roleModes: Map<string, AgentRuntimeMode> }
    return { server: adapter.runtimes.has(id), roles: adapter.roleModes.get(id) }
  }
  /** The fake's script as it stands, with `extra` on top. */
  const scriptWith = async (f: Awaited<ReturnType<typeof codexFixture>>, extra: Record<string, unknown>) =>
    f.script({ ...JSON.parse(await readFile(join(f.root, 'script.json'), 'utf8')) as Record<string, unknown>, ...extra })

  it('passes them when a thread is forked, held to the fork\'s own permission', async () => {
    const { f, id, agents, log } = await codex(TABLE, 'full-access')
    await finishedTurn(f, id)
    const forkId = randomUUID()
    expect(await fork(f, id, forkId, 'approval-required')).toEqual({ accepted: true })
    const forked = (await f.driver.requests()).find(record => record.method === 'thread/fork')!
    expect(agents(forked)!.sotto_computer_use!.config_file).toBe(join(f.root, 'codex-roles', 'approval-required', 'sotto_computer_use.toml'))
    expect(await readFile(agents(forked)!.sotto_computer_use!.config_file, 'utf8')).toContain('sandbox_mode = "read-only"\napproval_policy = "untrusted"')
    expect(forked.params!.developerInstructions).toContain('call spawn_agent with agent_type "sotto_computer_use"')
    expect(held(f, forkId)).toEqual({ server: true, roles: 'approval-required' })
    // Codex took every role Sotto wrote for the fork.
    expect(log).not.toHaveBeenCalled()
  })

  it('lets a fork\'s app-server go when its role files cannot be written, and keeps no role permission for it', async () => {
    const { f, id } = await codex(TABLE, 'full-access')
    await finishedTurn(f, id)
    const previousServers = new Set((await f.servers()).map(record => record.pid))
    const write = CodexRoleFiles.prototype.write
    const failing = vi.spyOn(CodexRoleFiles.prototype, 'write').mockImplementation(async function (this: CodexRoleFiles, table, mode, models) {
      if (mode === 'approval-required') throw new Error('Synthetic role write failure')
      return write.call(this, table, mode, models)
    })
    cleanups.push(async () => { failing.mockRestore() })
    const forkId = randomUUID()
    await expect(fork(f, id, forkId, 'approval-required')).rejects.toThrow('Synthetic role write failure')
    // Clearing the adapter's map is insufficient: the failed setup must also release the real child process.
    const started = (await f.servers()).filter(record => record.method === 'initialize' && !previousServers.has(record.pid))
    expect(started).toHaveLength(1)
    await expect.poll(() => {
      try { process.kill(started[0]!.pid, 0); return false }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true; throw error }
    }).toBe(true)
    expect(held(f, forkId)).toEqual({ server: false, roles: undefined })
    expect((await f.driver.requests()).some(record => record.method === 'thread/fork')).toBe(false)
  })

  it('keeps a start\'s or a fork\'s role permission only once Codex binds it, none when Codex refuses or Sotto gives up', async () => {
    const { f, id } = await codex(TABLE, 'full-access', { requestTimeoutMs: 2000 })
    await finishedTurn(f, id)
    await scriptWith(f, { reject: 'thread/fork' })
    const refused = randomUUID()
    await expect(fork(f, id, refused, 'full-access')).rejects.toThrow()
    expect(held(f, refused)).toEqual({ server: false, roles: undefined })
    await scriptWith(f, { holdReply: 'thread/fork' })
    const unconfirmed = randomUUID()
    expect(await fork(f, id, unconfirmed, 'full-access')).toEqual({ accepted: false, uncertain: true })
    expect(held(f, unconfirmed)).toEqual({ server: false, roles: undefined })
    await scriptWith(f, { reject: 'thread/start' })
    const start = randomUUID()
    await expect(f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: start, projectId: f.projectId, title: 'Synthetic refused', modelId: f.modelId, runtimeMode: 'full-access' }))
      .rejects.toThrow()
    expect(held(f, start)).toEqual({ server: false, roles: undefined })
    // A start Codex has not confirmed keeps its app-server for a late answer, and holds its role permission once that
    // answer binds it.
    await scriptWith(f, { holdReply: 'thread/start' })
    const late = randomUUID()
    expect(await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: late, projectId: f.projectId, title: 'Synthetic late', modelId: f.modelId, runtimeMode: 'full-access' }))
      .toEqual({ accepted: false, uncertain: true })
    expect(held(f, late)).toEqual({ server: true, roles: undefined })
    const released = await f.action(id, { type: 'release-reply', method: 'thread/start' })
    await expect.poll(() => f.acted(released)).toBe(true)
    await expect.poll(() => held(f, late)).toEqual({ server: true, roles: 'full-access' })
  })

  it('lets a fork\'s app-server go when its permission is narrowed after it is bound, and loads it again under the narrower one', async () => {
    const { f, id, loads, agents } = await codex(TABLE, 'full-access')
    await finishedTurn(f, id)
    const forkId = randomUUID()
    expect(await fork(f, id, forkId, 'full-access')).toEqual({ accepted: true })
    expect(held(f, forkId)).toEqual({ server: true, roles: 'full-access' })
    expect((await f.host.execute({ type: 'configure-thread', commandId: randomUUID(), threadId: forkId, runtimeMode: 'approval-required' })).accepted).toBe(true)
    expect(held(f, forkId)).toEqual({ server: false, roles: undefined })
    await f.host.execute({ type: 'send', commandId: randomUUID(), threadId: forkId, messageId: randomUUID(), text: 'Synthetic narrowed fork turn' })
    const resumed = (await loads('thread/resume')).at(-1)!
    expect(agents(resumed)!.sotto_computer_use!.config_file).toBe(join(f.root, 'codex-roles', 'approval-required', 'sotto_computer_use.toml'))
  })

  it('writes no role files for a fork while worker roles are off', async () => {
    const { f, id, agents } = await codex(undefined)
    await finishedTurn(f, id)
    expect(await fork(f, id, randomUUID(), 'full-access')).toEqual({ accepted: true })
    const forked = (await f.driver.requests()).find(record => record.method === 'thread/fork')!
    expect(agents(forked)).toBeUndefined()
    expect(forked.params!.developerInstructions).not.toContain('agent_type')
    expect(existsSync(join(f.root, 'codex-roles'))).toBe(false)
  })

  it('lets the app-server go when a narrowing is confirmed after its command gave up', async () => {
    const { f, id, loads, agents } = await codex(TABLE, 'full-access', { requestTimeoutMs: 2000 })
    expect(agents((await loads('thread/start'))[0]!)).toBeDefined()
    expect(await f.sessions.stopped(id)).toBe(false)
    // Codex confirms the narrower permission after Sotto stopped waiting for it.
    await f.script({ version: 'codex/0.162.1', settingsNotificationDelay: 3000 })
    expect((await f.host.execute({ type: 'configure-thread', commandId: randomUUID(), threadId: id, runtimeMode: 'approval-required' })).accepted).toBe(false)
    await expect.poll(async () => (await f.host.snapshot()).threads.find(thread => thread.id === id)?.runtimeMode, { timeout: 10_000 }).toBe('approval-required')
    await expect.poll(() => f.sessions.stopped(id)).toBe(true)
  })

  it('tells a thread on a Codex too old for roles to name the model and effort instead', async () => {
    const { loads, agents } = await codex(TABLE, 'auto', { version: 'codex/0.161.0' })
    const [start] = await loads('thread/start')
    expect(agents(start!)).toBeUndefined()
    expect(start!.params!.developerInstructions).toContain('- Computer use (synthetic work): call spawn_agent with model "fixture-model" and reasoning_effort "high".')
    expect(start!.params!.developerInstructions).not.toContain('agent_type')
  })

  it('treats Codex dropping one of Sotto\'s roles as Sotto\'s fault, logged by name only', async () => {
    const { f, log } = await codex(TABLE)
    await f.script({ version: 'codex/0.162.1', malformedRole: 'sotto_code_review', models: [{ id: 'fixture-model', model: 'fixture-model', displayName: 'fixture-model', isDefault: true, defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] },
      { id: 'fixture-second-model', model: 'fixture-second-model', displayName: 'fixture-second-model', isDefault: false, defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }] })
    await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: randomUUID(), projectId: f.projectId, title: 'Second', modelId: f.modelId, runtimeMode: 'auto' })
    await expect.poll(() => log.mock.calls).toContainEqual(['codex-role-malformed'])
    expect(log.mock.calls.every(call => call.length === 1 && typeof call[0] === 'string' && call[0].startsWith('codex-role-'))).toBe(true)
  })

  it('sends none of it while worker roles are off', async () => {
    const { loads, agents } = await codex(undefined)
    const [start] = await loads('thread/start')
    expect(agents(start!)).toBeUndefined()
    expect(start!.params!.developerInstructions).not.toContain('worker role')
  })
})

describe('Grok Build threads', () => {
  it('carry the table in the rules a session starts with, as instructions only', async () => {
    const f = await grokFixture(undefined, 10_000, 60_000); cleanups.push(f.cleanup)
    await writeFile(join(f.root, 'script.json'), JSON.stringify({ catalog: { currentModelId: 'fixture-model', availableModels: ['fixture-model'].map(modelId => ({ modelId, name: modelId, _meta: { reasoningEffort: 'high', supportsReasoningEffort: true, reasoningEfforts: [{ id: 'high' }] } })) } }))
    f.adapter.useWorkerRoles(new WorkerRoles(() => [role('research', 'grok', 'fixture-model', 'high', 'approval-required'), role('building', 'claude', 'opus', 'xhigh', 'auto-accept-edits')]))
    f.adapter.useThreadTools([delegateTool()])
    await f.host.connect()
    await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Synthetic', path: f.root })
    await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: randomUUID(), projectId: f.projectId, title: 'Synthetic', modelId: f.modelId })
    const start = (await f.driver.requests()).find(record => record.method === 'session/new' && (record.params!._meta as { rules?: string } | undefined)?.rules)!
    const rules = (start.params!._meta as { rules: string }).rules
    expect(rules.startsWith(`${questionInstructions('ask_user_question', false)}\n\n`)).toBe(true)
    expect(rules).toContain('- Research (synthetic work): start your sub-agent on fixture-model at high effort when you can choose its model.')
    expect(rules).toContain('- Building (synthetic work): Synthetic opus at xhigh effort on Claude Code, another provider: call delegate with work "building".')
    expect(rules).not.toContain('agent_type')
  })
})

describe('Muse and Devin threads', () => {
  it('take no role table until a standing-instructions channel is checked for them', () => {
    expect('useWorkerRoles' in MuseMspHost.prototype).toBe(false)
    expect('useWorkerRoles' in DevinAcpHost.prototype).toBe(false)
  })
})
