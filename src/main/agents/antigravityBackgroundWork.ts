import { randomUUID } from 'node:crypto'
import { BACKGROUND_WORK_LABELS, MAX_BACKGROUND_WORK, MAX_MONITOR_LABEL, type AgentBackgroundWork } from '../../shared/agentMonitoring'
import type { AntigravityToolSignal } from './antigravityActivity'
import type { AntigravityStdioServer } from './antigravityUserServers'
import { shownCommand, splitCommandLine, type ChildProcessRow } from './detachedRunScan'

interface TrackedTask {
  readonly id: string
  readonly activityId: string
  readonly toolCallId: string
  type: 'command' | 'subagent' | 'workflow'
  isCommand: boolean
  label: string
  startedAt: string
  turnKey: string
  touchedAtTurn: string
  nativeTaskId?: string
  expiresAt?: number
  inFlight: boolean
  heuristic: boolean
  outlived: boolean
  sawProcess: boolean
}

const SHELL_NAMES = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'fish', 'cmd', 'pwsh', 'powershell'])
const INTERPRETER_NAMES = new Set(['node', 'nodejs', 'python', 'python3', 'py', 'bun', 'deno', 'ruby', 'perl', 'env', 'tsx', 'ts-node', 'uv', 'uvx', 'npx', 'npm', 'pnpm', 'yarn', 'bunx'])
const LAUNCHER_NAMES = new Set(['npx', 'uvx', 'pnpm', 'yarn', 'npm', 'bunx'])
const SYSTEM_HELPER_NAMES = new Set(['conhost', 'openconsole', 'werfault'])

const normalizeProgram = (value: string): string => value.replace(/\\/gu, '/').split('/').pop()?.replace(/\.(?:exe|cmd|bat)$/iu, '').toLowerCase() ?? ''
const programLabel = (executable: string | undefined): string | undefined => executable ? executable.replace(/\\/gu, '/').split('/').pop()?.replace(/\.exe$/iu, '') : undefined

export function sanitizeAntigravityWorkLabel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  return value.split(/\r?\n/u)[0]!.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, MAX_MONITOR_LABEL) || undefined
}

/**
 * Formats an OS child command line started by Antigravity into a concise label, redacting credentials in inline shell
 * scripts (`-c` / `-lc` / `-lic` / `-Command` / `/c`) through `shownCommand` and returning only the program basename for
 * direct execs so secrets in child arguments never reach logs or UI state.
 */
export function antigravityCommandWords(argv: readonly string[]): string {
  if (!argv.length) return BACKGROUND_WORK_LABELS.command
  const program = normalizeProgram(argv[0] ?? '')
  if (SHELL_NAMES.has(program)) {
    for (let index = 1; index < argv.length - 1; index++) {
      const flag = argv[index]!.toLowerCase()
      if ((flag === '-c' || flag === '-lc' || flag === '-lic' || flag === '/c' || flag === '-command') && argv[index + 1]) {
        const redacted = shownCommand(splitCommandLine(argv[index + 1]!))
        return sanitizeAntigravityWorkLabel(redacted) ?? BACKGROUND_WORK_LABELS.command
      }
    }
  }
  return sanitizeAntigravityWorkLabel(programLabel(argv[0])) ?? BACKGROUND_WORK_LABELS.command
}

function expandShellTokens(argv: readonly string[]): readonly string[] {
  const rowProgram = normalizeProgram(argv[0] ?? '')
  if (!SHELL_NAMES.has(rowProgram)) return argv
  for (let index = 1; index < argv.length - 1; index++) {
    const flag = argv[index]!.toLowerCase()
    if ((flag === '-c' || flag === '-lc' || flag === '-lic' || flag === '/c' || flag === '-command') && argv[index + 1]) {
      const split = splitCommandLine(argv[index + 1]!)
      return [...argv.slice(0, index + 1), ...split, ...argv.slice(index + 2)]
    }
  }
  return argv
}

function matchesServerProgram(token: string, serverCommand: string, serverProgram: string): boolean {
  const normalized = normalizeProgram(token)
  if (normalized === serverProgram || token === serverCommand) return true
  if (serverProgram === 'npx' && /^npx(?:-cli)?(?:\.[cm]?js)?$/iu.test(normalized)) return true
  if (serverProgram === 'npm' && /^npm(?:-cli)?(?:\.[cm]?js)?$/iu.test(normalized)) return true
  return false
}

