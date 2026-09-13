import { hasSkillInvocation, type AgentSkillCatalog, type AgentSkillReference } from '../../../shared/agentSkills'

export type CatalogSkill = AgentSkillCatalog['skills'][number]

/** The token at the caret that opened the skills picker. */
export interface SkillTrigger {
  /** `/` at the start of a line, or a `$` token anywhere. */
  readonly kind: 'slash' | 'dollar'
  readonly query: string
  readonly start: number
  readonly end: number
}

const SCOPE_LABELS: Record<CatalogSkill['scope'], string> = { user: 'Personal', repo: 'Project', system: 'System', admin: 'Admin' }
export const MAX_SELECTED_SKILLS = 32

export function skillScopeLabel(scope: CatalogSkill['scope']): string { return SCOPE_LABELS[scope] }

/**
 * What the text before the caret is asking for. A slash counts only when it opens its line, where
 * a native command would; a `$` token counts anywhere. Selection ranges never open the picker.
 */
export function detectSkillTrigger(text: string, selectionStart: number, selectionEnd = selectionStart): SkillTrigger | null {
  if (selectionStart !== selectionEnd) return null
  const caret = Math.max(0, Math.min(text.length, selectionStart))
  const lineStart = text.lastIndexOf('\n', caret - 1) + 1
  const line = text.slice(lineStart, caret)
  const slash = /^\/(\S*)$/u.exec(line)
  if (slash) return { kind: 'slash', query: slash[1] ?? '', start: lineStart, end: caret }
  let start = caret
  while (start > 0 && !/\s/u.test(text[start - 1]!)) start -= 1
  const token = text.slice(start, caret)
  if (!token.startsWith('$') || token.slice(1).includes('$')) return null
  return { kind: 'dollar', query: token.slice(1), start, end: caret }
}

function matchScore(value: string, query: string, base: number): number | null {
  if (value === query) return base
  if (value.startsWith(query)) return base + 2
  if (value.split(/[-_/:.\s]+/u).some(part => part.startsWith(query))) return base + 4
  if (value.includes(query)) return base + 6
  return null
}

/** Native order with an empty query; otherwise name matches rank above description matches, native order breaking ties. */
export function searchSkills(skills: readonly CatalogSkill[], query: string): CatalogSkill[] {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return [...skills]
  return skills
    .map((skill, index) => ({ skill, index, score: matchScore(skill.name.toLowerCase(), normalized, 0) ?? matchScore(skill.description.toLowerCase(), normalized, 20) }))
    .filter((item): item is { skill: CatalogSkill; index: number; score: number } => item.score !== null)
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map(item => item.skill)
}

/** Selected references whose `$name` is still written in the text; a deleted token takes its reference with it. */
export function retainSkillReferences(text: string, skills: readonly AgentSkillReference[]): AgentSkillReference[] {
  return skills.filter(skill => hasSkillInvocation(text, skill.name))
}

const sameSkill = (a: AgentSkillReference, b: AgentSkillReference): boolean => a.name === b.name && a.path === b.path

/**
 * Replace the trigger token with the skill's native `$name` invocation for the user to review.
 * Returns the new text, the caret after the inserted token, and the references this text keeps.
 */
export function insertSkill(text: string, trigger: SkillTrigger, skill: AgentSkillReference, selected: readonly AgentSkillReference[]): { text: string; caret: number; skills: AgentSkillReference[] } {
  const after = text.slice(trigger.end)
  const spacer = after.startsWith(' ') || after.startsWith('\n') ? '' : ' '
  const token = `$${skill.name}${spacer}`
  const next = `${text.slice(0, trigger.start)}${token}${after}`
  const kept = retainSkillReferences(next, selected)
  const reference = { name: skill.name, path: skill.path }
  const skills = kept.some(item => sameSkill(item, reference)) ? kept : [...kept, reference].slice(-MAX_SELECTED_SKILLS)
  return { text: next, caret: trigger.start + token.length, skills }
}

export function sameSkillReferences(a: readonly AgentSkillReference[], b: readonly AgentSkillReference[]): boolean {
  return a.length === b.length && a.every((item, index) => sameSkill(item, b[index]!))
}
