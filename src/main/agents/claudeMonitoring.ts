import { randomUUID } from 'node:crypto'
import { MAX_AGENT_MONITORS, MAX_BACKGROUND_WORK, MAX_MONITOR_LABEL, type AgentBackgroundWork, type AgentMonitoringTask,
  type BackgroundWorkType } from '../../shared/agentMonitoring'
import { object, type ClaudeFrame } from './claudeProtocol'

const monitorTypes = new Set(['monitor', 'monitor_mcp'])
/**
 * Claude's own task types for agent work, read off the CLI's `task_started` emitter (`task_type: e.type`).
 * A workflow's discriminant is `local_workflow`; `workflow` is the friendly label the SDK's task summaries
 * use, accepted too so a CLI that emits either is read the same. Shells, plans, dreams and scheduled
 * tasks are not agent work and stay inert.
 */
const workTypes = new Map<string, BackgroundWorkType>([
  ['local_workflow', 'workflow'], ['workflow', 'workflow'], ['local_agent', 'subagent'],
  ['in_process_teammate', 'teammate'], ['remote_agent', 'remote-agent'],
])
const workLabels: Record<BackgroundWorkType, string> = { workflow: 'Workflow', subagent: 'Subagent', teammate: 'Teammate', 'remote-agent': 'Remote agent' }
const endedStatuses = new Set(['completed', 'failed', 'killed', 'stopped', 'cancelled', 'interrupted'])
const label = (value: unknown): string | undefined => typeof value === 'string'
  ? value.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, MAX_MONITOR_LABEL) || undefined : undefined

interface Task {
  readonly id: string
  label: string
  /** Absent for a watch; the kind of agent work otherwise. */
  readonly work: BackgroundWorkType | undefined
  active: boolean
  /** A subagent the spawning tool call is blocking on is the turn's own action, not background work, until it is moved there. */
  foreground: boolean
}

/**
 * Native stream only. A transcript replay must never manufacture a live watch or live background work.
 * Both are kept here because they share the same evidence: root-owned task frames and their bookends.
 */
export class ClaudeMonitoring {
  private readonly tasks = new Map<string, Task>()
  private readonly toolOwners = new Map<string, 'root' | 'nested'>()

  get current(): AgentMonitoringTask[] {
    return [...this.tasks.values()].filter(task => task.active && !task.work).map(task => ({ id: task.id, label: task.label }))
  }

  /** Background work survives the turn's `result`; only its own bookend, an interrupt, an error or a restart ends it. */
  get working(): AgentBackgroundWork[] {
    return [...this.tasks.values()].flatMap(task => task.work && task.active && !task.foreground ? [{ id: task.id, label: task.label, type: task.work }] : [])
  }

  apply(frame: ClaudeFrame): void {
    // Task starts can omit their parent. Keep bounded launch evidence for both root and nested tools;
    // an evicted or unseen linked tool stays unknown, while fresh root launches remain observable.
    const nestedFrame = !!frame.parent_tool_use_id || frame.isSidechain === true
    const content = object(frame.message)?.content
    const block = object(object(frame.event)?.content_block)
    for (const value of [...(Array.isArray(content) ? content : []), block]) {
      const tool = object(value)
      if (typeof tool?.id === 'string' && tool.id.length > 0 && tool.id.length <= 512
        && ['tool_use', 'server_tool_use', 'mcp_tool_use'].includes(String(tool.type))) {
        const owner = nestedFrame || this.toolOwners.get(tool.id) === 'nested' ? 'nested' : 'root'
        this.toolOwners.delete(tool.id)
        this.toolOwners.set(tool.id, owner)
        if (this.toolOwners.size > 4_096) this.toolOwners.delete(this.toolOwners.keys().next().value!)
      }
    }
    if (frame.type !== 'system' || typeof frame.task_id !== 'string' || !frame.task_id || frame.task_id.length > 512) return
    const taskId = frame.task_id
    const patch = object(frame.patch)
    const status = frame.subtype === 'task_updated' ? patch?.status : frame.status
    if (frame.subtype === 'task_notification' || endedStatuses.has(String(status))
      || frame.subtype === 'task_updated' && typeof patch?.end_time === 'number' && Number.isFinite(patch.end_time)) {
      this.tasks.delete(taskId); return
    }
    if (frame.subtype === 'task_started') {
      const type = String(frame.task_type)
      const work = workTypes.get(type)
      // A subagent's own agents are its business: the CLI marks some of them outright, and a spawn deeper
      // than the first is an agent started by an agent rather than by this thread. Watches keep the rules
      // they had before background work existed; these two marks only narrow agent work.
      const nestedOrUnknown = nestedFrame
        || !!work && (frame.owned_by_subagent === true || typeof frame.spawn_depth === 'number' && frame.spawn_depth > 1)
        || frame.tool_use_id !== undefined && frame.tool_use_id !== null
          && (typeof frame.tool_use_id !== 'string' || this.toolOwners.get(frame.tool_use_id) !== 'root')
      if (!monitorTypes.has(type) && !work || nestedOrUnknown || frame.ambient === true || frame.skip_transcript === true) {
        this.tasks.delete(taskId); return
      }
      const previous = this.tasks.get(taskId)
      const kept = [...this.tasks.values()].filter(task => !task.work === !work).length
      if (!previous && kept >= (work ? MAX_BACKGROUND_WORK : MAX_AGENT_MONITORS)) return
      this.tasks.set(taskId, {
        id: previous?.id ?? randomUUID(), work,
        label: label(frame.description) ?? (work ? workLabels[work] : 'Background process'),
        active: status === undefined || status === 'running',
        foreground: frame.is_backgrounded === false,
      })
      return
    }
    const task = this.tasks.get(taskId)
    if (!task || !['task_updated', 'task_progress'].includes(String(frame.subtype))) return
    // Metadata and progress cannot restart a paused or completed watch.
    if (status !== undefined) task.active = status === 'running'
    // Ctrl+B, or the SDK's own request, moves a blocking subagent to the background; nothing moves it back.
    if (frame.subtype === 'task_updated' && patch?.is_backgrounded === true) task.foreground = false
    const description = label(frame.subtype === 'task_updated' ? patch?.description : frame.description)
    if (description) task.label = description
  }
}
