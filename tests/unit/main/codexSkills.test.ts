// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentControl } from '../../../src/main/agents/control'
import { AgentCredentials } from '../../../src/main/agents/credentials'
import { agentCommandSchema, agentThreadDraftSchema } from '../../../src/shared/agents'
import { hasSkillInvocation } from '../../../src/shared/agentSkills'
import { codexSkillInput, parseCodexSkillCatalog } from '../../../src/main/agents/codexSkills'
import { codexFixture } from '../../fixtures/codexFixture'

const fixtures: Awaited<ReturnType<typeof codexFixture>>[] = []
const controls: AgentControl[] = []
afterEach(async () => { for (const c of controls.splice(0)) c.dispose(); for (const f of fixtures.splice(0)) await f.cleanup() })
async function fixture() {
  const f = await codexFixture(undefined, true); fixtures.push(f)
  await f.host.connect()
  await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Project', path: f.root })
  const threadId = randomUUID()
  await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId, projectId: f.projectId, title: 'Skills', modelId: f.modelId })
  return { ...f, threadId }
}
const skill = (path: string, enabled = true) => ({ name: 'native-review', description: 'Native description verbatim.', path, scope: 'repo' as const, enabled,
  interface: { displayName: 'Pretty title' }, dependencies: null, shortDescription: null })

