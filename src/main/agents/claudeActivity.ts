import { createHash } from 'node:crypto'
import { MAX_ACTIVITY_TEXT, compactAgentIdentity, isTerminalActivity, mergeAgentActivities, planSteps, type AgentActivity, type ObservedAgent, type WorkflowProgress } from '../../shared/agentActivity'
import { observedSubagentStatus } from '../../shared/subagents'
import { object, type ClaudeFrame } from './claudeProtocol'
import { claudeText } from './claudeSessionLog'
import { ClaudeThinking, THINKING_BLOCKS, claudeThinkingId, claudeThinkingRow } from './claudeThinking'
import { thinkingSettledAs } from './thinkingActivity'
import { CLAUDE_TRANSCRIPT_ID, type ClaudeModelTarget, type ClaudeSubagentTranscript } from './claudeSubagentModels'

const text = (value: unknown): string | undefined => typeof value === 'string' ? value.slice(0, MAX_ACTIVITY_TEXT) : undefined
const agentAliasId = (id: string): string => `claude-agent-alias-${createHash('sha256').update(id).digest('hex')}`
const json = (value: unknown): string | undefined => value === undefined ? undefined : JSON.stringify(value).slice(0, MAX_ACTIVITY_TEXT)
/** Agents whose own transcript may still name their model; the oldest gives way past this. */
const MAX_TRANSCRIPT_TARGETS = 64
/** The tool call and task an agent is known by, either of which may be missing. */
type AgentKeys = { tool?: string | undefined; task?: string | undefined }
/** An activity row holds at most 200 agents: the workflow's own and this many of its agents. */
const MAX_WORKFLOW_AGENTS = 199
const iso = (value: unknown): string | undefined => typeof value === 'number' && Number.isFinite(value) && value > 0 ? new Date(value).toISOString() : undefined

/**
 * One of a workflow's agents from its `workflow_progress` entry (Claude Code 2.1.280: `type: "workflow_agent"`,
 * `index`, `label`, `agentId`, `model`, `state` of start, progress, done or error, `startedAt` and `durationMs` in
 * milliseconds, `promptPreview`, `resultPreview`, `error`, `attempt`). Its row is keyed by its index, which the entry has
 * from the moment the agent is queued; `agentId` comes only once it starts, and a retry gets a new one. A retry is a
 * new assignment of the same row, so it reads as working again (Run 2) rather than keeping the failed attempt.
 */
function workflowAgent(entry: Record<string, unknown>, workflow: ObservedAgent, known: ObservedAgent | undefined, observedAt: string | undefined): ObservedAgent | undefined {
  if (entry.type !== 'workflow_agent' || typeof entry.index !== 'number' || !Number.isInteger(entry.index) || entry.index < 0) return undefined
  const id = `${workflow.id}:agent-${entry.index}`
  const attempt = typeof entry.attempt === 'number' && Number.isInteger(entry.attempt) && entry.attempt > 1 ? entry.attempt : undefined
  const assignmentId = `${workflow.assignmentId ?? workflow.id}:agent-${entry.index}${attempt ? `:attempt-${attempt}` : ''}`
  // An earlier attempt's result, times and finish belong to that attempt; its label and model carry over.
  if (known && known.assignmentId !== assignmentId) known = { id: known.id, status: 'running', ...(known.title ? { title: known.title } : {}), ...(known.model ? { model: known.model } : {}) }
  const status = entry.state === 'done' ? 'completed' : entry.state === 'error' ? entry.skipped === true ? 'interrupted' : 'failed'
    : entry.state === 'start' || entry.state === 'progress' ? 'running' : known?.status ?? 'running'
  const label = text(entry.label)?.replace(/\s+/gu, ' ').trim()
  const prompt = text(entry.promptPreview)
  const result = status === 'failed' ? text(entry.error) ?? text(object(entry.error)?.message) ?? text(entry.resultPreview) : text(entry.resultPreview)
  const model = text(entry.model)
  const startedAt = iso(entry.startedAt) ?? known?.startedAt
  const durationMs = typeof entry.durationMs === 'number' && Number.isFinite(entry.durationMs) && entry.durationMs >= 0 ? entry.durationMs : known?.durationMs
  const completedAt = status !== 'running' ? known?.completedAt ?? (startedAt && durationMs !== undefined ? new Date(Date.parse(startedAt) + durationMs).toISOString() : observedAt) : undefined
  return { ...known, id, assignmentId, parentId: workflow.id, status,
    ...(label ? { title: label } : {}), ...(prompt ? { prompt } : {}), ...(result ? { message: result } : {}),
    // The latest model named is the one it ran on: a resolved name replaces the launch's alias.
    ...(model && model !== '<synthetic>' ? { model: model.slice(0, 512) } : {}),
    ...(startedAt ? { startedAt, timingSource: 'provider' as const } : {}), ...(durationMs !== undefined ? { durationMs } : {}),
    ...(completedAt ? { completedAt } : {}), ...(observedAt ? { observedAt } : {}) }
}

