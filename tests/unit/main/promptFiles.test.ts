// @vitest-environment node
import { expect, it } from 'vitest'
import { claudeCatalog, claudeSkillPrompt } from '../../../src/main/agents/claudeSkills'
import { grokCatalog, grokSkillPrompt } from '../../../src/main/agents/grokSkills'
import { codexSkillInput } from '../../../src/main/agents/codexSkills'
import { filePromptPaths, filePromptText } from '../../../src/main/agents/promptFiles'

const FILES = [{ path: 'docs/plan.md' }]

it('carries a mentioned file to the provider as its working-copy relative path', () => {
  expect(filePromptPaths('Read @docs/plan.md and summarise it', FILES)).toEqual(['docs/plan.md'])
  expect(filePromptText('Read @docs/plan.md', FILES)).toBe('Read @docs/plan.md')
  // Sentence punctuation still closes the token; the path keeps its own dots and slashes.
  expect(filePromptPaths('Read @docs/plan.md, then stop', FILES)).toEqual(['docs/plan.md'])
})

it('refuses anything that is not a path inside the working copy', () => {
  expect(() => filePromptPaths('Read @../secrets.md', [{ path: '../secrets.md' }])).toThrow()
  expect(() => filePromptPaths('Read C:/keys.txt', [{ path: 'C:/keys.txt' }])).toThrow()
  expect(() => filePromptPaths('Read @docs/plan.md', [...FILES, ...FILES])).toThrow(/once/u)
})

it('sends no stale path once the mention is deleted', () => {
  expect(() => filePromptText('Read the plan', FILES)).toThrow(/no longer in this prompt/u)
  expect(() => filePromptText('Read @docs/plan.markdown', FILES)).toThrow(/no longer in this prompt/u)
  expect(filePromptText('Read the plan', [])).toBe('Read the plan')
})

it('reaches Claude, Codex and Grok as @docs/plan.md, beside a skill invocation', () => {
  const text = 'Review $review @docs/plan.md'
  const claude = claudeCatalog('t', '/worktree', { commands: [{ name: 'review', description: 'Review (project)' }] })
  expect(claudeSkillPrompt(filePromptText(text, FILES), [claude.skills[0]!], claude))
    .toEqual([{ type: 'text', text: 'Review' }, { type: 'text', text: '/review @docs/plan.md' }])

  const grok = grokCatalog('t', '/p', { skills: [{ name: 'review', description: 'Review', source: { type: 'project', path: '/p/.grok/skills/review/SKILL.md' }, userInvocable: true }] })
  expect(grokSkillPrompt(filePromptText(text, FILES), [grok.skills[0]!], grok)).toContain('@docs/plan.md')

  const codex = { threadId: 't', providerId: 'codex' as const, cwd: '/p', status: 'ready' as const, errors: [],
    skills: [{ name: 'review', description: 'Review', path: '/p/.codex/skills/review/SKILL.md', scope: 'repo' as const }] }
  expect(codexSkillInput(filePromptText(text, FILES), [{ name: 'review', path: codex.skills[0]!.path }], codex)[0])
    .toEqual({ type: 'text', text: 'Review $review @docs/plan.md' })
})