describe('Codex native skills', () => {
  it('preserves native order, duplicate names and exact metadata; excludes disabled entries and foreign cwd', () => {
    const cwd = process.cwd(); const native = skill(join(cwd, 'repo', 'SKILL.md'))
    const user = { ...skill(join(cwd, 'user', 'SKILL.md')), scope: 'user' }
    const result = parseCodexSkillCatalog({ data: [
      { cwd: join(cwd, 'other'), skills: [skill(join(cwd, 'foreign', 'SKILL.md'))], errors: [] },
      { cwd, skills: [native, user, skill(join(cwd, 'disabled', 'SKILL.md'), false)], errors: [{ path: 'broken', message: 'Native parse failure' }] },
    ] }, 'sotto-id', cwd)
    expect(result.skills).toEqual([native, user].map(({ name, description, path, scope }) => ({ name, description, path, scope })))
    expect(result.errors).toEqual([{ path: 'broken', message: 'Native parse failure' }])
    expect(() => parseCodexSkillCatalog({ data: [] }, 'id', cwd)).toThrow('no skill catalog')
  })
  it('retains selected identities in strict draft and send schemas without interpreting native commands', () => {
    const skills = [{ name: 'native-review', path: join(process.cwd(), 'SKILL.md') }]
    const draft = { threadId: 'thread', draftId: randomUUID(), text: '$native-review Check', skills, attachments: [], requestId: null, updatedAt: new Date().toISOString() }
    expect(agentThreadDraftSchema.parse(draft).skills).toEqual(skills)
    expect(agentCommandSchema.parse({ type: 'save-thread-draft', threadId: draft.threadId, draftId: draft.draftId, text: draft.text, skills })).toMatchObject({ skills })
    expect(agentCommandSchema.parse({ type: 'manual-send', threadId: 'thread', text: '/review $manual', skills: [] })).toMatchObject({ text: '/review $manual', skills: [] })
    expect(hasSkillInvocation('$native-review-extra', 'native-review')).toBe(false)
    expect(hasSkillInvocation('word$native-review', 'native-review')).toBe(false)
  })
  it('lists for native cwd using Sotto identity and sends exact structured selection through real fixture RPC', async () => {
    const f = await fixture(); const selected = skill(join(f.root, 'native-review', 'SKILL.md'))
    await f.script({ skills: [selected] })
    const catalog = await f.host.listThreadSkills!(f.threadId)
    expect(catalog).toMatchObject({ threadId: f.threadId, cwd: f.root, status: 'ready', skills: [{ name: selected.name, path: selected.path }] })
    const text = '$native-review Check this code.'
    await f.host.execute({ type: 'send', threadId: f.threadId, commandId: 'send', messageId: 'message', text, skills: [{ name: selected.name, path: selected.path }] })
    const requests = await f.driver.requests()
    expect(requests.filter(r => r.method === 'skills/list').map(r => r.params)).toEqual([{ cwds: [f.root], forceReload: true }, { cwds: [f.root], forceReload: true }])
    expect(requests.findLast(r => r.method === 'turn/start')?.params?.input).toEqual([{ type: 'text', text }, { type: 'skill', name: selected.name, path: selected.path }])
  })
  it('uses the durable native working folder after restart, not the project or a supplied replacement scope', async () => {
    const f = await fixture()
    f.host.disconnect(); await f.adapter.closed()
    const path = join(f.root, 'codex-threads.json')
    const aliases = JSON.parse(await readFile(path, 'utf8'))
    const cwd = join(f.root, 'independent'); await mkdir(cwd)
    aliases[f.registry.byThread(f.threadId)!.sessionId]!.cwd = cwd
    await writeFile(path, JSON.stringify(aliases))
    await f.host.connect()
    expect(await f.host.listThreadSkills!(f.threadId, false, { providerId: 'codex', workingDirectory: f.root })).toMatchObject({ cwd, status: 'ready' })
    expect((await f.driver.requests()).findLast(r => r.method === 'skills/list')?.params?.cwds).toEqual([cwd])
  })
  it.each(['reject', 'malformed', 'changed'] as const)('reports %s catalog failure while retaining connected native thread', async failure => {
    const f = await fixture()
    await f.script(failure === 'reject' ? { reject: 'skills/list' } : failure === 'malformed' ? { skillsMalformed: true } : { skillsChanged: true })
    expect(await f.host.listThreadSkills!(f.threadId, true)).toMatchObject({ status: 'error', skills: [], error: expect.any(String) })
    expect((await f.host.snapshot()).connected).toBe(true)
    expect((await f.driver.requests()).filter(r => r.method === 'turn/start')).toHaveLength(0)
    await f.script({})
    expect(await f.host.listThreadSkills!(f.threadId, true)).toMatchObject({ status: 'ready', skills: [] })
  })
  it('rejects disabled or removed selections before dispatch; manual syntax still sends despite catalog failure', async () => {
    const f = await fixture(); const selected = skill(join(f.root, 'SKILL.md'))
    await f.script({ skills: [selected] }); await f.host.listThreadSkills!(f.threadId)
    await f.script({ skills: [{ ...selected, enabled: false }] })
    await expect(f.host.execute({ type: 'send', threadId: f.threadId, commandId: 'no', messageId: 'no', text: '$native-review Check', skills: [{ name: selected.name, path: selected.path }] })).rejects.toThrow('unavailable')
    expect((await f.driver.requests()).filter(r => r.method === 'turn/start')).toHaveLength(0)
    await f.script({ reject: 'skills/list' })
    await expect(f.host.execute({ type: 'send', threadId: f.threadId, commandId: 'manual', messageId: 'manual', text: '/review $native-review' })).resolves.toEqual({ accepted: true })
    expect((await f.driver.requests()).findLast(r => r.method === 'turn/start')?.params?.input).toEqual([{ type: 'text', text: '/review $native-review' }])
  })
  it('never silently dispatches a structured reference without its reviewable token or with forged path', () => {
    const cwd = process.cwd(); const selected = skill(join(cwd, 'SKILL.md'))
    const catalog = parseCodexSkillCatalog({ data: [{ cwd, skills: [selected], errors: [] }] }, 'id', cwd)
    expect(() => codexSkillInput('Check', [{ name: selected.name, path: selected.path }], catalog)).toThrow('no longer')
    expect(() => codexSkillInput('$native-review Check', [{ name: selected.name, path: join(cwd, 'secret') }], catalog)).toThrow('unavailable')
  })
  it('refreshes without changing focus, draft, assignment or durability; a late older response cannot replace a newer catalog', async () => {
    const f = await fixture()
    const credentials = new AgentCredentials(join(f.root, 'vault'), { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() })
    await credentials.load()
    const control = new AgentControl({ directory: f.root, host: f.host, credentials,
      reasoner: { intent: async () => ({ type: 'clarify', text: 'Choose' }), decide: async () => ({ decision: 'human', text: 'Review' }) },
      membership: { status: async () => ({ status: 'beta', label: 'Fixture', expiresAt: null }), action: async () => ({ status: 'beta', label: 'Fixture', expiresAt: null }) } })
    controls.push(control); await control.start(); await control.command({ type: 'connect' })
    const draft = { type: 'save-thread-draft' as const, threadId: f.threadId, draftId: randomUUID(), text: 'Keep my draft' }
    await control.command(draft)
    const before = control.get()
    await f.script({ delay: { method: 'skills/list', ms: 250 }, skills: [skill(join(f.root, 'old', 'SKILL.md'))] })
    const old = control.command({ type: 'refresh-thread-skills', threadId: f.threadId })
    await vi.waitFor(async () => expect((await f.driver.requests()).filter(r => r.method === 'skills/list')).toHaveLength(1))
    await vi.waitFor(async () => expect(JSON.parse(await readFile(join(f.root, 'script.json'), 'utf8')).delay).toBeUndefined())
    await f.script({ skills: [skill(join(f.root, 'new', 'SKILL.md'))] })
    await control.command({ type: 'refresh-thread-skills', threadId: f.threadId, forceReload: true })
    await old
    const after = control.get()
    expect(after.skillCatalogs?.[0]?.skills[0]?.path).toBe(join(f.root, 'new', 'SKILL.md'))
    expect(after.threadDrafts).toEqual(before.threadDrafts)
    expect(after.activeThreadId).toBe(before.activeThreadId)
    expect(after.assignments).toEqual([])
    expect((await f.driver.requests()).filter(r => r.method === 'turn/start')).toHaveLength(0)
    expect(await readFile(join(f.root, 'agents.json'), 'utf8')).not.toContain('skillCatalogs')
  })
})
