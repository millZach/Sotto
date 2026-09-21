import { randomUUID } from 'node:crypto'
import { MAX_AGENT_MONITORS, MAX_MONITOR_LABEL, type AgentMonitoringTask } from '../../shared/agentMonitoring'
import { object, type ClaudeFrame } from './claudeProtocol'

const monitorTypes = new Set(['monitor', 'monitor_mcp'])
const endedStatuses = new Set(['completed', 'failed', 'killed', 'stopped', 'cancelled', 'interrupted'])
const label = (value: unknown): string | undefined => typeof value === 'string'
  ? value.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, MAX_MONITOR_LABEL) || undefined : undefined

/** Native stream only. A transcript replay must never manufacture a live watch. */
export class ClaudeMonitoring {
  private readonly tasks = new Map<string, { monitor: AgentMonitoringTask; active: boolean }>()
  private readonly toolOwners = new Map<string, 'root' | 'nested'>()

  get current(): AgentMonitoringTask[] { return [...this.tasks.values()].filter(task => task.active).map(task => ({ ...task.monitor })) }

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
      const nestedOrUnknown = nestedFrame
        || frame.tool_use_id !== undefined && frame.tool_use_id !== null
          && (typeof frame.tool_use_id !== 'string' || this.toolOwners.get(frame.tool_use_id) !== 'root')
      if (!monitorTypes.has(String(frame.task_type)) || nestedOrUnknown || frame.ambient === true || frame.skip_transcript === true) {
        this.tasks.delete(taskId); return
      }
      if (!this.tasks.has(taskId) && this.tasks.size >= MAX_AGENT_MONITORS) return
      this.tasks.set(taskId, { monitor: { id: this.tasks.get(taskId)?.monitor.id ?? randomUUID(), label: label(frame.description) ?? 'Background process' },
        active: status === undefined || status === 'running' })
      return
    }
    const task = this.tasks.get(taskId)
    if (!task || !['task_updated', 'task_progress'].includes(String(frame.subtype))) return
    // Metadata and progress cannot restart a paused or completed watch.
    if (status !== undefined) task.active = status === 'running'
    const description = label(frame.subtype === 'task_updated' ? patch?.description : frame.description)
    if (description) task.monitor.label = description
  }
}
