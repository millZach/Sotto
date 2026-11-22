import { randomUUID } from 'node:crypto'
import { BACKGROUND_WORK_LABELS, MAX_BACKGROUND_WORK, MAX_MONITOR_LABEL, type AgentBackgroundWork } from '../../shared/agentMonitoring'
import type { AntigravityToolSignal } from './antigravityActivity'
import type { AntigravityStdioServer } from './antigravityUserServers'
import type { ChildProcessRow } from './detachedRunScan'

interface TrackedTask {
  readonly id: string
  readonly activityId: string
  readonly toolCallId: string
  type: 'command' | 'subagent' | 'workflow'
  label: string
  startedAt: string
  turnKey: string
  touchedAtTurn: string
  nativeTaskId?: string
  inFlight: boolean
  heuristic: boolean
  outlived: boolean
  sawProcess: boolean
}

const SHELL_NAMES = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'fish', 'cmd', 'pwsh', 'powershell'])

const normalizeProgram = (value: string): string => value.replace(/\\/gu, '/').split('/').pop()?.replace(/\.(?:exe|cmd|bat)$/iu, '').toLowerCase() ?? ''
const programLabel = (executable: string | undefined): string | undefined => executable ? executable.replace(/\\/gu, '/').split('/').pop()?.replace(/\.exe$/iu, '') : undefined

export function sanitizeAntigravityWorkLabel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  return value.split(/\r?\n/u)[0]!.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, MAX_MONITOR_LABEL) || undefined
}

/**
 * Formats an OS child command line started by Antigravity into a concise label, unwrapping shell `-c` / `-Command` / `/c`
 * invocations when the script itself is passed as one argument, and returning only the program name once expanded so
 * secrets in child arguments never reach logs or UI state.
 */
export function antigravityCommandWords(argv: readonly string[]): string {
  if (!argv.length) return BACKGROUND_WORK_LABELS.command
  const program = normalizeProgram(argv[0] ?? '')
  if (SHELL_NAMES.has(program)) {
    for (let index = 1; index < argv.length - 1; index++) {
      const flag = argv[index]!.toLowerCase()
      if ((flag === '-c' || flag === '-lc' || flag === '-lic' || flag === '/c' || flag === '-command') && argv[index + 1]) {
        return sanitizeAntigravityWorkLabel(argv[index + 1]) ?? BACKGROUND_WORK_LABELS.command
      }
    }
  }
  return sanitizeAntigravityWorkLabel(programLabel(argv[0])) ?? BACKGROUND_WORK_LABELS.command
}

/**
 * Whether an OS child process matches one of the thread's configured local stdio MCP servers (`antigravityUserServers.ts`),
 * which live alongside the session rather than as background shell commands.
 */
export function isAntigravityStdioServerChild(row: ChildProcessRow, servers: readonly AntigravityStdioServer[]): boolean {
  if (!row.argv.length || !servers.length) return false
  const rowProgram = normalizeProgram(row.argv[0] ?? '')
  if (!rowProgram) return false
  return servers.some(server => {
    const serverProgram = normalizeProgram(server.command)
    if (!serverProgram) return false
    const matchesDirect = rowProgram === serverProgram
    const matchesWrapped = SHELL_NAMES.has(rowProgram) && row.argv.some(arg => normalizeProgram(arg) === serverProgram || arg === server.command)
    if (!matchesDirect && !matchesWrapped) return false
    return server.args.every(arg => row.argv.includes(arg))
  })
}

/** Returns the background-command label for a child of `agy`, or `undefined` if it is a known stdio MCP server. */
export function antigravityBackgroundCommand(servers: readonly AntigravityStdioServer[], row: ChildProcessRow): string | undefined {
  if (!row.argv.length || isAntigravityStdioServerChild(row, servers)) return undefined
  return antigravityCommandWords(row.argv)
}

/**
 * Tracks Antigravity ACP tool-call background work that `BackgroundCommandWatch` (OS child processes) or `ChildWatch`
 * (detached SQLite subagents) may not immediately observe or cannot observe in-process (e.g., async `run_command`,
 * still-running tool calls when `session/prompt` closes, `schedule` timers, or `run_workflow` launches).
 */
export class AntigravityBackgroundTasks {
  private readonly tasks = new Map<string, TrackedTask>()

  get hasAny(): boolean { return this.tasks.size > 0 }

  isToolActive(activityId: string): boolean {
    for (const task of this.tasks.values()) {
      if (task.activityId === activityId && task.inFlight) return true
    }
    return false
  }

