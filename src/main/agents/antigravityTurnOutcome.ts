import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/**
 * Tells a genuine Antigravity turn completion apart from an upstream error `agy` reported as chat text and `end_turn`
 * (the research note, "The protocol", after T3's `AntigravityTurnOutcome.ts`). Before a prompt goes out, Sotto notes
 * the newest step index in `<appData>/conversations/<sessionId>.db`; once `session/prompt` settles, Sotto checks only
 * steps added after that index from the same unlinked file, read-only, with a bounded payload read.
 */

const ERROR_STEP_TYPE = 17
const PLANNER_RESPONSE_STEP_TYPE = 15
const MAX_ERROR_PAYLOAD_BYTES = 16_384
const SESSION_ID = /^[\w-]{1,128}$/u
const UTF8 = new TextDecoder('utf-8', { fatal: false })
const ENCODER = new TextEncoder()

const API_ERROR = /Error (\d{3}), Message: (.+?), Status: ([A-Z_]+)/su
const STATUS_ERROR = /(?<![A-Z_])([A-Z_]+) \(code (\d{3})\): (\P{Cc}+)/u
const QUOTA_EXHAUSTED = /\breason:QUOTA_EXHAUSTED\b/u
const INVALID_THINKING_SIGNATURE = /\bmessages\.\d+\.content\.\d+(?:\.thinking\.signature: Field required|: Invalid `signature` in `thinking` block)/u

export interface AntigravityTurnOutcome {
  readonly status: 'completed' | 'interrupted' | 'failed'
  readonly error?: string
}

export interface AntigravityLastStep {
  readonly type: number
  readonly payload: Uint8Array | null
  readonly reachedModel: boolean
}

export interface AntigravityOutcomeWatcher {
  check(stopReason: string): Promise<AntigravityTurnOutcome>
}

type ResolvedPath =
  | { readonly kind: 'missing-dir'; readonly appDataReal: string }
  | { readonly kind: 'missing-db'; readonly appDataReal: string; readonly dbPath: string }
  | { readonly kind: 'file'; readonly appDataReal: string; readonly dbPath: string; readonly dev: number | bigint; readonly ino: number | bigint }
  | { readonly kind: 'unsafe' }

const isWithin = (parent: string, child: string): boolean => {
  const diff = relative(parent, child)
  return Boolean(diff) && !diff.startsWith('..') && !isAbsolute(diff)
}

async function resolveUnlinked(appData: string, sessionId: string): Promise<ResolvedPath> {
  if (!SESSION_ID.test(sessionId)) return { kind: 'unsafe' }
  try {
    const appDataReal = await realpath(appData)
    const conversationsDir = join(appDataReal, 'conversations')
    let convStat
    try { convStat = await lstat(conversationsDir) } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'missing-dir', appDataReal } : { kind: 'unsafe' }
    }
    if (!convStat.isDirectory() || convStat.isSymbolicLink()) return { kind: 'unsafe' }
    const conversationsReal = await realpath(conversationsDir)
    if (!isWithin(appDataReal, conversationsReal)) return { kind: 'unsafe' }

    const dbPath = join(conversationsReal, `${sessionId}.db`)
    let dbStat
    try { dbStat = await lstat(dbPath) } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'missing-db', appDataReal, dbPath } : { kind: 'unsafe' }
    }
    if (!dbStat.isFile() || dbStat.isSymbolicLink()) return { kind: 'unsafe' }
    const dbReal = await realpath(dbPath)
    if (!isWithin(conversationsReal, dbReal)) return { kind: 'unsafe' }
    return { kind: 'file', appDataReal, dbPath: dbReal, dev: dbStat.dev, ino: dbStat.ino }
  } catch {
    return { kind: 'unsafe' }
  }
}

function readSteps<T>(dbPath: string, read: (db: DatabaseSync) => T): T | undefined {
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
    db.exec('PRAGMA busy_timeout = 100')
    const hasSteps = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'steps'").get() !== undefined
    return hasSteps ? read(db) : undefined
  } catch {
    return undefined
  } finally {
    try { db?.close() } catch { /* Already closed or unreadable. */ }
  }
}

const lastStepIndex = (db: DatabaseSync): number => {
  const idx = db.prepare('SELECT max(idx) AS idx FROM steps').get()?.idx
  return typeof idx === 'number' ? idx : -1
}

