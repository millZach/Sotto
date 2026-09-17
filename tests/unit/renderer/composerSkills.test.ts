import { describe, expect, it } from 'vitest'
import { detectSkillTrigger, insertSkill, retainSkillReferences, searchSkills, type CatalogSkill } from '../../../src/renderer/src/agents/composerSkills'
import { composerMenuKeyAction } from '../../../src/renderer/src/agents/composerKeys'

const skill = (name: string, description = '', scope: CatalogSkill['scope'] = 'user'): CatalogSkill => ({ name, description, scope, path: `C:/skills/${name}/SKILL.md` })

describe('skill triggers', () => {
  it('opens for a slash only at the start of a line and for a $ token anywhere', () => {
    expect(detectSkillTrigger('/rev', 4)).toEqual({ kind: 'slash', query: 'rev', start: 0, end: 4 })
    expect(detectSkillTrigger('first line\n/', 12)).toEqual({ kind: 'slash', query: '', start: 11, end: 12 })
    expect(detectSkillTrigger('see a/b', 7)).toBeNull()
    expect(detectSkillTrigger('/review now', 11)).toBeNull()
    expect(detectSkillTrigger('run $dep', 8)).toEqual({ kind: 'dollar', query: 'dep', start: 4, end: 8 })
    expect(detectSkillTrigger('cost $5 and $', 13)).toEqual({ kind: 'dollar', query: '', start: 12, end: 13 })
    expect(detectSkillTrigger('a$b', 3)).toBeNull()
    expect(detectSkillTrigger('run $dep', 8, 4)).toBeNull()
  })
})

describe('skill search', () => {
  const skills = [skill('review-pr', 'Review a pull request', 'repo'), skill('deploy', 'Ship to staging'), skill('pr-summary', 'Summarise the diff'), skill('deploy', 'Personal copy', 'system')]
  it('keeps native order and duplicates for an empty query', () => {
    expect(searchSkills(skills, '')).toEqual(skills)
  })
  it('ranks exact, prefix, word and substring name matches before description matches', () => {
    expect(searchSkills(skills, 'pr').map(item => item.name)).toEqual(['pr-summary', 'review-pr'])
    expect(searchSkills(skills, 'staging').map(item => item.name)).toEqual(['deploy'])
    expect(searchSkills(skills, 'DEPLOY')).toEqual([skills[1], skills[3]])
  })
})

describe('skill insertion and references', () => {
  it('replaces the trigger with a reviewed $name token and records the exact reference once', () => {
    const deploy = skill('deploy')
    const first = insertSkill('Please $de', detectSkillTrigger('Please $de', 10)!, deploy, [])
    expect(first).toEqual({ text: 'Please $deploy ', caret: 15, skills: [{ name: 'deploy', path: deploy.path }] })
    const text = `${first.text}and /`
    const again = insertSkill(text, { kind: 'dollar', query: '', start: text.length - 1, end: text.length }, deploy, first.skills)
    expect(again.skills).toEqual([{ name: 'deploy', path: deploy.path }])
  })
  it('inserts in the middle of text without doubling a following space', () => {
    const result = insertSkill('run $re now', { kind: 'dollar', query: 're', start: 4, end: 7 }, skill('review'), [])
    expect(result.text).toBe('run $review now')
    expect(result.caret).toBe(11)
  })
  it('drops a reference when its token is edited away, and keeps literal look-alikes out', () => {
    const refs = [{ name: 'deploy', path: 'a' }, { name: 'review', path: 'b' }]
    expect(retainSkillReferences('$deploy then $review.', refs)).toEqual(refs)
    expect(retainSkillReferences('$deployed then review', refs)).toEqual([])
  })
})

describe('skills menu keys', () => {
  const key = (patch: Partial<Parameters<typeof composerMenuKeyAction>[0]> = {}) => ({ key: 'Enter', shiftKey: false, altKey: false, isComposing: false, keyCode: 13, defaultPrevented: false, ...patch })
  it('lets Enter select only a highlighted option and never during composition', () => {
    expect(composerMenuKeyAction(key(), { optionCount: 2, highlighted: true })).toBe('select')
    expect(composerMenuKeyAction(key(), { optionCount: 2, highlighted: false })).toBe('none')
    expect(composerMenuKeyAction(key({ shiftKey: true }), { optionCount: 2, highlighted: true })).toBe('none')
    expect(composerMenuKeyAction(key({ isComposing: true }), { optionCount: 2, highlighted: true })).toBe('none')
    expect(composerMenuKeyAction(key({ keyCode: 229, key: 'ArrowDown' }), { optionCount: 2, highlighted: true })).toBe('none')
    expect(composerMenuKeyAction(key({ key: 'Tab' }), { optionCount: 2, highlighted: false })).toBe('select')
    expect(composerMenuKeyAction(key({ key: 'Tab', shiftKey: true }), { optionCount: 2, highlighted: false })).toBe('none')
    expect(composerMenuKeyAction(key({ key: 'Escape' }), { optionCount: 0, highlighted: false })).toBe('close')
    expect(composerMenuKeyAction(key({ key: 'ArrowDown' }), { optionCount: 0, highlighted: false })).toBe('none')
  })
})