  observe(signal: AntigravityToolSignal, turnKey: string): boolean {
    let changed = false
    if (signal.killTaskId) {
      if (this.deleteByNativeTaskId(signal.killTaskId)) changed = true
    }
    if (signal.statusQueryFinished && signal.nativeTaskId) {
      if (this.deleteByNativeTaskId(signal.nativeTaskId)) changed = true
    }

    const existing = this.tasks.get(signal.toolCallId)
    if (signal.status === 'running') {
      const label = sanitizeAntigravityWorkLabel(signal.label) ?? existing?.label ?? BACKGROUND_WORK_LABELS[signal.type]
      if (!existing) {
        if (this.tasks.size >= MAX_BACKGROUND_WORK) return changed
        this.tasks.set(signal.toolCallId, {
          id: randomUUID(),
          activityId: signal.activityId,
          toolCallId: signal.toolCallId,
          type: signal.type,
          label,
          startedAt: new Date().toISOString(),
          turnKey,
          touchedAtTurn: turnKey,
          ...(signal.nativeTaskId ? { nativeTaskId: signal.nativeTaskId } : {}),
          inFlight: true,
          heuristic: false,
          outlived: false,
          sawProcess: false,
        })
        return true
      }
      if (existing.type !== signal.type || existing.label !== label || !existing.inFlight || existing.nativeTaskId !== (signal.nativeTaskId ?? existing.nativeTaskId)) {
        changed = true
      }
      existing.type = signal.type
      existing.label = label
      existing.inFlight = true
      existing.heuristic = false
      existing.touchedAtTurn = turnKey
      if (signal.nativeTaskId) existing.nativeTaskId = signal.nativeTaskId
      return changed
    }

    if (signal.isSubagent) {
      if (existing && this.tasks.delete(signal.toolCallId)) changed = true
      return changed
    }

    if (signal.status === 'failed' || signal.status === 'interrupted') {
      if (existing && this.tasks.delete(signal.toolCallId)) changed = true
      if (signal.nativeTaskId && this.deleteByNativeTaskId(signal.nativeTaskId)) changed = true
      return changed
    }

    if (signal.status === 'completed') {
      if (signal.backgroundLaunch) {
        const label = sanitizeAntigravityWorkLabel(signal.label) ?? existing?.label ?? BACKGROUND_WORK_LABELS[signal.type]
        if (!existing) {
          if (this.tasks.size >= MAX_BACKGROUND_WORK) return changed
          this.tasks.set(signal.toolCallId, {
            id: randomUUID(),
            activityId: signal.activityId,
            toolCallId: signal.toolCallId,
            type: signal.type,
            label,
            startedAt: new Date().toISOString(),
            turnKey,
            touchedAtTurn: turnKey,
            ...(signal.nativeTaskId ? { nativeTaskId: signal.nativeTaskId } : {}),
            inFlight: false,
            heuristic: signal.heuristic,
            outlived: true,
            sawProcess: false,
          })
          return true
        }
        if (existing.inFlight || !existing.outlived || !existing.heuristic !== !signal.heuristic || existing.label !== label || existing.type !== signal.type) changed = true
        existing.inFlight = false
        existing.heuristic = signal.heuristic
        existing.outlived = true
        existing.label = label
        existing.type = signal.type
        existing.touchedAtTurn = turnKey
        if (signal.nativeTaskId) existing.nativeTaskId = signal.nativeTaskId
        return changed
      }
      if (existing && this.tasks.delete(signal.toolCallId)) changed = true
      if (signal.statusQueryRunning && signal.nativeTaskId) {
        for (const task of this.tasks.values()) {
          if (task.nativeTaskId === signal.nativeTaskId) task.touchedAtTurn = turnKey
        }
      }
    }
    return changed
  }

  /** Reconciles tracked tasks when a turn ends, marking still-running calls outlived and pruning resolved heuristic commands. */
  turnEnded(turnKey: string, reactive: boolean, liveProcessCommands: boolean): boolean {
    let changed = false
    for (const [toolCallId, task] of this.tasks) {
      if (task.inFlight && !task.outlived) {
        task.outlived = true
        changed = true
      }
      if (task.type === 'command' && task.heuristic) {
        if (liveProcessCommands) {
          task.sawProcess = true
        } else if (task.sawProcess) {
          this.tasks.delete(toolCallId)
          changed = true
          continue
        }
      }
      if (reactive && !task.inFlight && task.heuristic && task.turnKey !== turnKey && task.touchedAtTurn !== turnKey) {
        this.tasks.delete(toolCallId)
        changed = true
      }
    }
    return changed
  }

  clear(): boolean {
    if (!this.tasks.size) return false
    this.tasks.clear()
    return true
  }

  /** Returns active background work items, suppressing foreground in-flight calls and duplicate OS-tracked commands. */
  working(activeSubagentToolCalls: ReadonlySet<string>, liveProcessCommands: boolean, turnRunning: boolean): AgentBackgroundWork[] {
    const items: AgentBackgroundWork[] = []
    for (const [toolCallId, task] of [...this.tasks]) {
      if (activeSubagentToolCalls.has(toolCallId)) continue
      if (turnRunning && !task.outlived) continue
      if (task.type === 'command' && task.heuristic) {
        if (liveProcessCommands) {
          task.sawProcess = true
          continue
        }
        if (task.sawProcess) {
          this.tasks.delete(toolCallId)
          continue
        }
      }
      items.push({ id: task.id, label: task.label, type: task.type, startedAt: task.startedAt })
    }
    return items
  }

  private deleteByNativeTaskId(nativeTaskId: string): boolean {
    let removed = false
    for (const [key, task] of this.tasks) {
      if (task.nativeTaskId === nativeTaskId) {
        this.tasks.delete(key)
        removed = true
      }
    }
    return removed
  }
}

export function mergeAntigravityBackgroundWork(items: readonly AgentBackgroundWork[]): AgentBackgroundWork[] {
  const seen = new Set<string>()
  const merged: AgentBackgroundWork[] = []
  for (const item of items) {
    if (seen.has(item.id)) continue
    seen.add(item.id)
    merged.push(item)
    if (merged.length >= MAX_BACKGROUND_WORK) break
  }
  return merged
}
