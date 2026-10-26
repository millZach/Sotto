// @vitest-environment node
// #1042: Claude Code's role agents and Codex's role files, each held to the thread's own permission.
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { claudeSubagents, CodexRoleFiles, codexRoleFile, codexTakesRoles, malformedCodexRole, narrowerMode, WorkerRoles, type CodexPolicy } from '../../../src/main/agents/subagentRoles'
import type { AgentModel, AgentRuntimeMode, ProviderId } from '../../../src/shared/agents'
import type { SubagentRole, WorkerKind } from '../../../src/shared/workerRoles'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const MODES = { 'approval-required': 'default', 'auto-accept-edits': 'acceptEdits', auto: 'auto', 'full-access': 'bypassPermissions' } as const
const POLICY = (mode: AgentRuntimeMode): CodexPolicy => mode === 'approval-required' ? { approvalPolicy: 'untrusted', approvalsReviewer: 'user', sandbox: 'read-only' }
  : mode === 'full-access' ? { approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: 'danger-full-access' }
    : { approvalPolicy: 'on-request', approvalsReviewer: mode === 'auto' ? 'auto_review' : 'user', sandbox: 'workspace-write' }
/** An adapter's own catalog: native IDs, as each client lists them. */
const native = (id: string, efforts: readonly string[], ready = true): AgentModel => ({ id, provider: 'Fixture', name: id, ready, reasoningEfforts: [...efforts] })
function role(kind: WorkerKind, provider: ProviderId, model: string, reasoningEffort: string | null, runtimeMode: AgentRuntimeMode | undefined): SubagentRole {
  return { kind, name: kind === 'ui' ? 'UI' : kind.charAt(0).toUpperCase() + kind.slice(1).replace('-', ' '), what: 'Synthetic work.', provider, model, modelName: model, reasoningEffort, runtimeMode }
}
const TABLE = [role('building', 'claude', 'opus', 'xhigh', 'auto-accept-edits'), role('ui', 'claude', 'opus[1m]', 'xhigh', 'auto-accept-edits'),
  role('code-review', 'codex', 'gpt-6.1-sol', 'xhigh', 'approval-required'), role('research', 'claude', 'haiku', null, 'approval-required'),
  role('computer-use', 'codex', 'gpt-6-astra', 'medium', 'full-access')]

describe('Claude Code role agents', () => {
  const claude = [native('opus', ['low', 'high', 'xhigh', 'max']), native('haiku', [])]

  it('makes one agent per role on a ready Claude model, each with its model, effort and permission', () => {
    const made = claudeSubagents(TABLE, 'full-access', claude, MODES)!
    expect(Object.keys(made.agents)).toEqual(['sotto_building', 'sotto_ui', 'sotto_research'])
    expect(made.agents.sotto_building).toMatchObject({ model: 'opus', effort: 'xhigh', permissionMode: 'acceptEdits' })
    // A long-context choice is its base model's in the catalog, and keeps its own ID.
    expect(made.agents.sotto_ui).toMatchObject({ model: 'opus[1m]', effort: 'xhigh' })
    expect(made.agents.sotto_research).toEqual(expect.objectContaining({ model: 'haiku', permissionMode: 'default' }))
    expect(made.agents.sotto_research).not.toHaveProperty('effort')
    expect([...made.kinds]).toEqual(['building', 'ui', 'research'])
    expect(made.widest).toBe('auto-accept-edits')
    for (const agent of Object.values(made.agents)) { expect(agent.description).toMatch(/^Use when /u); expect(agent.prompt).toContain('report') }
    // Research reads only, so it carries no MCP tool definitions, and stops sooner; the others keep every tool.
    expect(made.agents.sotto_research).toMatchObject({ tools: expect.arrayContaining(['Read', 'Grep', 'Glob', 'Bash', 'WebFetch', 'WebSearch']), maxTurns: 40 })
    expect(made.agents.sotto_research!.tools).not.toContain('Edit')
    expect(made.agents.sotto_building).toMatchObject({ maxTurns: 60 })
    expect(made.agents.sotto_building).not.toHaveProperty('tools')
  })

  it('caps every agent at the thread\'s own permission', () => {
    for (const thread of ['approval-required', 'auto-accept-edits', 'auto', 'full-access'] as const) {
      const made = claudeSubagents([role('building', 'claude', 'opus', 'high', 'full-access'), role('research', 'claude', 'haiku', null, undefined)], thread, claude, MODES)!
      expect(made.agents.sotto_building!.permissionMode).toBe(MODES[thread])
      expect(made.agents.sotto_research!.permissionMode).toBe(MODES[thread])
      expect(made.widest).toBe(thread)
    }
  })

  it('leaves out a role whose model is not ready here or whose effort it does not offer', () => {
    expect(claudeSubagents(TABLE, 'auto', [native('opus', ['high'], false), native('haiku', [], false)], MODES)).toBeUndefined()
    expect(Object.keys(claudeSubagents([role('building', 'claude', 'opus', 'ultra', undefined)], 'auto', [native('opus', ['ultra'])], MODES)?.agents ?? {})).toEqual([])
    expect(claudeSubagents([], 'auto', claude, MODES)).toBeUndefined()
  })
})