/**
 * Whether an OS child process matches one of the thread's configured local stdio MCP servers (`antigravityUserServers.ts`),
 * including interpreter- or shell-wrapped invocations (`node /usr/local/bin/npx -y ...`, `bash -c ...`), which live
 * alongside the session rather than as background shell commands.
 */
export function isAntigravityStdioServerChild(row: ChildProcessRow, servers: readonly AntigravityStdioServer[]): boolean {
  if (!row.argv.length || !servers.length) return false
  const tokens = expandShellTokens(row.argv)
  const rowProgram = normalizeProgram(row.argv[0] ?? '')
  if (!rowProgram) return false
  return servers.some(server => {
    const serverProgram = normalizeProgram(server.command)
    if (!serverProgram) return false
    const matchesDirect = rowProgram === serverProgram
    const wrapper = SHELL_NAMES.has(rowProgram) || INTERPRETER_NAMES.has(rowProgram)
    const matchesWrapped = wrapper && tokens.some(tok => matchesServerProgram(tok, server.command, serverProgram))
    if (matchesDirect || matchesWrapped) {
      return server.args.every(arg => {
        const normalizedArg = arg.replace(/\\/gu, '/')
        return tokens.includes(arg) || tokens.some(tok => tok.replace(/\\/gu, '/') === normalizedArg)
      })
    }
    if (INTERPRETER_NAMES.has(rowProgram) && LAUNCHER_NAMES.has(serverProgram)) {
      const packageArgs = server.args.filter(arg => arg.length > 0 && !arg.startsWith('-'))
      if (packageArgs.length > 0) {
        return packageArgs.every(pkg => {
          const normalizedPkg = pkg.replace(/\\/gu, '/').toLowerCase()
          return tokens.some(tok => {
            const normalizedTok = tok.replace(/\\/gu, '/').toLowerCase()
            return normalizedTok === normalizedPkg
              || normalizedTok.includes(`/${normalizedPkg}/`)
              || normalizedTok.endsWith(`/${normalizedPkg}`)
          })
        })
      }
    }
    return false
  })
}

/** Returns the background-command label for a child of `agy`, or `undefined` if it is a known stdio MCP server or OS console helper. */
export function antigravityBackgroundCommand(servers: readonly AntigravityStdioServer[], row: ChildProcessRow): string | undefined {
  if (!row.argv.length) return undefined
  if (SYSTEM_HELPER_NAMES.has(normalizeProgram(row.argv[0] ?? ''))) return undefined
  if (isAntigravityStdioServerChild(row, servers)) return undefined
  return antigravityCommandWords(row.argv)
}

function commandLabelOverlap(taskLabel: string, liveLabel: string): boolean {
  const a = taskLabel.toLowerCase().trim(), b = liveLabel.toLowerCase().trim()
  if (!a || !b) return false
  if (a === b || a.includes(b) || b.includes(a)) return true
  const firstWordA = a.split(/\s+/u)[0]?.replace(/\.(?:exe|cmd|bat)$/iu, '')
  const firstWordB = b.split(/\s+/u)[0]?.replace(/\.(?:exe|cmd|bat)$/iu, '')
  return Boolean(firstWordA && firstWordB && firstWordA === firstWordB)
}

/**
 * Tracks Antigravity ACP tool-call background work that `BackgroundCommandWatch` (OS child processes) or `ChildWatch`
 * (detached SQLite subagents) may not immediately observe or cannot observe in-process (e.g., async `run_command`,
 * still-running tool calls when `session/prompt` closes, `schedule` timers, or `run_workflow` launches).
 */
export class AntigravityBackgroundTasks {
  private readonly tasks = new Map<string, TrackedTask>()

  constructor(private readonly now: () => number = Date.now) {}

  get hasAny(): boolean { return this.tasks.size > 0 }

  isToolActive(activityId: string): boolean {
    for (const task of this.tasks.values()) {
      if (task.activityId === activityId && task.inFlight) return true
    }
    return false
  }

  isOutlived(toolCallId: string): boolean { return this.tasks.get(toolCallId)?.outlived === true }

