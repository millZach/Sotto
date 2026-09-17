import type { AgentSkillCatalog, AgentSkillReference } from '../../../shared/agentSkills'
import { hasMentionToken } from '../../../shared/mentions'
import { detectMentionTrigger } from './composerMentions'

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

/** How a written skill mention starts. Codex reads only `$name`; Claude and Grok also take their native `/name`. */
export type SkillSigil = '$' | '/'
export function skillSigils(providerId: string | undefined): readonly SkillSigil[] {
  return providerId === 'claude' || providerId === 'grok' ? ['$', '/'] : ['$']
}

/** The token the provider's own interface writes for a skill: its native invocation when the catalog gives one. */
export function skillToken(skill: { readonly name: string; readonly invocation?: string | undefined }): string {
  const invocation = skill.invocation?.trim()
  return invocation && /^[$/]\S+$/u.test(invocation) ? invocation : `$${skill.name}`
}

/** Skills the user may pick: the catalog as listed, less those the provider reports disabled or not user-invocable. */
export function pickableSkills(skills: readonly CatalogSkill[]): CatalogSkill[] {
  return skills.filter(skill => skill.enabled !== false && skill.userInvocable !== false)
}

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
  const dollar = detectMentionTrigger(text, selectionStart, selectionEnd, '$')
  return dollar === null ? null : { kind: 'dollar', ...dollar }
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

/** A literal mention at token boundaries, the same check main makes before dispatch. */
export function hasSkillMention(text: string, name: string, sigils: readonly SkillSigil[] = ['$']): boolean {
  return sigils.some(sigil => hasMentionToken(text, `${sigil}${name}`))
}

/** Selected references whose mention is still written in the text; a deleted token takes its reference with it. */
export function retainSkillReferences(text: string, skills: readonly AgentSkillReference[], sigils: readonly SkillSigil[] = ['$']): AgentSkillReference[] {
  return skills.filter(skill => hasSkillMention(text, skill.name, sigils))
}

const sameSkill = (a: AgentSkillReference, b: AgentSkillReference): boolean => a.name === b.name && a.path === b.path

/** A provider with a per-message limit takes no other selection once it is reached; picking a selected skill again is fine. */
export function skillLimitReached(selected: readonly AgentSkillReference[], skill: AgentSkillReference, max: number | undefined): boolean {
  return max !== undefined && selected.length >= max && !selected.some(item => sameSkill(item, skill))
}

/**
 * Replace the trigger token with the skill's native invocation (`$name`, or the catalog's `/name`) for the user to review.
 * Returns the new text, the caret after the inserted token, and the references this text keeps.
 */
export function insertSkill(text: string, trigger: SkillTrigger, skill: AgentSkillReference & { readonly invocation?: string | undefined }, selected: readonly AgentSkillReference[],
  sigils: readonly SkillSigil[] = ['$']): { text: string; caret: number; skills: AgentSkillReference[] } {
  const after = text.slice(trigger.end)
  const spacer = after.startsWith(' ') || after.startsWith('\n') ? '' : ' '
  const written = skillToken(skill)
  // A provider that reads only `$name` gets `$name`, whatever the catalog wrote.
  const token = `${sigils.includes(written.charAt(0) as SkillSigil) ? written : `$${skill.name}`}${spacer}`
  const next = `${text.slice(0, trigger.start)}${token}${after}`
  const kept = retainSkillReferences(next, selected, sigils)
  const reference = { name: skill.name, path: skill.path }
  const skills = kept.some(item => sameSkill(item, reference)) ? kept : [...kept, reference].slice(-MAX_SELECTED_SKILLS)
  return { text: next, caret: trigger.start + token.length, skills }
}

export function sameSkillReferences(a: readonly AgentSkillReference[], b: readonly AgentSkillReference[]): boolean {
  return a.length === b.length && a.every((item, index) => sameSkill(item, b[index]!))
}
