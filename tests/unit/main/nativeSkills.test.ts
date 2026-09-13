// @vitest-environment node
import { expect, it } from 'vitest'
import { claudeCatalog, claudeSkillPrompt } from '../../../src/main/agents/claudeSkills'
import { grokCatalog, grokSkillPrompt } from '../../../src/main/agents/grokSkills'

it('uses Claude native advertised catalog identities, scope and one slash expansion', () => {
  const catalog = claudeCatalog('t', '/worktree', { commands: [{ name: 'review', description: 'Review (project)', argumentHint: '' }, { name: 'personal', description: 'Personal (user)' }] })
  expect(catalog.skills[0]).toMatchObject({ name: 'review', enabled: true, userInvocable: true, scope: 'repo', invocation: '/review' })
  expect(claudeSkillPrompt('Please $review carefully', [catalog.skills[0]!], catalog)).toEqual([{ type: 'text', text: 'Please' }, { type: 'text', text: '/review carefully' }])
  expect(claudeSkillPrompt('/review carefully', [], catalog)).toBe('/review carefully')
  expect(() => claudeSkillPrompt('$review $personal', catalog.skills, catalog)).toThrow(/one/u)
  expect(() => claudeSkillPrompt('$review', [{ name: 'review', path: 'other-worktree' }], catalog)).toThrow(/available/u)
})
it('rejects malformed Claude catalogs instead of calling failed discovery empty', () => {
  expect(() => claudeCatalog('t', '/p', {})).toThrow()
})
it('honors native Grok source, enabled and userInvocable fields', () => {
  const catalog = grokCatalog('t', '/p', { skills: [{ name: 'check', description: 'Check', source: { type: 'project', path: '/p/.grok/skills/check/SKILL.md' }, userInvocable: true }, { name: 'hidden', source: { type: 'user', path: '/home/hidden' }, userInvocable: false }, { name: 'off', source: { type: 'plugin', path: '/plugin/off' }, enabled: false }] })
  expect(catalog.skills[0]).toMatchObject({ scope: 'repo', invocation: '/check', enabled: true })
  expect(catalog.skills[1]).toMatchObject({ userInvocable: false })
  expect(() => grokSkillPrompt('$hidden', [catalog.skills[1]!], catalog)).toThrow(/available/u)
  expect(() => grokSkillPrompt('$off', [catalog.skills[2]!], catalog)).toThrow(/available/u)
  expect(() => grokSkillPrompt('$check $hidden', catalog.skills.slice(0, 2), catalog)).toThrow(/one/u)
})
