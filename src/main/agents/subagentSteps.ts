import { MAX_SUBAGENT_STEP_TEXT, type SubagentStep, type SubagentStepKind, type SubagentStepStatus } from '../../shared/agentActivity'

/** One plain single line, stripped of control characters and bounded to a step's detail budget. */
export function stepLine(value: unknown, limit = MAX_SUBAGENT_STEP_TEXT): string | undefined {
  if (typeof value !== 'string') return undefined
  const first = value.trim().split(/\r?\n/u)[0]?.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/gu, ' ').trim()
  return first ? first.slice(0, limit) : undefined
}

/** Keeps the trailing path segments so a long absolute path stays readable in a narrow Agents pane. */
export function shortStepPath(value: unknown): string | undefined {
  const raw = stepLine(value)
  if (!raw) return undefined
  const normalized = raw.replaceAll('\\', '/')
  const parts = normalized.split('/').filter(Boolean)
  if (parts.length <= 4) return raw
  return parts.slice(-4).join('/').slice(0, MAX_SUBAGENT_STEP_TEXT)
}

/** Strips a shell wrapper such as `bash -lc '…'` so the inner command leads. */
export function shortStepCommand(value: unknown): string | undefined {
  const raw = stepLine(value)
  if (!raw) return undefined
  const wrapped = raw.match(/^\S*\b(?:ba|z)?sh\s+-(?:l)?c\s+(['"])([\s\S]*)\1$/u)
  return stepLine(wrapped ? wrapped[2] : raw)
}

/** Turns a snake_case or MCP tool name into concise readable words. */
export function humanizeStepTool(name: string): string {
  const clean = name.replace(/^mcp_[^_]+_/u, '').replace(/^mcp__[^_]+__/u, '').trim() || name.trim()
  const words = clean.replace(/[_-]+/gu, ' ').replace(/\s+/gu, ' ').trim()
  return (words ? words[0]!.toUpperCase() + words.slice(1) : 'Tool').slice(0, 160)
}

/** Builds a bounded `SubagentStep`, computing `durationMs` when timestamps allow. */
export function buildSubagentStep(input: {
  readonly id: string
  readonly kind: SubagentStepKind
  readonly status: SubagentStepStatus
  readonly title: string
  readonly detail?: string | undefined
  readonly mono?: boolean | undefined
  readonly error?: string | undefined
  readonly exitCode?: number | undefined
  readonly startedAt?: string | undefined
  readonly completedAt?: string | undefined
  readonly durationMs?: number | undefined
}): SubagentStep {
  const startedAt = validIso(input.startedAt)
  const completedAt = validIso(input.completedAt)
  const durationMs = input.durationMs !== undefined && Number.isFinite(input.durationMs) && input.durationMs >= 0
    ? input.durationMs
    : startedAt && completedAt ? Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)) : undefined
  const detail = stepLine(input.detail)
  const error = stepLine(input.error)
  return {
    id: input.id.slice(0, 160),
    kind: input.kind,
    status: input.status,
    title: (stepLine(input.title, 160) ?? 'Step').slice(0, 160),
    ...(detail ? { detail } : {}),
    ...(input.mono !== undefined ? { mono: input.mono } : {}),
    ...(error ? { error } : {}),
    ...(input.exitCode !== undefined && Number.isSafeInteger(input.exitCode) ? { exitCode: input.exitCode } : {}),
    ...(startedAt ? { startedAt } : {}),
    ...(completedAt ? { completedAt } : {}),
    ...(durationMs !== undefined && Number.isFinite(durationMs) ? { durationMs } : {}),
  }
}

const MAX_FOUR_DIGIT_YEAR_MS = 253_402_300_799_999

export function validIso(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= MAX_FOUR_DIGIT_YEAR_MS ? new Date(parsed).toISOString() : undefined
}
