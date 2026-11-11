// @vitest-environment node
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HermesAcpHost } from '../../../src/main/agents/hermes'
import { hermesConfig, hermesProjectHome, hermesSharedSkills } from '../../../src/main/agents/hermesRuntime'
import { discoverHermesSkills, hermesSkillPrompt, hermesSkillSlug, invokedHermesSkill } from '../../../src/main/agents/hermesSkills'
import type { AgentHostSnapshot } from '../../../src/shared/agents'
import { providerProfile } from '../../../src/shared/providerProfile'

const folders: string[] = []
afterEach(async () => { await Promise.all(folders.splice(0).map(folder => rm(folder, { recursive: true, force: true }))) })

async function skill(root: string, folder: string, text: string): Promise<string> {
  const path = join(root, folder, 'SKILL.md')
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text)
  return path
}
async function roots() {
  const base = await mkdtemp(join(tmpdir(), 'sotto-hermes-skills-')); folders.push(base)
  const own = join(base, 'profile', 'skills'), shared = join(base, 'skills')
  const afk = await skill(shared, 'afk', '---\nname: afk\ndescription: Works through a project while you are away.\n---\n\n# AFK\n\nGather evidence.\n')
  await skill(shared, 'devops/deploy', '---\nname: "deploy"\ndescription: >\n  Ships the build\n  to the server.\n---\nShared deploy.\n')
  await skill(shared, 'devops/unnamed', 'No front matter here.\n')
  await skill(shared, 'review', '\uFEFF---\nname: Code_Review # the team’s\ndescription: "Reads a diff" # quoted\n---\n')
  // A skill's own supporting folders hold no skill, and a skill below a skill is still one.
  await skill(shared, 'afk/scripts/helper', '---\nname: helper\n---\n')
  await skill(shared, 'afk/nested/deeper/still/inner', '---\nname: inner\n---\n')
  await skill(shared, '.hub/hidden', '---\nname: hidden\n---\n')
  const deploy = await skill(own, 'testing/deploy', '---\nname: deploy\ndescription: This project’s own deploy.\n---\nOwn deploy.\n')
  return { own, shared, afk, deploy }
}

