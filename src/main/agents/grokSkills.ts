import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { z } from 'zod'
import type { AgentSkillCatalog, AgentSkillReference } from '../../shared/agentSkills'
import { selectedSkill, claudeSkillPrompt } from './claudeSkills'

const inspectSchema = z.object({ skills: z.array(z.object({ name: z.string().min(1), description: z.string().default(''), enabled: z.boolean().optional(), userInvocable: z.boolean().optional(), source: z.object({ type: z.string(), path: z.string().min(1) }) })) })
export function grokCatalog(threadId: string, cwd: string, value: unknown): AgentSkillCatalog {
  const result = inspectSchema.parse(value)
  return { threadId, providerId: 'grok', cwd, status: 'ready', errors: [], maxSkillsPerMessage: 1,
    skills: result.skills.map(skill => ({ name: skill.name, path: skill.source.path, description: skill.description, enabled: skill.enabled ?? true, userInvocable: skill.userInvocable ?? true,
      scope: skill.source.type === 'project' ? 'repo' : skill.source.type === 'user' ? 'user' : 'system', nativeSource: skill.source.type, invocation: `/${skill.name}` })) }
}
export async function discoverGrokSkills(threadId: string, cwd: string, executable: string, prefix: string[], environment: NodeJS.ProcessEnv): Promise<AgentSkillCatalog> {
  const { stdout } = await promisify(execFile)(executable, [...prefix, 'inspect', '--json'], { cwd, env: environment, windowsHide: true, shell: false, timeout: 15000, maxBuffer: 4 * 1024 * 1024 })
  return grokCatalog(threadId, cwd, JSON.parse(stdout))
}
export function grokSkillPrompt(text: string, skills: readonly AgentSkillReference[], catalog: AgentSkillCatalog): string {
  const skill = selectedSkill(skills, catalog)
  if (!skill) return text
  const blocks = claudeSkillPrompt(text, skills, catalog)
  if (typeof blocks === 'string') return blocks
  const command = blocks.at(-1)!.text
  // ACP 1 / Grok 1.0.5 expands a leading slash invocation. Preserve other draft text as arguments.
  return blocks.length > 1 ? `${command}\n${blocks.slice(0, -1).map(block => block.text).join('\n')}` : command
}