  observe(signal: AntigravityToolSignal, turnKey: string): boolean {
    let changed = false
    if (signal.killTaskId && signal.status === 'completed') {
      if (this.deleteByNativeTaskId(signal.killTaskId)) changed = true
    }
    if (signal.statusQueryFinished && signal.nativeTaskId && signal.status === 'completed') {
      if (this.deleteByNativeTaskId(signal.nativeTaskId)) changed = true
    }

    const existing = this.tasks.get(signal.toolCallId)
    if (signal.status === 'running') {
      if (signal.isControlTool) return changed
      if (signal.pending && !signal.heuristic && !existing) return changed
      const label = sanitizeAntigravityWorkLabel(signal.label) ?? existing?.label ?? BACKGROUND_WORK_LABELS[signal.type]
      if (!existing) {
        if (this.tasks.size >= MAX_BACKGROUND_WORK) return changed
        this.tasks.set(signal.toolCallId, {
          id: randomUUID(),
          activityId: signal.activityId,
          toolCallId: signal.toolCallId,
          type: signal.type,
          isCommand: signal.isCommand,
          label,
          startedAt: new Date(this.now()).toISOString(),
          turnKey,
          touchedAtTurn: turnKey,
          ...(signal.nativeTaskId ? { nativeTaskId: signal.nativeTaskId } : {}),
          ...(signal.durationSeconds !== undefined ? { expiresAt: this.now() + signal.durationSeconds * 1_000 } : {}),
          inFlight: true,
          heuristic: signal.heuristic,
          outlived: false,
          sawProcess: false,
        })
        return true
      }
      if (existing.type !== signal.type || existing.isCommand !== signal.isCommand || existing.label !== label
        || !existing.inFlight || existing.heuristic !== signal.heuristic || existing.nativeTaskId !== (signal.nativeTaskId ?? existing.nativeTaskId)) {
        changed = true
      }
      existing.type = signal.type
      existing.isCommand = signal.isCommand
      existing.label = label
      existing.inFlight = true
      existing.heuristic = signal.heuristic
      existing.touchedAtTurn = turnKey
      if (signal.nativeTaskId) existing.nativeTaskId = signal.nativeTaskId
      if (signal.durationSeconds !== undefined) existing.expiresAt = this.now() + signal.durationSeconds * 1_000
      return changed
    }

    if (signal.isSubagent) {
      if (existing && this.tasks.delete(signal.toolCallId)) changed = true
      return changed
    }

    if (signal.status === 'failed' || signal.status === 'interrupted') {
      if (existing && this.tasks.delete(signal.toolCallId)) changed = true
      if (signal.nativeTaskId && !signal.isControlTool && this.deleteByNativeTaskId(signal.nativeTaskId)) changed = true
      return changed
    }

    if (signal.status === 'completed') {
      if (signal.backgroundLaunch) {
        const label = sanitizeAntigravityWorkLabel(signal.label) ?? existing?.label ?? BACKGROUND_WORK_LABELS[signal.type]
        const expiresAt = signal.durationSeconds !== undefined ? this.now() + signal.durationSeconds * 1_000 : existing?.expiresAt
        if (!existing) {
          if (this.tasks.size >= MAX_BACKGROUND_WORK) return changed
          this.tasks.set(signal.toolCallId, {
            id: randomUUID(),
            activityId: signal.activityId,
            toolCallId: signal.toolCallId,
            type: signal.type,
            isCommand: signal.isCommand,
            label,
            startedAt: new Date(this.now()).toISOString(),
            turnKey,
            touchedAtTurn: turnKey,
            ...(signal.nativeTaskId ? { nativeTaskId: signal.nativeTaskId } : {}),
            ...(expiresAt !== undefined ? { expiresAt } : {}),
            inFlight: false,
            heuristic: signal.heuristic,
            outlived: true,
            sawProcess: false,
          })
          return true
        }
        if (existing.inFlight || !existing.outlived || existing.heuristic !== signal.heuristic || existing.label !== label
          || existing.type !== signal.type || existing.isCommand !== signal.isCommand) changed = true
        existing.inFlight = false
        existing.heuristic = signal.heuristic
        existing.outlived = true
        existing.label = label
        existing.type = signal.type
        existing.isCommand = signal.isCommand
        existing.touchedAtTurn = turnKey
        if (signal.nativeTaskId) existing.nativeTaskId = signal.nativeTaskId
        if (expiresAt !== undefined) existing.expiresAt = expiresAt
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

  /** Reconciles tracked tasks when a turn ends, marking still-running calls outlived and pruning resolved heuristic commands and expired one-shot timers. */
  turnEnded(turnKey: string, reactive: boolean, liveProcessCommands: boolean): boolean {
    let changed = false
    const now = this.now()
    for (const [toolCallId, task] of [...this.tasks]) {
      if (task.inFlight && !task.outlived) {
        task.outlived = true
        changed = true
      }
      if (task.isCommand) {
        if (liveProcessCommands) {
          task.sawProcess = true
        } else if (task.sawProcess) {
          this.tasks.delete(toolCallId)
          changed = true
          continue
        }
      }
      if (!task.inFlight && task.isCommand && task.heuristic && !liveProcessCommands && task.turnKey !== turnKey && task.touchedAtTurn !== turnKey) {
        this.tasks.delete(toolCallId)
        changed = true
        continue
      }
      if (reactive && !task.inFlight && task.type === 'workflow' && task.expiresAt !== undefined && now >= task.expiresAt
        && task.turnKey !== turnKey && task.touchedAtTurn !== turnKey) {
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
  working(activeSubagentToolCalls: ReadonlySet<string>, liveProcessCommands: boolean | readonly AgentBackgroundWork[], turnRunning: boolean): AgentBackgroundWork[] {
    const liveBoolean = typeof liveProcessCommands === 'boolean'
    const liveCount = liveBoolean ? (liveProcessCommands ? Number.POSITIVE_INFINITY : 0) : liveProcessCommands.length
    const suppressedIds = new Set<string>()

    // Prune command tasks whose live OS process has exited.
    if (liveCount === 0) {
      for (const [toolCallId, task] of [...this.tasks]) {
        if (task.isCommand && task.sawProcess) this.tasks.delete(toolCallId)
      }
    } else {
      const candidates = [...this.tasks.values()].filter(task =>
        !activeSubagentToolCalls.has(task.toolCallId) && !(turnRunning && !task.outlived) && task.isCommand
      )
      if (liveBoolean) {
        for (const task of candidates) {
          task.sawProcess = true
          suppressedIds.add(task.toolCallId)
        }
      } else {
        const availableSlots = liveProcessCommands.map((entry, index) => ({ index, label: entry.label, used: false }))
        // Match explicit label overlaps first so an unrelated second command isn't swallowed by a different live process.
        for (const task of candidates) {
          const slot = availableSlots.find(s => !s.used && commandLabelOverlap(task.label, s.label))
          if (slot) {
            slot.used = true
            task.sawProcess = true
            suppressedIds.add(task.toolCallId)
          }
        }
        // Then match any remaining live process slots against unmatched command tasks (heuristic first).
        const remainingTasks = candidates.filter(t => !suppressedIds.has(t.toolCallId))
          .sort((a, b) => Number(b.heuristic) - Number(a.heuristic))
        for (const task of remainingTasks) {
          const slot = availableSlots.find(s => !s.used)
          if (!slot) break
          slot.used = true
          task.sawProcess = true
          suppressedIds.add(task.toolCallId)
        }
      }
    }

    const items: AgentBackgroundWork[] = []
    for (const [toolCallId, task] of this.tasks) {
      if (activeSubagentToolCalls.has(toolCallId)) continue
      if (turnRunning && !task.outlived) continue
      if (suppressedIds.has(toolCallId)) continue
      items.push({ id: task.id, label: task.label, type: task.type, startedAt: task.startedAt })
    }
    return items
  }

  /** Settles tracked background work matching a runtime wakeup's task ID (exact or `/<id>` suffix). */
  settleNativeTask(nativeTaskId: string): boolean {
    return this.removeMatchingNativeTask(nativeTaskId, true)
  }

  private deleteByNativeTaskId(nativeTaskId: string): boolean {
    return this.removeMatchingNativeTask(nativeTaskId, false)
  }

  private removeMatchingNativeTask(nativeTaskId: string, allowSegmentSuffix: boolean): boolean {
    const trimmed = nativeTaskId.trim()
    if (!trimmed) return false
    let removed = false
    for (const [key, task] of this.tasks) {
      if (!task.nativeTaskId) continue
      const matches = task.nativeTaskId === trimmed
        || (allowSegmentSuffix && (task.nativeTaskId.endsWith(`/${trimmed}`) || trimmed.endsWith(`/${task.nativeTaskId}`)))
      if (matches) {
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
