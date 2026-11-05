// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { CodexJudge, CODEX_JUDGE_INSTRUCTIONS } from '../../../../src/main/council/codexJudge'
import { codexFixture } from '../../../fixtures/codexFixture'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function prepare(root?: string) {
  const directory = root ?? await mkdtemp(join(tmpdir(), 'sotto-judge-'))
  if (!root) cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const cwd = join(directory, 'council-evidence', 'judges', randomUUID(), randomUUID()), auth = join(directory, 'home')
  await mkdir(cwd, { recursive: true }); await mkdir(auth, { recursive: true })
  await writeFile(join(auth, 'auth.json'), '{"fixture":true}')
  await writeFile(join(auth, 'config.toml'), 'inherited = "must not load"')
  const judge = await CodexJudge.prepare(directory, cwd, auth)
  cleanup.push(() => judge.close())
  return { directory, cwd, judge }
}
const confirmed = (cwd: string) => ({ cwd, approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: { type: 'readOnly', networkAccess: false }, activePermissionProfile: { id: 'sotto_climb_judge', extends: null }, instructionSources: [] })
function responses(judge: CodexJudge): Record<string, unknown> {
  return { 'config/read': { config: judge.config }, 'hooks/list': { data: [{ cwd: judge.cwd, hooks: [], errors: [], warnings: [] }] },
    'skills/list': { data: [{ cwd: judge.cwd, skills: [], errors: [] }] }, 'mcpServerStatus/list': { data: [], nextCursor: null }, 'windowsSandbox/readiness': { status: 'ready' } }
}
const rpc = (answers: Record<string, unknown>) => async (method: string, _params: unknown, apply: (value: unknown) => void) => { apply(answers[method]) }

it('isolates the home and environment, preserves only login, and serializes the exact read boundary', async () => {
  const { judge, cwd } = await prepare()
  expect(await readdir(judge.home)).toEqual(['auth.json'])
  expect(await readFile(join(judge.home, 'auth.json'), 'utf8')).toBe('{"fixture":true}')
  expect(judge.environment({ PATH: '/bin', CODEX_HOME: '/old', HOME: '/old', OPENAI_API_KEY: 'secret', NODE_OPTIONS: '--require=hook', BASH_ENV: '/hook', CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'other' }))
    .toEqual({ PATH: '/bin', HOME: judge.home, USERPROFILE: judge.home, CODEX_HOME: judge.home })
  expect(judge.arguments()).toContain(`permissions={"sotto_climb_judge"={"filesystem"={${JSON.stringify(cwd)}="read"},"network"={"enabled"=false}}}`)
  expect(judge.arguments()).toContain('--strict-config')
  expect(judge.startOptions()).toMatchObject({ approvalPolicy: 'never', permissions: 'sotto_climb_judge', baseInstructions: CODEX_JUDGE_INSTRUCTIONS, developerInstructions: '', dynamicTools: [], ephemeral: true })
  await judge.verifyConfiguration(rpc(responses(judge))); await judge.verifyTools(rpc(responses(judge)))
  judge.verifyStarted(confirmed(cwd))
})

it.each([
  ['missing profile confirmation', { activePermissionProfile: undefined }],
  ['read access to the whole machine', { activePermissionProfile: { id: ':read-only' } }],
  ['permission escalation', { approvalPolicy: 'on-request' }],
  ['network access', { sandbox: { type: 'readOnly', networkAccess: true } }],
  ['inherited instructions', { instructionSources: ['/project/AGENTS.md'] }],
  ['wrong workspace', { cwd: '/project' }],
])('refuses %s in the actual thread startup', async (_name, change) => {
  const { judge, cwd } = await prepare()
  expect(() => judge.verifyStarted({ ...confirmed(cwd), ...change })).toThrow('could not confirm')
})

it.each(['config/read', 'hooks/list', 'skills/list', 'mcpServerStatus/list'])('refuses an unconfirmed %s response', async method => {
  const { judge } = await prepare(), answers = responses(judge)
  delete answers[method]
  await expect(method === 'mcpServerStatus/list' ? judge.verifyTools(rpc(answers)) : judge.verifyConfiguration(rpc(answers))).rejects.toThrow('could not confirm')
})