/** How far a workflow's agents have got, as its row's count and strip show it. */
function workflowProgress(agents: readonly ObservedAgent[], queued: number): WorkflowProgress {
  const progress: WorkflowProgress = { total: agents.length + queued, working: 0, completed: 0, failed: 0, interrupted: 0, ...(queued ? { queued } : {}) }
  for (const agent of agents) {
    const status = observedSubagentStatus(agent.status)
    progress[status === 'running' || status === 'unknown' ? 'working' : status]++
  }
  return progress
}

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
  private readonly transcripts = new Map<string, { transcript: ClaudeSubagentTranscript } & AgentKeys>()
  /** A workflow's agents by observed id, so a model read from one's transcript finds it. */
  private readonly workflowMembers = new Map<string, ObservedAgent>()
  /** How many of each workflow's agents are waiting for a place to start, by the workflow's observed id. */
  private readonly queuedAgents = new Map<string, number>()
  private readonly thinking = new ClaudeThinking()
  constructor(private readonly readActivity?: (activityId: string) => AgentActivity | undefined) {}
  /** The CLI ended. A thinking block it left open gets nothing more, so its row stops running now. */
  runtimeEnded(previous: AgentActivity[] | undefined): AgentActivity[] | undefined {
    const rows = this.thinking.ended(new Date().toISOString())
    return rows.length ? mergeAgentActivities(previous ?? [], rows) : previous
  }
  apply(previous: AgentActivity[], frame: ClaudeFrame, turnId: string, afterMessageId: string | undefined, cwd: string, live = false): AgentActivity[] {
    const rows: AgentActivity[] = []
    const observedAt = typeof frame.timestamp === 'string' && Number.isFinite(Date.parse(frame.timestamp))
      ? new Date(frame.timestamp).toISOString() : live ? new Date().toISOString() : undefined
    const parentTool = typeof frame.parent_tool_use_id === 'string' ? frame.parent_tool_use_id : undefined
    // Claude Code files its own error notices from a `<synthetic>` model. That is not what the agent ran on,
    // and taking it would outrank the launch's resolved model and stop the subagent transcript read.
    const replyModel = text(object(frame.message)?.model)
    const model = replyModel === '<synthetic>' ? undefined : replyModel
    if (parentTool && model) {
      this.pendingModels.set(parentTool, model.slice(0, 512))
      const prior = this.agentsByTool.get(parentTool)
      if (prior) {
        const agent = { ...prior, model, ...(observedAt ? { observedAt } : {}) }
        this.agentsByTool.set(parentTool, compactAgentIdentity(agent))
        const task = this.taskByTool.get(parentTool)
        if (task) this.agentsByTask.set(task, compactAgentIdentity(agent))
        const old = previous.findLast(row => row.agents?.some(child => child.id === agent.id))
        // Only this agent changes; a row that shows others (a workflow's) keeps them.
        rows.push(old ? { ...old, agents: old.agents!.map(child => child.id === agent.id ? agent : child) }
          : { id: `claude-agent-model-${parentTool}`, turnId, sequence: 0, kind: 'subagent', title: agent.title ?? 'Subagent', status: 'unknown', agents: [agent] })
      }
    }
    // A live stream frame carries no timestamp of its own, so the moment Sotto received it is the only
    // start there is; `observedAt` already prefers the provider's own time where a replayed frame has one.
    // Replay without a timestamp still records nothing, because a transcript must not be given a clock
    // it never had. Codex has timed its running rows this way since `codexActivity` was written.
    // `place` is where and when a row sits; `base` adds the folder its work ran in, which thinking has none of.
    const place = { turnId, sequence: 0, ...(afterMessageId ? { afterMessageId } : {}),
      ...(observedAt ? { startedAt: observedAt, timingSource: typeof frame.timestamp === 'string' ? ('provider' as const) : ('observed' as const) } : {}),
      ...(typeof frame.parent_tool_use_id === 'string' ? { parentId: `claude-tool-${frame.parent_tool_use_id}` } : {}) }
    const base = { ...place, cwd }
    const replyId = typeof object(frame.message)?.id === 'string' ? object(frame.message)!.id as string : undefined
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
    if (Array.isArray(blocks)) for (const [position, value] of blocks.entries()) {
      const block = object(value); if (!block) continue
      if (['tool_use', 'server_tool_use', 'mcp_tool_use'].includes(String(block.type))) tool(block)
      if (THINKING_BLOCKS.has(String(block.type)) && replyId) {
        // A transcript line names the block's place in its reply (`apiBlockIndex`), the same index the stream
        // started it under, so a replayed block lands on the row the live one made. A live frame carries no index,
        // and a block the stream already showed needs nothing more from it.
        const index = typeof frame.apiBlockIndex === 'number' && blocks.length === 1 ? frame.apiBlockIndex : position
        if (!(live && typeof frame.apiBlockIndex !== 'number' && this.thinking.showed(replyId))) {
          const words = typeof block.thinking === 'string' ? block.thinking : ''
          const durationMs = typeof frame.thinkingDurationMs === 'number' && Number.isFinite(frame.thinkingDurationMs) && frame.thinkingDurationMs >= 0 ? frame.thinkingDurationMs : undefined
          // The line is written when the block ends, so its own time is the end and the reported duration gives the start.
          const timed = durationMs !== undefined && observedAt && typeof frame.timestamp === 'string'
            ? { startedAt: new Date(Date.parse(observedAt) - durationMs).toISOString(), completedAt: observedAt, timingSource: 'provider' as const, durationMs } : {}
          rows.push(claudeThinkingRow(place, claudeThinkingId(replyId, index), 'completed', words, timed))
        }
      }
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
          // A background launch names the agent's own transcript by its agent id. A workflow's launch names its
          // run, whose folder holds each of its agents' transcripts; those are watched per agent.
          if (typeof launch?.agentId === 'string') this.watchTranscript(child, { agentId: launch.agentId }, block.tool_use_id, task)
        }
        // A result ends the subagent's stream, and with it any thinking it left open, unless the launch only
        // acknowledged a subagent that runs on in the background.
        if (launch?.isAsync === true) this.thinking.detached(block.tool_use_id)
        else rows.push(...this.thinking.streamEnded(block.tool_use_id, block.is_error === true ? 'interrupted' : 'completed', observedAt))
        rows.push({ ...base, ...old, id: `claude-tool-${block.tool_use_id}`, kind: old?.kind ?? 'tool', title: old?.title ?? 'Tool result',
          ...(child ? { agents: [child] } : {}),
          status: block.is_error === true ? 'failed' : 'completed', startedAt: old?.startedAt, output: text(claudeText(block.content)) ?? '',
          ...(claudeText(block.content).length > MAX_ACTIVITY_TEXT ? { truncated: true } : {}),
          ...(Number.isInteger(result?.exitCode ?? result?.exit_code) ? { exitCode: (result?.exitCode ?? result?.exit_code) as number } : {}),
          ...(base.startedAt ? { completedAt: base.startedAt } : {}) })
      }
    }
    if (frame.type === 'stream_event') {
      const stream = parentTool ?? 'main'
      const event = object(frame.event); const key = `${stream}:${event?.index}`
      const block = object(event?.content_block)
      const reply = event?.type === 'message_start' ? object(event.message)?.id : undefined
      if (typeof reply === 'string') rows.push(...this.thinking.replyStarted(stream, reply, observedAt))
      if (event?.type === 'content_block_start' && block && ['tool_use', 'server_tool_use', 'mcp_tool_use'].includes(String(block.type))) {
        this.blocks.set(key, { block, input: '' }); tool(block)
      }
      // Thinking shows from its first byte: the row starts with the block and grows with each delta. A redacted
      // block, or one the model sends no words for, still shows the row. Its signature is not reply content.
      if (event?.type === 'content_block_start' && block && THINKING_BLOCKS.has(String(block.type)) && typeof event.index === 'number') {
        rows.push(...this.thinking.started(stream, event.index, block.thinking, place))
      }
      const partial = this.blocks.get(key); const delta = object(event?.delta)
      if (partial && event?.type === 'content_block_delta' && delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
        partial.input = (partial.input + delta.partial_json).slice(0, MAX_ACTIVITY_TEXT)
        try { tool({ ...partial.block, input: JSON.parse(partial.input) }) } catch { /* Incomplete JSON is not tool input yet. */ }
      }
      if (event?.type === 'content_block_delta' && delta?.type === 'thinking_delta' && typeof delta.thinking === 'string' && typeof event.index === 'number') {
        rows.push(...this.thinking.grew(stream, event.index, delta.thinking))
      }
      if (event?.type === 'content_block_stop') {
        this.blocks.delete(key)
        if (typeof event.index === 'number') rows.push(...this.thinking.stopped(stream, event.index, observedAt))
      }
    }
    // A turn that ends with a block still open (stopped mid-thought) settles its row, and those of subagents it ran in the foreground.
    if (frame.type === 'result' && !parentTool) rows.push(...this.thinking.turnEnded(frame.is_error === true ? 'failed' : 'completed', observedAt))
    if (frame.type === 'system' && ['task_started', 'task_progress', 'task_notification'].includes(String(frame.subtype)) && typeof frame.task_id === 'string') {
      const status = frame.subtype === 'task_notification' ? frame.status === 'completed' ? 'completed' : frame.status === 'failed' ? 'failed' : ['stopped', 'cancelled', 'canceled', 'killed', 'interrupted'].includes(String(frame.status)) ? 'interrupted' : 'unknown' : 'running'
      // A task that ended ends the stream of the subagent it ran, whatever else this notification is kept from changing.
      const ending = frame.subtype === 'task_notification' ? typeof frame.tool_use_id === 'string' ? frame.tool_use_id : this.toolByTask.get(frame.task_id) : undefined
      if (ending) rows.push(...this.thinking.streamEnded(ending, thinkingSettledAs(status), observedAt))
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
      // A workflow's progress frames describe whichever of its agents reported last, so only its start names it.
      const workflow = frame.task_type === 'local_workflow' || prior?.kind === 'workflow' || old?.agents?.[0]?.kind === 'workflow'
      const named = taskDescription && (!workflow || frame.subtype === 'task_started')
      const workflowName = workflow && frame.subtype === 'task_started' ? text(frame.workflow_name) : undefined
      // No CLI up to 2.1.280 names a model on the task itself. A workflow's agents name their own, on their own rows.
      const taskModel = text(frame.model)
      const child: ObservedAgent = { ...prior, id: prior?.id ?? (toolId ? `claude-agent-${toolId}` : `claude-agent-task-${frame.task_id}`), assignmentId: prior?.assignmentId ?? `claude-task-${frame.task_id}`, status,
        ...(workflow ? { kind: 'workflow' as const } : {}),
        ...(named ? workflow ? { title: taskDescription, prompt: taskDescription, ...(workflowName ? { description: workflowName } : {}) } : { title: taskDescription, description: taskDescription } : {}),
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
      const run = toolId ? this.runsByTool.get(toolId) : undefined
      const agents = workflow ? this.workflowAgents(child, old?.agents?.slice(1) ?? [], frame, observedAt, run) : []
      if (workflow) child.progress = workflowProgress(agents, this.queuedAgents.get(child.id) ?? 0)
      this.agentsByTask.set(frame.task_id, compactAgentIdentity(child))
      if (toolId) {
        this.agentsByTool.set(toolId, compactAgentIdentity(child))
        this.taskByTool.set(toolId, frame.task_id)
        this.toolByTask.set(frame.task_id, toolId)
      }
      // A spawned agent's task id is its native agent id, which names its transcript file. A workflow's
      // agents each name their own file under the run's folder, watched as their progress names them.
      if (frame.subtype === 'task_started' && frame.task_type === 'local_agent') this.watchTranscript(child, { agentId: frame.task_id }, toolId, frame.task_id)
      rows.push({ ...base, ...old, id: `claude-task-${frame.task_id}`, kind: 'subagent', status, ...(frame.subtype === 'task_notification' ? { taskUpdatesExcluded: true } : frame.subtype === 'task_started' && old ? { taskUpdatesExcluded: false } : {}),
        title: (workflow && frame.subtype !== 'task_started' ? prior?.title ?? old?.title : undefined) ?? text(frame.description) ?? old?.title ?? 'Subagent',
        ...(typeof frame.tool_use_id === 'string' ? { parentId: `claude-tool-${frame.tool_use_id}` } : {}),
        ...(text(frame.summary ?? frame.last_tool_name) ? { text: text(frame.summary ?? frame.last_tool_name) } : {}),
        agents: [child, ...agents] })
    }
    return mergeAgentActivities(previous, rows)
  }
  /**
   * A workflow's agents after this frame. Each progress frame lists every agent the run has queued; one without
   * the list (Claude Code throttles them) keeps the agents already known. An agent still waiting for a place to start
   * (`state: "start"` with no `startedAt`, or no state while rate limited) is counted, not shown, until it starts.
   * The workflow's own notification settles any agent still working, since no later frame will report it: finished
   * when the run completed, interrupted otherwise, so a failed run does not count agents it never heard from as failed.
   */
  private workflowAgents(workflow: ObservedAgent, known: readonly ObservedAgent[], frame: ClaudeFrame, observedAt: string | undefined, run: string | undefined): ObservedAgent[] {
    const agents = new Map(known.filter(agent => agent.parentId === workflow.id).map(agent => [agent.id, agent]))
    if (Array.isArray(frame.workflow_progress)) {
      let queued = 0
      for (const value of frame.workflow_progress) {
        const entry = object(value)
        if (entry?.type !== 'workflow_agent') continue
        const id = typeof entry.index === 'number' ? `${workflow.id}:agent-${entry.index}` : undefined
        const prior = id ? agents.get(id) ?? this.workflowMembers.get(id) : undefined
        if (!prior && (entry.state === undefined || (entry.state === 'start' && entry.startedAt === undefined))) { queued++; continue }
        const agent = workflowAgent(entry, workflow, prior, observedAt)
        if (!agent) continue
        agents.set(agent.id, agent)
        // An agent the stream names no model for has its own transcript under the run's folder.
        if (!agent.model && run && typeof entry.agentId === 'string') this.watchTranscript(agent, { runId: run, agentId: entry.agentId }, undefined, undefined)
      }
      this.queuedAgents.set(workflow.id, queued)
      for (const id of this.queuedAgents.keys()) { if (this.queuedAgents.size <= MAX_TRANSCRIPT_TARGETS) break; this.queuedAgents.delete(id) }
    }
    const settle = frame.subtype === 'task_notification' && isTerminalActivity(workflow.status as AgentActivity['status'])
    const settled = workflow.status === 'completed' ? 'completed' : 'interrupted'
    const list = [...agents.values()].slice(0, MAX_WORKFLOW_AGENTS).map(agent => settle && observedSubagentStatus(agent.status) === 'running'
      ? { ...agent, status: settled, ...(observedAt ? { completedAt: agent.completedAt ?? observedAt, observedAt } : {}) } : agent)
    // Re-inserting keeps the newest workflow's agents at the end, so the bound drops the oldest.
    for (const agent of list) { this.workflowMembers.delete(agent.id); this.workflowMembers.set(agent.id, compactAgentIdentity(agent)) }
    for (const id of this.workflowMembers.keys()) { if (this.workflowMembers.size <= MAX_TRANSCRIPT_TARGETS * 4) break; this.workflowMembers.delete(id) }
    return list
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
  private current(id: string, entry: AgentKeys): ObservedAgent | undefined {
    const byTask = entry.task ? this.agentsByTask.get(entry.task) : undefined
    const byTool = entry.tool ? this.agentsByTool.get(entry.tool) : undefined
    return byTask?.id === id ? byTask : byTool?.id === id ? byTool : this.workflowMembers.get(id)
  }
  private watchTranscript(agent: ObservedAgent, transcript: ClaudeSubagentTranscript, tool: string | undefined, task: string | undefined): void {
    if (agent.model || !CLAUDE_TRANSCRIPT_ID.test(transcript.agentId) || (transcript.runId !== undefined && !CLAUDE_TRANSCRIPT_ID.test(transcript.runId))) return
    const known = this.transcripts.get(agent.id)
    this.transcripts.delete(agent.id)
    this.transcripts.set(agent.id, { transcript, tool: tool ?? known?.tool, task: task ?? known?.task })
    for (const id of this.transcripts.keys()) { if (this.transcripts.size <= MAX_TRANSCRIPT_TARGETS) break; this.transcripts.delete(id) }
  }
  /**
   * Give a known agent its model on every row that already shows it, so the roster updates in place
   * rather than gaining a row. Each row keeps its own view of the agent; only the model changes.
   */
  private patchModel(previous: readonly AgentActivity[], rows: AgentActivity[], id: string, model: string, keys: AgentKeys = {}): void {
    for (const [map, key] of [[this.agentsByTool, keys.tool], [this.agentsByTask, keys.task]] as const) {
      const known = key ? map.get(key) : undefined
      if (key && known?.id === id) map.set(key, compactAgentIdentity({ ...known, model }))
    }
    const member = this.workflowMembers.get(id)
    if (member) this.workflowMembers.set(id, { ...member, model })
    for (const row of previous) {
      if (row.agents?.some(agent => agent.id === id)) rows.push({ ...row, agents: row.agents.map(agent => agent.id === id ? { ...agent, model } : agent) })
    }
  }
}