describe('Codex role files', () => {
  const codex = [native('gpt-6.1-sol', ['low', 'medium', 'high', 'xhigh']), native('gpt-6-astra', ['low', 'medium'])]
  async function files(log = vi.fn()) {
    const root = await mkdtemp(join(tmpdir(), 'sotto-codex-roles-')); roots.push(root)
    return { root, log, store: new CodexRoleFiles(join(root, 'codex-roles'), POLICY, log) }
  }

  it('writes one prefixed file per role on a ready Codex model, under Sotto\'s own folder and the thread\'s permission', async () => {
    const { root, store } = await files()
    const written = (await store.write(TABLE, 'auto', codex))!
    expect(Object.keys(written.agents)).toEqual(['sotto_code_review', 'sotto_computer_use'])
    expect(written.agents.sotto_code_review).toEqual({ description: 'Code review work: synthetic work.', config_file: join(root, 'codex-roles', 'auto', 'sotto_code_review.toml') })
    expect(await readFile(written.agents.sotto_code_review!.config_file, 'utf8')).toBe([
      'model = "gpt-6.1-sol"', 'model_reasoning_effort = "xhigh"', 'sandbox_mode = "read-only"', 'approval_policy = "untrusted"', 'approvals_reviewer = "user"',
      `developer_instructions = ${JSON.stringify('You are the Code review worker a Sotto thread started for one part of its work: synthetic work. Do the task you were given, then report plainly what you did and what you found.')}`, ''].join('\n'))
    // Computer use wants full access; a thread on Auto gives it no more than Auto.
    expect(await readFile(written.agents.sotto_computer_use!.config_file, 'utf8')).toContain('sandbox_mode = "workspace-write"\napproval_policy = "on-request"\napprovals_reviewer = "auto_review"')
    expect(written.widest).toBe('auto')
    expect(await readdir(join(root, 'codex-roles', 'auto'))).toEqual(['sotto_code_review.toml', 'sotto_computer_use.toml'])
  })

  it('leaves out a role whose model is not ready, or whose effort the model does not offer', async () => {
    const { store } = await files()
    const written = (await store.write(TABLE, 'full-access', [native('gpt-6.1-sol', ['high']), native('gpt-6-astra', ['medium'], false)]))
    expect(written).toBeUndefined()
  })

  it('writes the new table into every folder in use when Settings change', async () => {
    const { store } = await files()
    const first = (await store.write(TABLE, 'approval-required', codex))!
    await store.write(TABLE, 'full-access', codex)
    const changed = TABLE.map(item => item.kind === 'code-review' ? { ...item, reasoningEffort: 'low' } : item)
    await store.rewrite(changed, codex)
    expect(await readFile(first.agents.sotto_code_review!.config_file, 'utf8')).toContain('model_reasoning_effort = "low"')
    expect(await readFile(first.agents.sotto_code_review!.config_file.replace('approval-required', 'full-access'), 'utf8')).toContain('model_reasoning_effort = "low"')
  })

  it('leaves a role out and logs a stable event when its file cannot be written', async () => {
    const { root, store, log } = await files()
    // A file where the folder must go: nothing can be written under it.
    const blocked = new CodexRoleFiles(join(root, 'codex-roles.blocked'), POLICY, log)
    await writeFile(join(root, 'codex-roles.blocked'), 'not a folder')
    expect(await blocked.write(TABLE, 'auto', codex)).toBeUndefined()
    expect(log).toHaveBeenCalledWith('codex-role-file-failed')
    expect(log.mock.calls.flat().join(' ')).not.toContain(root)
    expect(await store.write(TABLE, 'auto', codex)).toBeDefined()
  })

  it('writes strings TOML reads back as written', () => {
    const odd = { ...TABLE[2]!, what: 'Quotes " and \\ backslashes\nand lines.' }
    for (const line of codexRoleFile(odd, 'high', POLICY('auto')).trim().split('\n')) {
      const value = /^[a-z_]+ = (".*")$/.exec(line)?.[1]
      expect(value).toBeDefined()
      expect(() => JSON.parse(value!)).not.toThrow()
    }
  })
})

describe('the rest of the plumbing', () => {
  it('knows Codex dropping one of Sotto\'s roles from any other warning', () => {
    expect(malformedCodexRole('warning', { threadId: 't', message: 'Ignoring malformed agent role definition: agent role `sotto_ui` must define a description' })).toBe(true)
    expect(malformedCodexRole('warning', { threadId: 't', message: 'Ignoring malformed agent role definition: agent role `sidekick` must define a description' })).toBe(false)
    expect(malformedCodexRole('configWarning', { summary: 'Ignoring malformed agent role definition: sotto_ui' })).toBe(false)
    expect(malformedCodexRole('warning', { message: 'Something else about sotto_ui' })).toBe(false)
    expect(malformedCodexRole('warning', null)).toBe(false)
  })

  it('gives role files only to a Codex at or after the version they were checked on', () => {
    expect(codexTakesRoles('codex/0.162.1')).toBe(true)
    expect(codexTakesRoles('sotto/0.170.0 (Windows 10.0.26200; x86_64)')).toBe(true)
    expect(codexTakesRoles('codex/0.154.0')).toBe(false)
    expect(codexTakesRoles('')).toBe(false)
    expect(codexTakesRoles(undefined)).toBe(false)
  })

  it('orders permissions from narrowest to widest', () => {
    expect(narrowerMode('approval-required', 'auto-accept-edits')).toBe(true)
    expect(narrowerMode('auto', 'auto')).toBe(false)
    expect(narrowerMode('full-access', 'auto')).toBe(false)
  })

  it('reads the table only when asked and tells each listener of a Settings change', () => {
    const read = vi.fn(() => TABLE), roles = new WorkerRoles(read)
    const heard = vi.fn(), failing = vi.fn(() => { throw new Error('Synthetic listener failure') })
    roles.onChange(failing); const stop = roles.onChange(heard)
    expect(read).not.toHaveBeenCalled()
    roles.changed()
    expect(heard).toHaveBeenCalledTimes(1)
    stop(); roles.changed()
    expect(heard).toHaveBeenCalledTimes(1)
    expect(roles.table()).toBe(TABLE)
    expect(read).toHaveBeenCalledTimes(1)
  })
})
