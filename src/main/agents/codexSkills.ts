import { isAbsolute, normalize } from 'node:path'
import { z } from 'zod'
import { agentSkillSchema, agentSkillReferencesSchema, hasSkillInvocation, type AgentSkillCatalog, type AgentSkillReference } from '../../shared/agentSkills'

// Codex 0.154.0 SkillsListResponse: native ordering and duplicate names belong to
// Codex. Do not recreate discovery/precedence by scanning files or sorting scopes.
const responseSchema = z.object({ data: z.array(z.object({
  cwd: z.string(), skills: z.array(agentSkillSchema.extend({ enabled: z.boolean() }).strip()),
  errors: z.array(z.object({ path: z.string(), message: z.string() })),
})) })
const pathKey = (path: string): string => process.platform === 'win32' ? normalize(path).toLowerCase() : normalize(path)

export function parseCodexSkillCatalog(value: unknown, threadId: string, cwd: string): AgentSkillCatalog {
  const result = responseSchema.parse(value)
  const entry = result.data.find(entry => pathKey(entry.cwd) === pathKey(cwd))
  if (!entry) throw new Error('Codex returned no skill catalog for this working folder.')
  if (entry.skills.some(skill => !isAbsolute(skill.path))) throw new Error('Codex returned an invalid skill reference.')
  return { threadId, providerId: 'codex', cwd, status: 'ready',
    skills: entry.skills.filter(skill => skill.enabled).map(({ name, description, path, scope }) => ({ name, description, path, scope })),
    errors: entry.errors }
}

export function codexSkillInput(text: string, references: readonly AgentSkillReference[], catalog: AgentSkillCatalog) {
  const skills = agentSkillReferencesSchema.parse(references)
  if (catalog.status !== 'ready') throw new Error(catalog.error || 'Codex skills could not be verified. Refresh the skills and retry.')
  for (const skill of skills) {
    if (!hasSkillInvocation(text, skill.name)) throw new Error(`The selected skill $${skill.name} is no longer in this prompt. Remove its selection or restore the invocation.`)
    if (!catalog.skills.some(candidate => candidate.name === skill.name && candidate.path === skill.path)) {
      throw new Error(`The selected skill $${skill.name} is unavailable in this working folder. Refresh skills and review the selection.`)
    }
  }
  return [{ type: 'text' as const, text }, ...skills.map(skill => ({ type: 'skill' as const, name: skill.name, path: skill.path }))]
}