const lastStepAfter = (startIndex: number) => (db: DatabaseSync): AntigravityLastStep | undefined => {
  const row = db.prepare('SELECT step_type AS type, substr(step_payload, 1, ?) AS payload FROM steps WHERE idx > ? ORDER BY idx DESC LIMIT 1').get(MAX_ERROR_PAYLOAD_BYTES, startIndex)
  if (typeof row?.type !== 'number') return undefined
  const payload = row.payload instanceof Uint8Array
    ? row.payload
    : typeof row.payload === 'string'
      ? ENCODER.encode(row.payload.slice(0, MAX_ERROR_PAYLOAD_BYTES))
      : null
  const reachedModel = row.type === ERROR_STEP_TYPE
    ? db.prepare('SELECT 1 FROM steps WHERE idx > ? AND step_type = ? LIMIT 1').get(startIndex, PLANNER_RESPONSE_STEP_TYPE) !== undefined
    : false
  return { type: row.type, payload, reachedModel }
}

/** Classifies a settled `session/prompt` from its stop reason and, when present, the newest trailing step it wrote. */
export function classifyAntigravityTurnOutcome(stopReason: string, step?: AntigravityLastStep): AntigravityTurnOutcome {
  if (stopReason === 'cancelled') return { status: 'interrupted' }
  if (step?.type !== ERROR_STEP_TYPE) {
    return stopReason === 'refusal'
      ? { status: 'failed', error: 'Antigravity refused this turn, or the account reached its limit. Nothing else was lost.' }
      : { status: 'completed' }
  }
  const text = UTF8.decode(step.payload ?? new Uint8Array())
  const apiMatch = API_ERROR.exec(text)
  const statusMatch = apiMatch ? null : STATUS_ERROR.exec(text)
  const httpStatus = apiMatch?.[1] ?? statusMatch?.[2]
  const statusName = apiMatch?.[3] ?? statusMatch?.[1]

  if (stopReason === 'refusal' || QUOTA_EXHAUSTED.test(text) || httpStatus === '429' || statusName === 'RESOURCE_EXHAUSTED') {
    return { status: 'failed', error: 'Antigravity reached its usage limit for this period. Your thread is kept. Try again later.' }
  }
  if (INVALID_THINKING_SIGNATURE.test(text)) {
    return { status: 'failed', error: 'Antigravity could not continue this saved conversation. Your thread is kept. Fork from here to carry on in a fresh session.' }
  }
  if (httpStatus === '401' || httpStatus === '403' || statusName === 'UNAUTHENTICATED' || statusName === 'PERMISSION_DENIED') {
    return { status: 'failed', error: 'Antigravity could not use this account for this turn. Your thread is kept. Check your sign-in in Settings › Providers, then send again.' }
  }
  if (httpStatus === '404' && !step.reachedModel) {
    return { status: 'failed', error: 'Antigravity could not run this thread’s model. Your thread is kept. Choose another Gemini model, then send again.' }
  }
  if ((httpStatus !== undefined && Number(httpStatus) >= 500) || (httpStatus === '404' && step.reachedModel)) {
    return { status: 'failed', error: 'Antigravity ran into a service error and stopped this turn. Your thread is kept. Send again to retry.' }
  }
  return { status: 'failed', error: 'Antigravity stopped this turn because of an error. Your thread is kept. Send again to retry.' }
}

const typedOnlyWatcher: AntigravityOutcomeWatcher = {
  check: async stopReason => classifyAntigravityTurnOutcome(stopReason),
}

/** Snapshots the session log's tail before sending `session/prompt`, then checks only new steps when it finishes. */
export async function watchAntigravityTurnOutcome(appData: string, sessionId: string | undefined): Promise<AntigravityOutcomeWatcher> {
  if (!sessionId || !SESSION_ID.test(sessionId)) return typedOnlyWatcher
  const before = await resolveUnlinked(appData, sessionId)
  if (before.kind === 'unsafe') return typedOnlyWatcher

  let startIndex = -1
  let beforeIdentity: { readonly dev: number | bigint; readonly ino: number | bigint } | undefined
  if (before.kind === 'file') {
    const readIndex = readSteps(before.dbPath, lastStepIndex)
    if (readIndex === undefined) return typedOnlyWatcher
    startIndex = readIndex
    beforeIdentity = { dev: before.dev, ino: before.ino }
  }

  return {
    async check(stopReason: string): Promise<AntigravityTurnOutcome> {
      if (stopReason === 'cancelled') return { status: 'interrupted' }
      const after = await resolveUnlinked(appData, sessionId)
      const sameFile = after.kind === 'file'
        && after.appDataReal === before.appDataReal
        && (beforeIdentity === undefined || (after.dev === beforeIdentity.dev && after.ino === beforeIdentity.ino))
      const step = sameFile ? readSteps(after.dbPath, lastStepAfter(startIndex)) : undefined
      return classifyAntigravityTurnOutcome(stopReason, step)
    },
  }
}
