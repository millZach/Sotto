// @vitest-environment node
import { expect, it } from 'vitest'
import { claudeCatalog, claudeSkillPrompt } from '../../../src/main/agents/claudeSkills'
import { grokCatalog, grokSkillPrompt } from '../../../src/main/agents/grokSkills'
import { codexSkillInput } from '../../../src/main/agents/codexSkills'
import { verifyFileMentions } from '../../../src/main/agents/promptFiles'

const FILES = [{ path: 'docs/plan.md' }]

it('accepts a mention written as its working-copy relative path', () => {
  expect(() => verifyFileMentions('Read @docs/plan.md and summarise it', FILES)).not.toThrow()
  // Sentence punctuation still closes the token; the path keeps its own dots and slashes.
  expect(() => verifyFileMentions('Read @docs/plan.md, then stop', FILES)).not.toThrow()
  expect(() => verifyFileMentions('Read the plan', [])).not.toThrow()
})

it('refuses anything that is not a space-free path inside the working copy', () => {
  expect(() => verifyFileMentions('Read @../secrets.md', [{ path: '../secrets.md' }])).toThrow()
  expect(() => verifyFileMentions('Read C:/keys.txt', [{ path: 'C:/keys.txt' }])).toThrow()
  expect(() => verifyFileMentions('Read @docs/plan.md', [...FILES, ...FILES])).toThrow(/once/u)
  // A `@path` token ends at the first space, so a path holding one would reach the provider truncated.
  expect(() => verifyFileMentions('Read @my notes/plan.md', [{ path: 'my notes/plan.md' }])).toThrow(/space/u)
})

it('sends no stale path once the mention is deleted', () => {
  expect(() => verifyFileMentions('Read the plan', FILES)).toThrow(/no longer in this prompt/u)
  expect(() => verifyFileMentions('Read @docs/plan.markdown', FILES)).toThrow(/no longer in this prompt/u)
})

it('reaches Claude, Codex and Grok as @docs/plan.md, beside a skill invocation', () => {
  const text = 'Review $review @docs/plan.md'
  verifyFileMentions(text, FILES)
  const claude = claudeCatalog('t', '/worktree', { commands: [{ name: 'review', description: 'Review (project)' }] })
  expect(claudeSkillPrompt(text, [claude.skills[0]!], claude))
    .toEqual([{ type: 'text', text: 'Review' }, { type: 'text', text: '/review @docs/plan.md' }])

  const grok = grokCatalog('t', '/p', { skills: [{ name: 'review', description: 'Review', source: { type: 'project', path: '/p/.grok/skills/review/SKILL.md' }, userInvocable: true }] })
  expect(grokSkillPrompt(text, [grok.skills[0]!], grok)).toContain('@docs/plan.md')

  const codex = { threadId: 't', providerId: 'codex' as const, cwd: '/p', status: 'ready' as const, errors: [],
    skills: [{ name: 'review', description: 'Review', path: '/p/.codex/skills/review/SKILL.md', scope: 'repo' as const }] }
  expect(codexSkillInput(text, [{ name: 'review', path: codex.skills[0]!.path }], codex)[0])
    .toEqual({ type: 'text', text: 'Review $review @docs/plan.md' })
})
