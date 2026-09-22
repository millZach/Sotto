import { createHash } from 'node:crypto'
import { MAX_ACTIVITY_TEXT, compactAgentIdentity, isTerminalActivity, mergeAgentActivities, planSteps, type AgentActivity, type ObservedAgent } from '../../shared/agentActivity'
import { object, type ClaudeFrame } from './claudeProtocol'
import { claudeText } from './claudeSessionLog'
import { CLAUDE_TRANSCRIPT_ID, claudeWorkflowModels, type ClaudeModelTarget, type ClaudeSubagentTranscript } from './claudeSubagentModels'

const text = (value: unknown): string | undefined => typeof value === 'string' ? value.slice(0, MAX_ACTIVITY_TEXT) : undefined
const agentAliasId = (id: string): string => `claude-agent-alias-${createHash('sha256').update(id).digest('hex')}`
const json = (value: unknown): string | undefined => value === undefined ? undefined : JSON.stringify(value).slice(0, MAX_ACTIVITY_TEXT)
/** Agents whose own transcript may still name their model; the oldest gives way past this. */
const MAX_TRANSCRIPT_TARGETS = 64

/** Same projector for native transcript snapshots and the streaming CLI. No execution. */
export class ClaudeActivity {
  private readonly blocks = new Map<string, { block: ClaudeFrame; input: string }>()
  private readonly closedTasks = new Set<string>()
  private readonly agentsByTool = new Map<string, ObservedAgent>()
  private readonly agentsByTask = new Map<string, ObservedAgent>()
  private readonly taskByTool = new Map<string, string>()
  private readonly toolByTask = new Map<string, string>()
  private readonly agentAliases = new Map<string, string>()
  private readonly pendingModels = new Map<string, string>()
  /** Workflow run folders reported by a Workflow launch, by its tool call, until its task is known. */
  private readonly runsByTool = new Map<string, string>()
  /** Agents with no model yet whose own transcript can name one, by observed agent id. */
  private readonly transcripts = new Map<string, { transcript: ClaudeSubagentTranscript; tool?: string | undefined; task?: string | undefined }>()
  constructor(private readonly readActivity?: (activityId: string) => AgentActivity | undefined) {}
  apply(previous: AgentActivity[], frame: ClaudeFrame, turnId: string, afterMessageId: string | undefined, cwd: string, live = false): AgentActivity[] {
    const rows: AgentActivity[] = []
    const observedAt = typeof frame.timestamp === 'string' && Number.isFinite(Date.parse(frame.timestamp))
      ? new Date(frame.timestamp).toISOString() : live ? new Date().toISOString() : undefined
    const parentTool = typeof frame.parent_tool_use_id === 'string' ? frame.parent_tool_use_id : undefined
    const model = text(object(frame.message)?.model)
    if (parentTool && model) {
      this.pendingModels.set(parentTool, model.slice(0, 512))
      const prior = this.agentsByTool.get(parentTool)
      if (prior) {
        const agent = { ...prior, model, ...(observedAt ? { observedAt } : {}) }
        this.agentsByTool.set(parentTool, compactAgentIdentity(agent))
        const task = this.taskByTool.get(parentTool)
        if (task) this.agentsByTask.set(task, compactAgentIdentity(agent))
        const old = previous.findLast(row => row.agents?.some(child => child.id === agent.id))
        rows.push({ ...(old ?? { id: `claude-agent-model-${parentTool}`, turnId, sequence: 0, kind: 'subagent', title: agent.title ?? 'Subagent', status: 'unknown' }), agents: [agent] })
      }
    }
    // A live stream frame carries no timestamp of its own, so the moment Sotto received it is the only
    // start there is; `observedAt` already prefers the provider's own time where a replayed frame has one.
    // Replay without a timestamp still records nothing, because a transcript must not be given a clock
    // it never had. Codex has timed its running rows this way since `codexActivity` was written.
    const base = { turnId, sequence: 0, ...(afterMessageId ? { afterMessageId } : {}), cwd,
      ...(observedAt ? { startedAt: observedAt, timingSource: typeof frame.timestamp === 'string' ? ('provider' as const) : ('observed' as const) } : {}),
      ...(typeof frame.parent_tool_use_id === 'string' ? { parentId: `claude-tool-${frame.parent_tool_use_id}` } : {}) }
    const tool = (block: ClaudeFrame): void => {
      if (typeof block.id !== 'string' || typeof block.name !== 'string') return
      const input = object(block.input)
      const name = block.name
      const old = previous.find(row => row.id === `claude-tool-${block.id}`) ?? this.readActivity?.(`claude-tool-${block.id}`)
      const kind = /^(Bash|PowerShell|Shell)$/u.test(name) ? 'command' : /^(Write|Edit|MultiEdit|NotebookEdit)$/u.test(name) ? 'file-change'
        : /^(Agent|Task)$/u.test(name) ? 'subagent' : /^Todo(Write|Update)$/u.test(name) ? 'plan' : 'tool'
      let child: ObservedAgent | undefined
      if (kind === 'subagent' && (typeof input?.prompt === 'string' || typeof input?.description === 'string' || typeof input?.resume === 'string')) {
        const prior = this.agentsByTool.get(block.id) ?? old?.agents?.[0]
        const aliasId = typeof input?.resume === 'string' ? agentAliasId(input.resume) : undefined
        const resumedId = aliasId ? this.agentAliases.get(aliasId) ?? this.readActivity?.(aliasId)?.agents?.find(agent => agent.aliasIds?.includes(aliasId))?.id : undefined
        const parent = parentTool ? this.agentsByTool.get(parentTool)?.id ?? `claude-agent-${parentTool}` : undefined
        const prompt = text(input?.prompt)
        const description = text(input?.description)
        child = { ...prior, id: resumedId ?? prior?.id ?? `claude-agent-${block.id}`, assignmentId: `claude-tool-${block.id}`, status: prior?.status ?? 'running',
          ...(parent ? { parentId: parent } : {}), ...(aliasId ? { aliasIds: [aliasId] } : {}), ...(prompt ? { prompt } : {}), ...(description ? { description } : {}),
          ...(description || prompt ? { title: description ?? prompt!.split(/\r?\n/u)[0]!.slice(0, 1_000) } : {}),
          ...(this.pendingModels.get(block.id) ?? text(input?.model) ? { model: this.pendingModels.get(block.id) ?? text(input?.model) } : {}),
          ...(observedAt ? { observedAt: live ? observedAt : prior?.observedAt ?? observedAt, startedAt: prior?.startedAt ?? observedAt, timingSource: typeof frame.timestamp === 'string' ? 'provider' : 'observed' } : {}),
        }
        this.agentsByTool.set(block.id, compactAgentIdentity(child))
      }
      const path = text(input?.file_path ?? input?.notebook_path)
      // Claude keeps its plan in a todo list; its steps are the plan, not tool input to read as JSON.
      const todos = kind === 'plan' && Array.isArray(input?.todos)
        ? planSteps(input.todos.map(value => ({ text: object(value)?.content, status: object(value)?.status }))) : undefined
      rows.push({ ...base, id: `claude-tool-${block.id}`, kind, status: old && isTerminalActivity(old.status) ? old.status : 'running', title: kind === 'plan' ? 'Plan' : name,
        ...(child ? { agents: [child] } : {}),
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
        const old = previous.find(row => row.id === `claude-tool-${block.tool_use_id}`) ?? this.readActivity?.(`claude-tool-${block.tool_use_id}`)
        const result = object(frame.tool_use_result)
        // A replayed transcript files the same launch result as `toolUseResult`. Only its model and
        // transcript identities are read from there; its status stays with the live stream's shape.
        const launch = result ?? object(frame.toolUseResult)
        const resolvedModel = text(launch?.resolvedModel)
        let child = this.agentsByTool.get(block.tool_use_id) ?? old?.agents?.[0]
        const task = this.taskByTool.get(block.tool_use_id)
        const run = typeof launch?.runId === 'string' && CLAUDE_TRANSCRIPT_ID.test(launch.runId) ? launch.runId : undefined
        if (run) this.runsByTool.set(block.tool_use_id, run)
        if (child && typeof result?.agentId === 'string') {
          const aliasId = agentAliasId(result.agentId)
          this.agentAliases.set(aliasId, child.id)
          child = { ...child, aliasIds: [aliasId] }
        }
        if (child) {
          // A background launch acknowledgement completes the tool, not the child.
          // Only an explicit task outcome or a synchronous child result proves completion.
          const completed = result?.status === 'completed' || (typeof result?.agentId === 'string' && Array.isArray(result.content) && result.isAsync !== true)
          const failed = block.is_error === true || result?.status === 'failed'
          // What the CLI resolved an alias or default to is what the agent ran on; only its own reply outranks it.
          const model = this.pendingModels.get(block.tool_use_id) ?? resolvedModel
          const named = model !== undefined && model !== child.model
          child = { ...child, ...(completed || failed ? { status: failed ? 'failed' : 'completed', message: text(claudeText(result?.content ?? block.content)), ...(observedAt ? { completedAt: child.completedAt ?? observedAt } : {}) } : {}),
            ...(model ? { model } : {}),
            ...(observedAt ? { observedAt } : {}), ...(typeof result?.totalDurationMs === 'number' && Number.isFinite(result.totalDurationMs) && result.totalDurationMs >= 0 ? { durationMs: result.totalDurationMs } : {}) }
          if (named) this.patchModel(previous, rows, child.id, model)
          this.agentsByTool.set(block.tool_use_id, compactAgentIdentity(child))
          if (task) this.agentsByTask.set(task, compactAgentIdentity(child))
          // A background launch names the agent's own transcript by its agent id, a workflow launch by its run.
          if (typeof launch?.agentId === 'string') this.watchTranscript(child, { agentId: launch.agentId }, block.tool_use_id, task)
          else if (run && task) this.watchTranscript(child, { runId: run }, block.tool_use_id, task)
        }
        rows.push({ ...base, ...old, id: `claude-tool-${block.tool_use_id}`, kind: old?.kind ?? 'tool', title: old?.title ?? 'Tool result',
          ...(child ? { agents: [child] } : {}),
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
      const status = frame.subtype === 'task_notification' ? frame.status === 'completed' ? 'completed' : frame.status === 'failed' ? 'failed' : ['stopped', 'cancelled', 'canceled', 'killed', 'interrupted'].includes(String(frame.status)) ? 'interrupted' : 'unknown' : 'running'
      const owner = typeof frame.tool_use_id === 'string' ? previous.find(row => row.id === `claude-tool-${frame.tool_use_id}`) ?? this.readActivity?.(`claude-tool-${frame.tool_use_id}`) : undefined
      const old = previous.find(row => row.id === `claude-task-${frame.task_id}`) ?? this.readActivity?.(`claude-task-${frame.task_id}`)
      // A restored row is positive task evidence even when this projector resumed after its start.
      // Retire a reassigned identity on that history row so cursor resume preserves the exclusion.
      if (frame.subtype === 'task_started') {
        if (!frame.task_id || frame.task_id.length > 512 || ['monitor', 'monitor_mcp', 'local_bash'].includes(String(frame.task_type))
          || frame.skip_transcript === true || frame.ambient === true || owner?.kind === 'command') {
          this.agentsByTask.delete(frame.task_id)
          this.closedTasks.delete(frame.task_id)
          if (old?.kind === 'subagent') rows.push({ ...old, taskUpdatesExcluded: true })
          return mergeAgentActivities(previous, rows)
        }
        this.closedTasks.delete(frame.task_id)
        // Clearing historical classification must survive the terminal-status merge guard.
        if (old && old.taskUpdatesExcluded !== false) rows.push({ ...old, taskUpdatesExcluded: false })
      }
      // A shell notification can finish its known command even when its task start was missed.
      if (owner?.kind === 'command') {
        if (frame.subtype === 'task_notification' && status !== 'unknown') rows.push({ ...owner, status })
        return mergeAgentActivities(previous, rows)
      }
      if (frame.subtype !== 'task_started' && (old?.taskUpdatesExcluded || this.closedTasks.has(frame.task_id) || (old?.kind !== 'subagent' && !this.agentsByTask.has(frame.task_id)))) return mergeAgentActivities(previous, rows)
      if (frame.subtype === 'task_notification' && old) {
        // Persist closure even if an unknown outcome is rejected by the terminal-status guard.
        rows.push({ ...old, taskUpdatesExcluded: true })
        if (isTerminalActivity(old.status) && old.taskUpdatesExcluded !== false) return mergeAgentActivities(previous, rows)
      }
      const toolId = typeof frame.tool_use_id === 'string' ? frame.tool_use_id : this.toolByTask.get(frame.task_id)
      const prior = this.agentsByTask.get(frame.task_id) ?? (toolId ? this.agentsByTool.get(toolId) : undefined) ?? old?.agents?.[0]
      const taskDescription = text(frame.description)
      // No CLI up to 2.1.280 names a model on the task itself; a workflow's progress names each of its agents'.
      const progress = Array.isArray(frame.workflow_progress) ? frame.workflow_progress.map(value => text(object(value)?.model)).filter((model): model is string => !!model && model !== '<synthetic>') : []
      const taskModel = text(frame.model) ?? (progress.length ? claudeWorkflowModels(prior?.model, progress) : undefined)
      const child: ObservedAgent = { ...prior, id: prior?.id ?? (toolId ? `claude-agent-${toolId}` : `claude-agent-task-${frame.task_id}`), assignmentId: prior?.assignmentId ?? `claude-task-${frame.task_id}`, status,
        ...(taskDescription ? { title: taskDescription, description: taskDescription } : {}),
        ...(taskModel ? { model: taskModel } : {}),
        ...(text(frame.summary) ? { message: text(frame.summary) } : {}),
        ...(observedAt ? { observedAt } : {}),
        ...(frame.subtype === 'task_started' && !prior?.startedAt && observedAt ? { startedAt: observedAt, timingSource: typeof frame.timestamp === 'string' ? 'provider' : 'observed' } : {}),
        ...(isTerminalActivity(status) && observedAt ? { completedAt: prior?.completedAt ?? observedAt } : {}),
      }
      // A status-free progress update cannot restart an already completed assignment.
      if (prior && isTerminalActivity(prior.status as AgentActivity['status']) && status === 'running' && frame.subtype !== 'task_started') return mergeAgentActivities(previous, rows)
      if (frame.subtype === 'task_notification') this.closedTasks.add(frame.task_id)
      if (taskModel && taskModel !== prior?.model) this.patchModel(previous, rows, child.id, taskModel)
      this.agentsByTask.set(frame.task_id, compactAgentIdentity(child))
      if (toolId) {
        this.agentsByTool.set(toolId, compactAgentIdentity(child))
        this.taskByTool.set(toolId, frame.task_id)
        this.toolByTask.set(frame.task_id, toolId)
      }
      // A spawned agent's task id is its native agent id, which names its transcript file; a workflow's
      // task names nothing on disk, so its run folder comes from the launch result.
      if (frame.subtype === 'task_started') {
        const run = toolId ? this.runsByTool.get(toolId) : undefined
        if (frame.task_type === 'local_agent') this.watchTranscript(child, { agentId: frame.task_id }, toolId, frame.task_id)
        else if (frame.task_type === 'local_workflow' && run) this.watchTranscript(child, { runId: run }, toolId, frame.task_id)
      }
      rows.push({ ...base, ...old, id: `claude-task-${frame.task_id}`, kind: 'subagent', status, ...(frame.subtype === 'task_notification' ? { taskUpdatesExcluded: true } : frame.subtype === 'task_started' && old ? { taskUpdatesExcluded: false } : {}), title: text(frame.description) ?? old?.title ?? 'Subagent',
        ...(typeof frame.tool_use_id === 'string' ? { parentId: `claude-tool-${frame.tool_use_id}` } : {}),
        ...(text(frame.summary ?? frame.last_tool_name) ? { text: text(frame.summary ?? frame.last_tool_name) } : {}),
        agents: [child] })
    }
    return mergeAgentActivities(previous, rows)
  }
  /** Agents still missing a model whose own transcript may name it, newest first. */
  modelTargets(): ClaudeModelTarget[] {
    const targets: ClaudeModelTarget[] = []
    for (const [id, entry] of this.transcripts) {
      const agent = this.current(id, entry)
      if (agent?.model) { this.transcripts.delete(id); continue }
      targets.push({ id, transcript: entry.transcript, settled: agent?.status !== 'running' })
    }
    return targets.reverse()
  }
  /** A model read from an agent's own transcript, given to the rows that already show that agent. */
  applyModel(previous: AgentActivity[], id: string, model: string): AgentActivity[] {
    const entry = this.transcripts.get(id)
    if (!entry || this.current(id, entry)?.model) return previous
    this.transcripts.delete(id)
    const rows: AgentActivity[] = []
    this.patchModel(previous, rows, id, model.slice(0, 512), entry)
    return rows.length ? mergeAgentActivities(previous, rows) : previous
  }
  private current(id: string, entry: { tool?: string | undefined; task?: string | undefined }): ObservedAgent | undefined {
    const byTask = entry.task ? this.agentsByTask.get(entry.task) : undefined
    const byTool = entry.tool ? this.agentsByTool.get(entry.tool) : undefined
    return byTask?.id === id ? byTask : byTool?.id === id ? byTool : undefined
  }
  private watchTranscript(agent: ObservedAgent, transcript: ClaudeSubagentTranscript, tool: string | undefined, task: string | undefined): void {
    if (agent.model || !CLAUDE_TRANSCRIPT_ID.test('agentId' in transcript ? transcript.agentId : transcript.runId)) return
    const known = this.transcripts.get(agent.id)
    // An agent's own file names one agent; a run folder may hold several, so it never replaces a file.
    if (known && 'agentId' in known.transcript && 'runId' in transcript) return
    this.transcripts.delete(agent.id)
    this.transcripts.set(agent.id, { transcript, tool: tool ?? known?.tool, task: task ?? known?.task })
    for (const id of this.transcripts.keys()) { if (this.transcripts.size <= MAX_TRANSCRIPT_TARGETS) break; this.transcripts.delete(id) }
  }
  /**
   * Give a known agent its model on every row that already shows it, so the roster updates in place
   * rather than gaining a row. Each row keeps its own view of the agent; only the model changes.
   */
  private patchModel(previous: readonly AgentActivity[], rows: AgentActivity[], id: string, model: string, keys: { tool?: string | undefined; task?: string | undefined } = {}): void {
    for (const [map, key] of [[this.agentsByTool, keys.tool], [this.agentsByTask, keys.task]] as const) {
      const known = key ? map.get(key) : undefined
      if (key && known?.id === id) map.set(key, compactAgentIdentity({ ...known, model }))
    }
    for (const row of previous) {
      if (row.agents?.some(agent => agent.id === id)) rows.push({ ...row, agents: row.agents.map(agent => agent.id === id ? { ...agent, model } : agent) })
    }
  }
}
