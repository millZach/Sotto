import { MAX_ACTIVITY_TEXT, isTerminalActivity, mergeAgentActivities, planSteps, type AgentActivity } from '../../shared/agentActivity'
import { object, type ClaudeFrame } from './claudeProtocol'
import { claudeText } from './claudeSessionLog'

const text = (value: unknown): string | undefined => typeof value === 'string' ? value.slice(0, MAX_ACTIVITY_TEXT) : undefined
const json = (value: unknown): string | undefined => value === undefined ? undefined : JSON.stringify(value).slice(0, MAX_ACTIVITY_TEXT)

/** Same projector for native transcript snapshots and the streaming CLI. No execution. */
export class ClaudeActivity {
  private readonly blocks = new Map<string, { block: ClaudeFrame; input: string }>()
  private readonly subagentTasks = new Set<string>()
  apply(previous: AgentActivity[], frame: ClaudeFrame, turnId: string, afterMessageId: string | undefined, cwd: string): AgentActivity[] {
    const rows: AgentActivity[] = []
    const base = { turnId, sequence: 0, ...(afterMessageId ? { afterMessageId } : {}), cwd,
      ...(typeof frame.timestamp === 'string' && Number.isFinite(Date.parse(frame.timestamp)) ? { startedAt: new Date(frame.timestamp).toISOString(), timingSource: 'provider' as const } : {}),
      ...(typeof frame.parent_tool_use_id === 'string' ? { parentId: `claude-tool-${frame.parent_tool_use_id}` } : {}) }
    const tool = (block: ClaudeFrame): void => {
      if (typeof block.id !== 'string' || typeof block.name !== 'string') return
      const input = object(block.input)
      const name = block.name
      const old = previous.find(row => row.id === `claude-tool-${block.id}`)
      const kind = /^(Bash|PowerShell|Shell)$/u.test(name) ? 'command' : /^(Write|Edit|MultiEdit|NotebookEdit)$/u.test(name) ? 'file-change'
        : /^(Agent|Task)$/u.test(name) ? 'subagent' : /^Todo(Write|Update)$/u.test(name) ? 'plan' : 'tool'
      const path = text(input?.file_path ?? input?.notebook_path)
      // Claude keeps its plan in a todo list; its steps are the plan, not tool input to read as JSON.
      const todos = kind === 'plan' && Array.isArray(input?.todos)
        ? planSteps(input.todos.map(value => ({ text: object(value)?.content, status: object(value)?.status }))) : undefined
      rows.push({ ...base, id: `claude-tool-${block.id}`, kind, status: old && isTerminalActivity(old.status) ? old.status : 'running', title: kind === 'plan' ? 'Plan' : name,
        ...(todos?.length ? { steps: todos } : {}),
        ...(input && !todos?.length ? { text: json(input) } : {}), ...(typeof input?.command === 'string' ? { command: text(input.command) } : {}),
        ...(input && JSON.stringify(input).length > MAX_ACTIVITY_TEXT ? { truncated: true } : {}),
        ...(path ? { changes: [{ path, kind: name, ...(typeof input?.old_string === 'string' && typeof input?.new_string === 'string' ? { diff: text(`--- before\n${input.old_string}\n+++ after\n${input.new_string}`) } : {}) }] } : {}) })
    }
    const blocks = object(frame.message)?.content
    if (Array.isArray(blocks)) for (const value of blocks) {
      const block = object(value); if (!block) continue
      if (['tool_use', 'server_tool_use', 'mcp_tool_use'].includes(String(block.type))) tool(block)
      if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        const old = previous.find(row => row.id === `claude-tool-${block.tool_use_id}`)
        const result = object(frame.tool_use_result)
        rows.push({ ...base, ...old, id: `claude-tool-${block.tool_use_id}`, kind: old?.kind ?? 'tool', title: old?.title ?? 'Tool result',
          status: block.is_error === true ? 'failed' : 'completed', startedAt: old?.startedAt, output: text(claudeText(block.content)) ?? '',
          ...(claudeText(block.content).length > MAX_ACTIVITY_TEXT ? { truncated: true } : {}),
          ...(Number.isInteger(result?.exitCode ?? result?.exit_code) ? { exitCode: (result?.exitCode ?? result?.exit_code) as number } : {}),
          ...(base.startedAt ? { completedAt: base.startedAt } : {}) })
      }
    }
    if (frame.type === 'stream_event') {
      const event = object(frame.event); const key = `${frame.parent_tool_use_id ?? 'main'}:${event?.index}`
      const block = object(event?.content_block)
      if (event?.type === 'content_block_start' && block && ['tool_use', 'server_tool_use', 'mcp_tool_use'].includes(String(block.type))) {
        this.blocks.set(key, { block, input: '' }); tool(block)
      }
      const partial = this.blocks.get(key); const delta = object(event?.delta)
      if (partial && event?.type === 'content_block_delta' && delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
        partial.input = (partial.input + delta.partial_json).slice(0, MAX_ACTIVITY_TEXT)
        try { tool({ ...partial.block, input: JSON.parse(partial.input) }) } catch { /* Incomplete JSON is not tool input yet. */ }
      }
      if (event?.type === 'content_block_stop') this.blocks.delete(key)
    }
    if (frame.type === 'system' && ['task_started', 'task_progress', 'task_notification'].includes(String(frame.subtype)) && typeof frame.task_id === 'string') {
      const status = frame.subtype === 'task_notification' ? frame.status === 'completed' ? 'completed' : frame.status === 'failed' ? 'failed' : frame.status === 'stopped' ? 'interrupted' : 'unknown' : 'running'
      const owner = typeof frame.tool_use_id === 'string' ? previous.find(row => row.id === `claude-tool-${frame.tool_use_id}`) : undefined
      if (frame.subtype === 'task_started') {
        // Reclassify reused IDs. Only a positively observed subagent start admits later updates;
        // monitors need no tombstones, so late progress stays hidden even in long sessions.
        this.subagentTasks.delete(frame.task_id)
        if (!frame.task_id || frame.task_id.length > 512 || ['monitor', 'monitor_mcp', 'local_bash'].includes(String(frame.task_type))
          || frame.skip_transcript === true || frame.ambient === true || owner?.kind === 'command') return mergeAgentActivities(previous, rows)
        this.subagentTasks.add(frame.task_id)
        if (this.subagentTasks.size > 4_096) this.subagentTasks.delete(this.subagentTasks.values().next().value!)
      }
      // A shell notification can finish its known command even when its task start was missed.
      if (owner?.kind === 'command') {
        if (frame.subtype === 'task_notification' && status !== 'unknown') rows.push({ ...owner, status })
        return mergeAgentActivities(previous, rows)
      }
      if (!this.subagentTasks.has(frame.task_id)) return mergeAgentActivities(previous, rows)
      if (frame.subtype === 'task_notification') this.subagentTasks.delete(frame.task_id)
      const old = previous.find(row => row.id === `claude-task-${frame.task_id}`)
      rows.push({ ...base, ...old, id: `claude-task-${frame.task_id}`, kind: 'subagent', status, title: text(frame.description) ?? old?.title ?? 'Subagent',
        ...(typeof frame.tool_use_id === 'string' ? { parentId: `claude-tool-${frame.tool_use_id}` } : {}),
        ...(text(frame.summary ?? frame.last_tool_name) ? { text: text(frame.summary ?? frame.last_tool_name) } : {}),
        agents: [{ id: frame.task_id, status, ...(text(frame.summary) ? { message: text(frame.summary) } : {}) }] })
    }
    return mergeAgentActivities(previous, rows)
  }
}
