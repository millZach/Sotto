import { z } from 'zod'
import type { AgentSkillCatalog, AgentSkillReference } from '../../shared/agentSkills'
import { ClaudeProtocol } from './claudeProtocol'
import { claudeDenial } from './claudeRequests'

const commands = z.object({ commands: z.array(z.object({ name: z.string().min(1).max(512), description: z.string().default('') })).max(10000) })
/** The CLI resolves all configured roots/plugins, flags and precedence itself. Paths are opaque catalog identities. */
export function claudeCatalog(threadId: string, cwd: string, value: unknown): AgentSkillCatalog {
  const result = commands.parse(value)
  return { threadId, providerId: 'claude', cwd, status: 'ready', errors: [], maxSkillsPerMessage: 1,
    invocationNotice: 'Claude expands one slash invocation per message. Other skill mentions are ordinary prompt text.',
    skills: [...new Map(result.commands.map(command => [command.name, { name: command.name, path: `claude-command:${encodeURIComponent(cwd)}:${encodeURIComponent(command.name)}`, description: command.description,
      scope: /\(user\)$/u.test(command.description) ? 'user' as const : /\(project\)$/u.test(command.description) ? 'repo' as const : 'system' as const,
      enabled: true, userInvocable: true, invocation: `/${command.name}` }])).values()] }
}
export async function discoverClaudeSkills(threadId: string, cwd: string, executable: string, prefix: string[], environment: NodeJS.ProcessEnv, timeout: number): Promise<AgentSkillCatalog> {
  const protocol = new ClaudeProtocol(executable, [...prefix, '--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--permission-prompts', 'host'], cwd, environment, timeout, frame => {
    if (frame.type === 'control_request' && typeof frame.request_id === 'string') void protocol.write({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: claudeDenial() } }).catch(() => undefined)
  }, () => undefined)
  try { return claudeCatalog(threadId, cwd, await protocol.control({ subtype: 'initialize', hooks: {}, sdkMcpServers: [], promptSuggestions: false })) }
  finally { protocol.stop(); await protocol.closed }
}
export function selectedSkill(skills: readonly AgentSkillReference[], catalog: AgentSkillCatalog): AgentSkillCatalog['skills'][number] | undefined {
  if (!skills.length) return undefined
  if (skills.length > 1) throw new Error('This provider expands one selected skill per message. Send the other skill in a follow-up.')
  const selected = catalog.skills.find(skill => skill.name === skills[0]!.name && skill.path === skills[0]!.path)
  if (catalog.status !== 'ready' || !selected || selected.enabled === false || selected.userInvocable === false) throw new Error('The selected skill is no longer available in this thread. Refresh the catalog.')
  return selected
}
export function claudeSkillPrompt(text: string, skills: readonly AgentSkillReference[], catalog: AgentSkillCatalog): string | { type: 'text'; text: string }[] {
  const skill = selectedSkill(skills, catalog); if (!skill) return text
  const escaped = skill.name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const match = new RegExp(`(^|\\s)([$/])${escaped}(?=$|\\s|[.,;!?()\\[\\]{}])`, 'u').exec(text)
  if (!match) throw new Error('The selected skill mention is missing from the draft.')
  const start = match.index + match[1]!.length
  const leading = text.slice(0, start).trimEnd(); const trailing = text.slice(start + skill.name.length + 1)
  return [...(leading ? [{ type: 'text' as const, text: leading }] : []), { type: 'text', text: `/${skill.name}${trailing}` }]
}
