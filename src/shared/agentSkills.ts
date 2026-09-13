import { z } from 'zod'

/** Native catalog identity, not a path the renderer may ask Sotto to read. */
export const agentSkillReferenceSchema = z.object({
  name: z.string().min(1).max(512), path: z.string().min(1).max(4096),
}).strict()
export const agentSkillReferencesSchema = z.array(agentSkillReferenceSchema).max(32)
  .refine(skills => new Set(skills.map(skill => JSON.stringify([skill.name, skill.path]))).size === skills.length, 'Choose each skill once.')
export type AgentSkillReference = z.infer<typeof agentSkillReferenceSchema>
export const agentSkillSchema = agentSkillReferenceSchema.extend({
  description: z.string(), scope: z.enum(['user', 'repo', 'system', 'admin']),
})
export const agentSkillCatalogSchema = z.object({
  threadId: z.string(), providerId: z.literal('codex'), cwd: z.string(),
  status: z.enum(['ready', 'error']), skills: z.array(agentSkillSchema),
  errors: z.array(z.object({ path: z.string(), message: z.string() })), error: z.string().optional(),
})
export type AgentSkillCatalog = z.infer<typeof agentSkillCatalogSchema>

/** Literal native token boundaries; never interpret ordinary manual syntax as a selection. */
export function hasSkillInvocation(text: string, name: string): boolean {
  const token = `$${name}`
  let offset = text.indexOf(token)
  while (offset !== -1) {
    const before = text[offset - 1]
    const after = text[offset + token.length]
    if ((!before || /\s/u.test(before)) && (!after || /\s|[.,;!?()[\]{}]/u.test(after))) return true
    offset = text.indexOf(token, offset + token.length)
  }
  return false
}