describe('Hermes skills', () => {
  it('lists the profile’s own skills ahead of the shared ones, by the name Hermes gives each', async () => {
    const { own, shared, afk, deploy } = await roots()
    const catalog = await discoverHermesSkills('thread', '/project', [{ directory: own, scope: 'repo' }, { directory: shared, scope: 'user' }])
    expect(catalog).toMatchObject({ threadId: 'thread', providerId: 'hermes', cwd: '/project', status: 'ready', maxSkillsPerMessage: 1 })
    expect(catalog.skills).toEqual([
      { name: 'afk', path: afk, description: 'Works through a project while you are away.', scope: 'user', enabled: true, userInvocable: true, invocation: '/afk' },
      // Named as Hermes names its command, past a byte order mark and a comment.
      { name: 'code-review', path: join(shared, 'review', 'SKILL.md'), description: 'Reads a diff', scope: 'user', enabled: true, userInvocable: true, invocation: '/code-review' },
      // The profile's own skill keeps the name; the shared one of the same name is not offered.
      { name: 'deploy', path: deploy, description: 'This project’s own deploy.', scope: 'repo', enabled: true, userInvocable: true, invocation: '/deploy' },
      { name: 'inner', path: join(shared, 'afk', 'nested', 'deeper', 'still', 'inner', 'SKILL.md'), description: '', scope: 'user', enabled: true, userInvocable: true, invocation: '/inner' },
      // No front matter: the folder names the skill.
      { name: 'unnamed', path: join(shared, 'devops', 'unnamed', 'SKILL.md'), description: '', scope: 'user', enabled: true, userInvocable: true, invocation: '/unnamed' },
    ])
    // A folded description reads as one line, and a profile that has written no skill has no folder.
    const sharedOnly = await discoverHermesSkills('thread', '/project', [{ directory: join(own, 'missing'), scope: 'repo' }, { directory: shared, scope: 'user' }])
    expect(sharedOnly.skills.find(item => item.name === 'deploy')?.description).toBe('Ships the build to the server.')
  })

  it('names a command as Hermes does', () => {
    expect(['Code Review', 'git_helper', 'afk', '--C++ / Tools--', 'Über_Skill', '+'].map(hermesSkillSlug)).toEqual(['code-review', 'git-helper', 'afk', 'c-tools', 'über-skill', ''])
  })

  // Making a link needs a privilege a Windows account may not have.
  it.skipIf(process.platform === 'win32')('follows a linked skill folder once, and leaves out a skill file it cannot read', async () => {
    const { shared } = await roots()
    const elsewhere = await mkdtemp(join(tmpdir(), 'sotto-hermes-linked-')); folders.push(elsewhere)
    await skill(elsewhere, 'linked', '---\nname: linked\n---\n')
    await symlink(join(elsewhere, 'linked'), join(shared, 'linked'))
    await symlink(shared, join(shared, 'devops', 'loop'))
    await mkdir(join(shared, 'broken'))
    await symlink(join(elsewhere, 'missing.md'), join(shared, 'broken', 'SKILL.md'))
    const catalog = await discoverHermesSkills('thread', '/project', [{ directory: shared, scope: 'user' }])
    expect(catalog.skills.map(item => item.name)).toEqual(['afk', 'code-review', 'deploy', 'inner', 'linked', 'unnamed'])
    expect(catalog.skills.find(item => item.name === 'linked')?.path).toBe(join(shared, 'linked', 'SKILL.md'))
  })

  it('takes the picked skill, or a listed one whose name opens the words', async () => {
    const { own, shared, afk } = await roots()
    const catalog = await discoverHermesSkills('thread', '/project', [{ directory: own, scope: 'repo' }, { directory: shared, scope: 'user' }])
    expect(invokedHermesSkill('First line\n/afk Back in 2 hours', [{ name: 'afk', path: afk }], catalog)?.name).toBe('afk')
    expect(invokedHermesSkill('/afk Back in 2 hours', [], catalog)?.path).toBe(afk)
    // Hermes reads a typed name loosely, as it writes one.
    expect(invokedHermesSkill('/Code_Review the branch', [], catalog)?.name).toBe('code-review')
    // A path, an unknown slash word and a name further in are ordinary words.
    expect(invokedHermesSkill('/etc/hosts is wrong', [], catalog)).toBeUndefined()
    expect(invokedHermesSkill('/nothing here', [], catalog)).toBeUndefined()
    expect(invokedHermesSkill('Tell me about /afk', [], catalog)).toBeUndefined()
    expect(() => invokedHermesSkill('/afk', [{ name: 'afk', path: '/elsewhere/SKILL.md' }], catalog)).toThrow('no longer available')
  })

  it('sends the skill file as Hermes’s own invocation does, with the words beside the name as the instruction', () => {
    const path = join('/hermes', 'skills', 'afk', 'SKILL.md')
    expect(hermesSkillPrompt('/afk Back in 2 hours.', { name: 'afk', path }, '---\nname: afk\n---\n\n# AFK\n')).toBe([
      '[IMPORTANT: The user has invoked the "afk" skill, indicating they want you to follow its instructions. The full skill content is loaded below.]',
      '', '---\nname: afk\n---\n\n# AFK', '', `[Skill directory: ${dirname(path)}]`, 'Resolve any relative paths in this skill against that directory.',
      '', 'The user has provided the following instruction alongside the skill invocation: Back in 2 hours.'].join('\n'))
    // The name alone leaves no instruction line; words before a picked name stay in the instruction.
    expect(hermesSkillPrompt('/afk', { name: 'afk', path }, '# AFK')).not.toContain('following instruction')
    expect(hermesSkillPrompt('In ~/site\n/afk two hours', { name: 'afk', path }, '# AFK')).toContain('skill invocation: In ~/site\ntwo hours')
    // A longer name that starts the same is not this skill's token.
    expect(hermesSkillPrompt('/afk-later now', { name: 'afk', path }, '# AFK')).toContain('skill invocation: /afk-later now')
    // Only the first mention is the invocation, however it was typed.
    expect(hermesSkillPrompt('/Code_Review then explain /code-review', { name: 'code-review', path }, '# Review')).toContain('skill invocation: then explain /code-review')
  })

  it('has every project profile read the shared skills, and the adapter list both folders', async () => {
    const base = await mkdtemp(join(tmpdir(), 'sotto-hermes-host-')); folders.push(base)
    const host = new HermesAcpHost(base)
    expect(JSON.parse(hermesConfig([], '/project', hermesSharedSkills(host.folder))).skills).toEqual({ external_dirs: [join(host.folder, 'skills')] })
    expect(JSON.parse(hermesConfig([]))).not.toHaveProperty('skills')
    expect(providerProfile('hermes')?.skillSigils).toEqual(['/'])
    await skill(hermesSharedSkills(host.folder), 'afk', '---\nname: afk\n---\n')
    await skill(join(hermesProjectHome(host.folder, '/project'), 'skills'), 'testing/probe', '---\nname: probe\n---\n')
    await expect(host.listThreadSkills('draft', false, { providerId: 'hermes', workingDirectory: '/project' })).rejects.toThrow('Reconnect this Hermes thread')
    const state = Reflect.get(host, 'state') as AgentHostSnapshot
    state.connected = true
    expect(state.capabilities.skills).toBe(true)
    const catalog = await host.listThreadSkills('draft', false, { providerId: 'hermes', workingDirectory: '/project' })
    expect(catalog.skills.map(item => [item.name, item.scope])).toEqual([['afk', 'user'], ['probe', 'repo']])
    // A draft in a worktree of its own still reads its project's profile, not one named for the worktree.
    const draft = await host.listThreadSkills('draft', false, { providerId: 'hermes', workingDirectory: '/worktrees/draft', projectPath: '/project' })
    expect(draft.skills.map(item => item.name)).toEqual(['afk', 'probe'])
    expect((await host.listThreadSkills('draft', false, { providerId: 'hermes', workingDirectory: '/worktrees/draft' })).skills.map(item => item.name)).toEqual(['afk'])
  })

  it('refuses a skill steered into a running turn, picked or typed, and says where it goes', async () => {
    const base = await mkdtemp(join(tmpdir(), 'sotto-hermes-steer-')); folders.push(base)
    const host = new HermesAcpHost(base)
    await skill(hermesSharedSkills(host.folder), 'afk', '---\nname: afk\n---\n')
    ;(Reflect.get(host, 'state') as AgentHostSnapshot).connected = true
    Reflect.set(host, 'aliases', { thread: { hermesSessionId: 'session', projectId: 'project', cwd: '/project', title: 'Test', modelId: 'own-test/model', runtimeMode: 'full-access', turns: 1, origins: [], answeredRequestIds: [] } })
    ;(Reflect.get(host, 'turns') as Map<string, unknown>).set('thread', { ended: false })
    const open = vi.fn(async () => { throw new Error('opened') }); Reflect.set(host, 'open', open)
    const steer = (text: string, skills?: { name: string; path: string }[]) => (Reflect.get(host, 'steer') as (command: unknown, generation: number) => Promise<unknown>)
      .call(host, { type: 'steer', threadId: 'thread', commandId: 'command', messageId: 'message', text, ...(skills ? { skills } : {}) }, 0)
    await expect(steer('/afk now')).rejects.toThrow('Hermes starts a skill with a new message')
    await expect(steer('Use /afk', [{ name: 'afk', path: join(hermesSharedSkills(host.folder), 'afk', 'SKILL.md') }])).rejects.toThrow('Queue it as a follow-up')
    expect(open).not.toHaveBeenCalled()
    // Ordinary words, and a slash word that names no skill, are steered as before.
    await expect(steer('/tmp/x is the file')).rejects.toThrow('opened')
  })
})
