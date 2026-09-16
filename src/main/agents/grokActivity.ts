import { MAX_ACTIVITY_TEXT, planSteps, type AgentActivity } from '../../shared/agentActivity'
import { object } from './claudeProtocol'

export function grokActivities(update: Record<string, unknown>, context: { turnId: string; afterMessageId?: string | undefined; cwd: string }, previous: readonly AgentActivity[] = []): AgentActivity[] {
  let truncated = false
  const bounded = (value: string) => { if (value.length > MAX_ACTIVITY_TEXT) truncated = true; return value.slice(0, MAX_ACTIVITY_TEXT) }
  if (['subagent_spawned', 'subagent_progress', 'subagent_finished'].includes(String(update.sessionUpdate)) && typeof update.subagent_id === 'string') {
    const attempt = typeof update.attempt_id === 'string' ? update.attempt_id : update.sessionUpdate === 'subagent_spawned' && typeof update.parent_prompt_id === 'string' ? update.parent_prompt_id : undefined
    const prior = previous.findLast(row => row.kind === 'subagent' && row.agents?.some(agent => agent.id === update.subagent_id))
    const id = attempt ? `grok-agent-${update.subagent_id}-${attempt}` : prior?.id ?? `grok-agent-${update.subagent_id}`
    const old = previous.find(row => row.id === id)
    const status = update.sessionUpdate === 'subagent_finished' ? update.status === 'completed' ? 'completed' : update.status === 'failed' ? 'failed' : update.status === 'cancelled' ? 'interrupted' : 'unknown' : 'running'
    return [{ ...context, ...old, id, sequence: old?.sequence ?? 0, kind: 'subagent', status, title: typeof update.description === 'string' ? bounded(update.description) : old?.title ?? 'Subagent',
      agents: [{ id: update.subagent_id, status }], ...(typeof update.output === 'string' ? { output: bounded(update.output) } : {}),
      ...(typeof update.error === 'string' ? { error: bounded(update.error) } : {}),
      ...(typeof update.duration_ms === 'number' && Number.isFinite(update.duration_ms) && update.duration_ms >= 0 ? { durationMs: update.duration_ms, timingSource: 'provider' as const } : {}), ...(truncated ? { truncated: true } : {}) }]
  }
  // Grok replaces its whole plan on every update, so the turn keeps one plan row rather than a row per revision.
  if (update.sessionUpdate === 'plan' && Array.isArray(update.entries)) {
    const steps = planSteps(update.entries.map(entry => ({ text: object(entry)?.content, status: object(entry)?.status })))
    if (!steps.length) return []
    const id = `grok-plan-${context.turnId}`
    return [{ ...context, ...previous.find(row => row.id === id), id, sequence: 0, kind: 'plan', status: 'running', title: 'Plan', steps }]
  }
  if (!['tool_call', 'tool_call_update'].includes(String(update.sessionUpdate)) || typeof update.toolCallId !== 'string') return []
  const id = `grok-tool-${update.toolCallId}`; const old = previous.find(row => row.id === id)
  const input = object(update.rawInput); const output = object(update.rawOutput)
  const content = Array.isArray(update.content) ? update.content.map(object).filter(value => value !== undefined) : undefined
  const texts = content?.flatMap(value => { const part = object(value.content); return part?.type === 'text' && typeof part.text === 'string' ? [part.text] : [] })
  const changes = content?.flatMap(value => value.type === 'diff' && typeof value.path === 'string' ? [{ path: bounded(value.path), kind: 'edit', diff: bounded(`--- before\n${value.oldText ?? ''}\n+++ after\n${value.newText ?? ''}`) }] : [])
  const locations = Array.isArray(update.locations) ? update.locations.map(object).flatMap(value => typeof value?.path === 'string' ? [{ path: bounded(value.path), kind: typeof update.kind === 'string' ? update.kind : 'location' }] : []) : []
  const kind = update.kind === 'execute' ? 'command' : ['edit', 'delete', 'move'].includes(String(update.kind)) ? 'file-change' : old?.kind ?? 'tool'
  const status = update.status === 'completed' ? 'completed' : update.status === 'failed' ? 'failed' : ['pending', 'in_progress'].includes(String(update.status)) ? 'running' : old?.status ?? 'unknown'
  return [{ ...context, ...old, id, sequence: old?.sequence ?? 0, kind, status, title: typeof update.title === 'string' ? bounded(update.title) : old?.title ?? 'Tool',
    ...(typeof input?.command === 'string' ? { command: bounded(input.command) } : {}),
    ...(update.rawInput !== undefined ? { text: bounded(JSON.stringify(update.rawInput)) } : {}),
    ...(texts?.length ? { output: bounded(texts.join('\n')) } : update.rawOutput !== undefined ? { output: bounded(typeof update.rawOutput === 'string' ? update.rawOutput : JSON.stringify(update.rawOutput)) } : {}),
    ...(Number.isInteger(output?.exitCode ?? output?.exit_code) ? { exitCode: (output?.exitCode ?? output?.exit_code) as number } : {}),
    ...(changes?.length || locations.length ? { changes: (changes?.length ? changes : locations).slice(0, 200) } : {}), ...(truncated || (changes?.length ?? 0) > 200 || locations.length > 200 ? { truncated: true } : {}) }]
}
