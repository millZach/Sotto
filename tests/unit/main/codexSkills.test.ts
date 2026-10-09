// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { agentCommandSchema, agentThreadDraftSchema } from '../../../src/shared/agents'
import { hasSkillInvocation } from '../../../src/shared/agentSkills'
import { codexSkillInput, parseCodexSkillCatalog } from '../../../src/main/agents/codexSkills'

import { skill } from '../../fixtures/codexSkillFixture'

describe("Codex native skills", () => {

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

  it('never silently dispatches a structured reference without its reviewable token or with forged path', () => {
    const cwd = process.cwd(); const selected = skill(join(cwd, 'SKILL.md'))
    const catalog = parseCodexSkillCatalog({ data: [{ cwd, skills: [selected], errors: [] }] }, 'id', cwd)
    expect(() => codexSkillInput('Check', [{ name: selected.name, path: selected.path }], catalog)).toThrow('no longer')
    expect(() => codexSkillInput('$native-review Check', [{ name: selected.name, path: join(cwd, 'secret') }], catalog)).toThrow('unavailable')
  })
})