it('refuses extra read roots, writes, hooks, skills and MCP, while accepting unset profile metadata', async () => {
  const { judge, cwd } = await prepare()
  const checkConfig = (config: unknown) => judge.verifyConfiguration(rpc({ ...responses(judge), 'config/read': { config } }))
  await expect(checkConfig({ ...judge.config, permissions: { sotto_climb_judge: { description: null, extends: null, filesystem: { [cwd]: 'read', glob_scan_max_depth: null }, network: { enabled: false, domains: null } } } })).resolves.toBeUndefined()
  for (const filesystem of [{ [cwd]: 'write' }, { [cwd]: 'read', '/': 'read' }]) {
    await expect(checkConfig({ ...judge.config, permissions: { sotto_climb_judge: { filesystem, network: { enabled: false } } } })).rejects.toThrow('could not confirm')
  }
  await expect(judge.verifyConfiguration(rpc({ ...responses(judge), 'hooks/list': { data: [{ cwd, hooks: [{}], errors: [], warnings: [] }] } }))).rejects.toThrow('could not confirm')
  await expect(judge.verifyConfiguration(rpc({ ...responses(judge), 'skills/list': { data: [{ cwd, skills: [{ enabled: true }], errors: [] }] } }))).rejects.toThrow('could not confirm')
  await expect(judge.verifyTools(rpc({ 'mcpServerStatus/list': { data: [{}], nextCursor: null } }))).rejects.toThrow('could not confirm')
  expect(() => judge.verifySettings({ ...confirmed(cwd), sandboxPolicy: { type: 'workspaceWrite' } })).toThrow('could not confirm')
})

it.each([true, false])('the adapter sends only after Codex confirms isolation (confirmed=%s)', async confirms => {
  const f = await codexFixture(); cleanup.push(f.cleanup)
  const { judge, cwd } = await prepare(f.root)
  const config = judge.config
  await judge.close() // The adapter must create and own its own fresh private home.
  await f.script({ effectiveConfig: config, judgeHooks: [], windowsReadiness: 'ready', threadStartSettings: confirms ? confirmed(cwd) : { ...confirmed(cwd), instructionSources: undefined } })
  await f.host.connect()
  await f.host.execute!({ type: 'create-project', commandId: 'create-project', projectId: 'project', title: 'Frozen evidence', path: cwd })
  const create = f.host.execute!({ type: 'create-thread', commandId: 'create-judge', threadId: 'judge', projectId: 'project', modelId: f.modelId, title: 'Judge', workingDirectory: cwd, councilJudge: true })
  if (!confirms) {
    await expect(create).rejects.toThrow('could not confirm')
    expect((await f.driver.requests()).filter(call => call.method === 'turn/start')).toHaveLength(0)
    expect(await readdir(join(cwd, '..'))).not.toContain(judge.home.split(/[\\/]/u).at(-1))
    return
  }
  await expect(create).resolves.toMatchObject({ accepted: true })
  await expect(f.adapter.prepareSkillInput('judge', 'No outside file', [], [{ path: '/outside/private.txt' }])).rejects.toThrow('only frozen')
  await f.host.execute!({ type: 'send', commandId: 'send-assessment', threadId: 'judge', messageId: 'assessment', text: 'Frozen evidence only', attachments: [{ id: 'frozen-image', name: 'exhibit.png', mimeType: 'image/png', sizeBytes: 3, digest: '0'.repeat(64), read: async () => new Uint8Array([1, 2, 3]) }] })
  const requests = await f.driver.requests(), start = requests.find(call => call.method === 'thread/start')!
  expect(start.params).toMatchObject({ permissions: 'sotto_climb_judge', approvalPolicy: 'never', ephemeral: true, dynamicTools: [], baseInstructions: CODEX_JUDGE_INSTRUCTIONS })
  expect(start.params).not.toHaveProperty('sandbox')
  expect(requests.find(call => call.method === 'turn/start')?.params).toMatchObject({ approvalPolicy: 'never', permissions: 'sotto_climb_judge', input: [{ type: 'text', text: 'Frozen evidence only' }, { type: 'image', url: 'data:image/png;base64,AQID' }] })
  await expect(f.host.execute!({ type: 'configure-thread', commandId: 'change-judge', threadId: 'judge', runtimeMode: 'full-access' })).rejects.toThrow('cannot be changed')
  await f.action('judge', { type: 'permission', text: 'Escalate outside the snapshot' })
  await vi.waitFor(() => expect(f.adapter.resumedThreads()).not.toContain('judge'))
  expect((await f.host.snapshot()).threads.find(thread => thread.id === 'judge')?.status).toBe('error')
  await f.adapter.closeCouncilJudge('judge')
  await expect(f.host.execute!({ type: 'send', commandId: 'retry-judge', threadId: 'judge', messageId: 'retry', text: 'No resume' })).rejects.toThrow('cannot resume')
})

it('refuses Windows judging until the isolated elevated sandbox reports ready', async () => {
  const { judge } = await prepare(), original = process.platform
  Object.defineProperty(process, 'platform', { value: 'win32' })
  try {
    await expect(judge.verifyConfiguration(rpc({ ...responses(judge), 'windowsSandbox/readiness': { status: 'updateRequired' } }))).rejects.toThrow('could not confirm')
  } finally { Object.defineProperty(process, 'platform', { value: original }) }
})
