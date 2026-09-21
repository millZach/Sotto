import { createHash } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { AgentActivity, ObservedAgent } from '../../shared/agentActivity'
import { observedSubagentStatus, EMPTY_SUBAGENT_SUMMARY, SUBAGENT_ASSIGNMENT_PAGE_SIZE, SUBAGENT_PAGE_SIZE, type SubagentAssignment, type SubagentAssignmentsPage, type SubagentAssignmentsRequest, type SubagentChange, type SubagentPage, type SubagentPageRequest, type SubagentRow, type SubagentSummary } from '../../shared/subagents'

type Status = SubagentRow['status']
type ThreadState = { epoch?: string; revision: number; sequence: number; summary: SubagentSummary }
export interface SubagentStoreWork { indexedReads: number; rowWrites: number; assignmentWrites: number; classificationWrites: number; pageRowsRead: number }
const blankWork = (): SubagentStoreWork => ({ indexedReads: 0, rowWrites: 0, assignmentWrites: 0, classificationWrites: 0, pageRowsRead: 0 })
const blankThread = (): ThreadState => ({ revision: 0, sequence: 0, summary: { ...EMPTY_SUBAGENT_SUMMARY } })
const terminal = (status: Status): boolean => status !== 'running' && status !== 'unknown'
const counter = (status: Status): keyof SubagentSummary => status === 'running' ? 'working' : status
function privacyIdentity(threadId: string, agentId: string, assignmentId?: string): string {
  return createHash('sha256').update(JSON.stringify([threadId, agentId, assignmentId ?? null])).digest('hex')
}
function fingerprint(agent: ObservedAgent): string {
  return createHash('sha256').update(JSON.stringify(Object.keys(agent).sort().map(key => [key, agent[key as keyof ObservedAgent]]))).digest('hex')
}
/** Classification alone survives activity eviction; no provider-authored words belong here. */
export function subagentActivityClassification(activity: AgentActivity): AgentActivity {
  return {
    id: activity.id, turnId: activity.turnId, sequence: activity.sequence, kind: activity.kind,
    status: activity.status, title: 'Subagent',
    ...(activity.parentId !== undefined ? { parentId: activity.parentId } : {}),
    ...(activity.taskUpdatesExcluded !== undefined ? { taskUpdatesExcluded: activity.taskUpdatesExcluded } : {}),
    ...(activity.agents ? { agents: activity.agents.map(agent => ({
      id: agent.id, status: agent.status,
      ...(agent.assignmentId !== undefined ? { assignmentId: agent.assignmentId } : {}),
      ...(agent.parentId !== undefined ? { parentId: agent.parentId } : {}),
      ...(agent.aliasIds ? { aliasIds: agent.aliasIds.filter(id => /^claude-agent-alias-[a-f0-9]{64}$/u.test(id)).slice(0, 8) } : {}),
    })) } : {}),
  }
}
/** Indexed roster metadata and separately paged tasks/results, outside workspace snapshots. */
export class SubagentStore {
  private db: DatabaseSync | undefined
  private memory = false
  private counts = blankWork()
  constructor(private readonly path: string) {}
  get ephemeral(): boolean { return this.memory }
  /** Structural work counters for archive-size regression measurements. */
  get work(): Readonly<SubagentStoreWork> { return { ...this.counts } }
  resetWorkCounters(): void { this.counts = blankWork() }
  open(options: { ephemeral?: boolean } = {}): void {
    if (this.db) return
    const ephemeral = options.ephemeral === true
    if (ephemeral && existsSync(this.path)) { this.open(); this.erase(); this.close() }
    mkdirSync(dirname(this.path), { recursive: true })
    const db = new DatabaseSync(ephemeral ? ':memory:' : this.path, { timeout: 5_000 })
    try {
      db.exec(`PRAGMA journal_mode=WAL; PRAGMA secure_delete=ON;
        CREATE TABLE IF NOT EXISTS subagent_redactions (identity TEXT PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS subagent_classifications (thread_id TEXT NOT NULL, activity_id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(thread_id, activity_id));
        CREATE TABLE IF NOT EXISTS subagent_threads (thread_id TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS subagent_rows (thread_id TEXT NOT NULL, agent_id TEXT NOT NULL, sequence INTEGER NOT NULL, status TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(thread_id, agent_id));
        CREATE INDEX IF NOT EXISTS subagent_rows_sequence ON subagent_rows(thread_id, sequence);
        CREATE INDEX IF NOT EXISTS subagent_rows_status ON subagent_rows(thread_id, status);
        CREATE INDEX IF NOT EXISTS subagent_live_rows ON subagent_rows(status, thread_id);
        CREATE TABLE IF NOT EXISTS subagent_assignments (thread_id TEXT NOT NULL, agent_id TEXT NOT NULL, assignment_id TEXT NOT NULL, sequence INTEGER NOT NULL, value TEXT NOT NULL, fingerprint TEXT NOT NULL, observed_at TEXT NOT NULL, PRIMARY KEY(thread_id, agent_id, assignment_id));
        CREATE INDEX IF NOT EXISTS subagent_assignments_sequence ON subagent_assignments(thread_id, agent_id, sequence);`)
      if (ephemeral) {
        // Only hashes of erased observational identities reach this attached file.
        // Provider history survives Sotto restarts, so the privacy boundary must too.
        db.prepare('ATTACH DATABASE ? AS privacy').run(this.path)
        db.exec('CREATE TABLE IF NOT EXISTS privacy.subagent_redactions (identity TEXT PRIMARY KEY)')
      }
      this.db = db; this.memory = ephemeral
      // Startup touches live metadata only, never the task/result archive.
      for (const thread of db.prepare("SELECT DISTINCT thread_id FROM subagent_rows WHERE status = 'running'").all()) this.markUnknown(String(thread.thread_id))
    } catch (error) { db.close(); this.db = undefined; throw error }
  }
  close(): void { this.db?.close(); this.db = undefined; this.memory = false }
  privacyChanged(enabled: boolean): void {
    if (!enabled) {
      if (this.memory) return
      if (!this.db) this.open()
      this.erase(); this.close(); this.open({ ephemeral: true })
    } else if (this.memory) { this.close(); this.open() }
  }
  private get redactionsTable(): string { return this.memory ? 'privacy.subagent_redactions' : 'subagent_redactions' }
  private rememberErased(threadId: string, agentId: string, assignmentId: string): void {
    const statement = this.requireOpen().prepare(`INSERT OR IGNORE INTO ${this.redactionsTable} (identity) VALUES (?)`)
    statement.run(privacyIdentity(threadId, agentId, assignmentId))
    statement.run(privacyIdentity(threadId, agentId))
  }
  private erase(): void {
    const db = this.requireOpen()
    db.exec('BEGIN IMMEDIATE')
    try {
      // The explicit privacy action scans identities once; progress and startup never do.
      for (const row of db.prepare('SELECT thread_id, agent_id, assignment_id FROM subagent_assignments').iterate()) {
        this.rememberErased(String(row.thread_id), String(row.agent_id), String(row.assignment_id))
      }
      db.exec('DELETE FROM subagent_assignments; DELETE FROM subagent_classifications; DELETE FROM subagent_rows; DELETE FROM subagent_threads; COMMIT;')
    } catch (error) { db.exec('ROLLBACK'); throw error }
    db.exec('PRAGMA wal_checkpoint(TRUNCATE); VACUUM; PRAGMA wal_checkpoint(TRUNCATE);')
  }
  private requireOpen(): DatabaseSync {
    if (!this.db) throw new Error('Subagent history is not open')
    return this.db
  }
  private thread(threadId: string): ThreadState {
    this.counts.indexedReads++
    const record = this.requireOpen().prepare('SELECT value FROM subagent_threads WHERE thread_id = ?').get(threadId)
    return record ? JSON.parse(String(record.value)) as ThreadState : blankThread()
  }
  state(threadId: string): Pick<SubagentPage, 'revision' | 'summary'> { const { revision, summary } = this.thread(threadId); return { revision, summary } }
  summary(threadId: string): SubagentSummary { return this.thread(threadId).summary }
  private saveThread(threadId: string, state: ThreadState): void {
    this.requireOpen().prepare('INSERT INTO subagent_threads VALUES (?, ?) ON CONFLICT(thread_id) DO UPDATE SET value=excluded.value').run(threadId, JSON.stringify(state))
  }
  private saveRow(threadId: string, row: SubagentRow): void {
    this.counts.rowWrites++
    this.requireOpen().prepare('INSERT INTO subagent_rows VALUES (?, ?, ?, ?, ?) ON CONFLICT(thread_id, agent_id) DO UPDATE SET status=excluded.status, value=excluded.value').run(threadId, row.id, row.sequence, row.status, JSON.stringify(row))
  }
  private saveAssignment(threadId: string, agentId: string, value: SubagentAssignment, hash: string, observedAt: string): void {
    this.counts.assignmentWrites++
    this.requireOpen().prepare('INSERT INTO subagent_assignments VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(thread_id, agent_id, assignment_id) DO UPDATE SET value=excluded.value, fingerprint=excluded.fingerprint, observed_at=excluded.observed_at').run(threadId, agentId, value.id, value.sequence, JSON.stringify(value), hash, observedAt)
  }
  ingest(threadId: string, observations: NonNullable<AgentActivity['agents']>, epoch?: string, activities: readonly AgentActivity[] = []): SubagentChange | undefined {
    const db = this.requireOpen()
    db.exec('BEGIN IMMEDIATE')
    try {
      let state = this.thread(threadId)
      const reset = epoch !== undefined && state.epoch !== undefined && epoch !== state.epoch
      if (reset) {
        db.prepare('DELETE FROM subagent_assignments WHERE thread_id = ?').run(threadId)
        db.prepare('DELETE FROM subagent_classifications WHERE thread_id = ?').run(threadId)
        db.prepare('DELETE FROM subagent_rows WHERE thread_id = ?').run(threadId)
        state = { ...blankThread(), revision: state.revision }
      }
      const epochChanged = epoch !== undefined && epoch !== state.epoch
      if (epoch !== undefined) state.epoch = epoch
      for (const activity of activities) {
        const classification = subagentActivityClassification(activity)
        const value = JSON.stringify(classification)
        const result = db.prepare('INSERT INTO subagent_classifications VALUES (?, ?, ?) ON CONFLICT(thread_id, activity_id) DO UPDATE SET value=excluded.value WHERE value <> excluded.value').run(threadId, activity.id, value)
        this.counts.classificationWrites += Number(result.changes)
        const aliases = new Set(classification.agents?.flatMap(agent => agent.aliasIds ?? []))
        for (const alias of aliases) {
          // A late update for an earlier task cannot redirect a reused native agent's alias.
          const indexed = db.prepare("INSERT INTO subagent_classifications VALUES (?, ?, ?) ON CONFLICT(thread_id, activity_id) DO UPDATE SET value=excluded.value WHERE value <> excluded.value AND json_extract(value, '$.sequence') <= json_extract(excluded.value, '$.sequence')").run(threadId, alias, value)
          this.counts.classificationWrites += Number(indexed.changes)
        }
      }
      const changed = new Map<string, SubagentRow>()
      for (const source of observations) {
        let observation = source
        this.counts.indexedReads += 2
        const previous = db.prepare('SELECT value FROM subagent_rows WHERE thread_id = ? AND agent_id = ?').get(threadId, observation.id)
        const old = previous ? JSON.parse(String(previous.value)) as SubagentRow : undefined
        const assignmentId = observation.assignmentId || old?.assignmentId || `${observation.id}:initial`
        if (this.memory) this.rememberErased(threadId, observation.id, assignmentId)
        else {
          this.counts.indexedReads++
          const identity = privacyIdentity(threadId, observation.id, observation.assignmentId ? assignmentId : undefined)
          if (db.prepare('SELECT 1 FROM subagent_redactions WHERE identity = ?').get(identity)) {
            // Completing or replaying an erased assignment cannot restore its old words.
            // Fresh assignment identities may retain text again after history is enabled.
            observation = { ...observation, title: 'Agent task', description: undefined, prompt: undefined, message: undefined }
          }
        }
        const record = db.prepare('SELECT value, fingerprint, observed_at FROM subagent_assignments WHERE thread_id = ? AND agent_id = ? AND assignment_id = ?').get(threadId, observation.id, assignmentId)
        const prior = record ? JSON.parse(String(record.value)) as SubagentAssignment : undefined
        const hash = fingerprint(observation)
        if (record?.fingerprint === hash) continue
        const status = observedSubagentStatus(observation.status)
        if (prior && terminal(prior.status) && !terminal(status)) continue
        if (record && observation.observedAt && observation.observedAt < String(record.observed_at)) continue
        // Replayed cached history is not evidence a disconnected assignment is alive.
        if (prior?.status === 'unknown' && status === 'running' && (!observation.observedAt || observation.observedAt <= String(record!.observed_at))) continue
        const observedAt = observation.observedAt ?? new Date().toISOString()
        const title = (observation.title?.trim() || observation.description?.trim() || observation.prompt?.trim())?.split(/\r?\n/, 1)[0]?.slice(0, 240) || prior?.title || 'Agent task'
        const assignment: SubagentAssignment = {
          ...prior, id: assignmentId, sequence: prior?.sequence ?? (old?.assignmentCount ?? 0) + 1, title, status,
          ...(observation.prompt !== undefined ? { prompt: observation.prompt } : observation.description !== undefined && prior?.prompt === undefined ? { prompt: observation.description } : {}),
          ...(observation.message !== undefined ? { result: observation.message } : {}),
          ...(observation.model ? { model: observation.model } : {}),
          ...(observation.startedAt ? { startedAt: observation.startedAt } : {}),
          ...(observation.completedAt ? { completedAt: observation.completedAt } : {}),
          ...(observation.durationMs !== undefined ? { durationMs: observation.durationMs } : {}),
        }
        this.saveAssignment(threadId, observation.id, assignment, hash, observedAt)
        // Late results stay on the older assignment instead of replacing the current task.
        const row: SubagentRow = !old || assignment.sequence >= old.assignmentCount ? {
          id: observation.id, sequence: old?.sequence ?? ++state.sequence, revision: (old?.revision ?? 0) + 1,
          assignmentId, assignmentCount: Math.max(old?.assignmentCount ?? 0, assignment.sequence), title,
          description: (observation.description ?? observation.prompt ?? (old?.assignmentId === assignmentId ? old.description : '')).slice(0, 400),
          ...(observation.parentId || old?.parentId ? { parentId: observation.parentId ?? old?.parentId } : {}),
          ...(assignment.model ? { model: assignment.model.slice(0, 512) } : {}), status, lastObservedAt: observedAt,
          ...(assignment.startedAt ? { startedAt: assignment.startedAt } : {}),
          ...(assignment.completedAt ? { completedAt: assignment.completedAt } : {}),
          ...(assignment.durationMs !== undefined ? { durationMs: assignment.durationMs } : {}),
        } : { ...old, revision: old.revision + 1 }
        if (old) state.summary[counter(old.status)]--
        else state.summary.total++
        state.summary[counter(row.status)]++
        this.saveRow(threadId, row); changed.set(row.id, row)
      }
      if (changed.size || reset) state.revision++
      if (changed.size || reset || epochChanged) this.saveThread(threadId, state)
      db.exec('COMMIT')
      return changed.size || reset ? { threadId, revision: state.revision, rows: [...changed.values()], summary: state.summary, ...(reset ? { reset: true } : {}) } : undefined
    } catch (error) { db.exec('ROLLBACK'); throw error }
  }
  markUnknown(threadId: string): SubagentChange | undefined {
    const db = this.requireOpen()
    const records = db.prepare("SELECT value FROM subagent_rows WHERE thread_id = ? AND status = 'running'").all(threadId)
    if (!records.length) return undefined
    db.exec('BEGIN IMMEDIATE')
    try {
      const state = this.thread(threadId)
      const rows = records.map(record => {
        const row = JSON.parse(String(record.value)) as SubagentRow
        const unknown: SubagentRow = { ...row, status: 'unknown', revision: row.revision + 1 }
        this.saveRow(threadId, unknown); this.counts.indexedReads++
        const assignmentRecord = db.prepare('SELECT value, fingerprint, observed_at FROM subagent_assignments WHERE thread_id = ? AND agent_id = ? AND assignment_id = ?').get(threadId, row.id, row.assignmentId)!
        const value = JSON.parse(String(assignmentRecord.value)) as SubagentAssignment
        this.saveAssignment(threadId, row.id, { ...value, status: 'unknown' }, String(assignmentRecord.fingerprint), String(assignmentRecord.observed_at))
        return unknown
      })
      state.summary.working -= rows.length; state.summary.unknown += rows.length; state.revision++
      this.saveThread(threadId, state); db.exec('COMMIT')
      return { threadId, revision: state.revision, rows, summary: state.summary }
    } catch (error) { db.exec('ROLLBACK'); throw error }
  }
  /** Metadata for unfinished observations only, used when an explicit privacy switch clears text. */
  unsettled(threadId: string): ObservedAgent[] {
    this.counts.indexedReads++
    const records = this.requireOpen().prepare("SELECT value FROM subagent_rows WHERE thread_id = ? AND status IN ('running', 'unknown') ORDER BY sequence").all(threadId)
    this.counts.pageRowsRead += records.length
    return records.map(record => {
      const row = JSON.parse(String(record.value)) as SubagentRow
      return {
        id: row.id, assignmentId: row.assignmentId, status: row.status, title: 'Agent task', observedAt: row.lastObservedAt,
        ...(row.parentId !== undefined ? { parentId: row.parentId } : {}),
        ...(row.model !== undefined ? { model: row.model } : {}),
        ...(row.startedAt !== undefined ? { startedAt: row.startedAt } : {}),
        ...(row.durationMs !== undefined ? { durationMs: row.durationMs } : {}),
      }
    })
  }
  /** Explicit retention changes preserve only the text-free identity evidence needed by unfinished tasks. */
  unsettledActivities(threadId: string, observations: readonly ObservedAgent[]): AgentActivity[] {
    if (!observations.length) return []
    const identities = new Set(observations.map(agent => JSON.stringify([agent.id, agent.assignmentId ?? `${agent.id}:initial`])))
    const retained = new Map<string, AgentActivity>()
    this.counts.indexedReads++
    // This scan happens only when changing retention, never on startup or a provider progress update.
    for (const record of this.requireOpen().prepare('SELECT value FROM subagent_classifications WHERE thread_id = ?').iterate(threadId)) {
      this.counts.pageRowsRead++
      const activity = JSON.parse(String(record.value)) as AgentActivity
      const agents = activity.agents?.filter(agent => identities.has(JSON.stringify([agent.id, agent.assignmentId ?? `${agent.id}:initial`])))
      if (agents?.length) retained.set(activity.id, subagentActivityClassification({ ...activity, agents }))
    }
    return [...retained.values()]
  }
  /** One indexed classification lookup, including activities outside the renderer's bounded history. */
  activity(threadId: string, activityId: string, historyEpoch?: string): AgentActivity | undefined {
    if (this.thread(threadId).epoch !== historyEpoch) return undefined
    this.counts.indexedReads++
    const record = this.requireOpen().prepare('SELECT value FROM subagent_classifications WHERE thread_id = ? AND activity_id = ?').get(threadId, activityId)
    return record ? JSON.parse(String(record.value)) as AgentActivity : undefined
  }
  page(request: SubagentPageRequest): SubagentPage {
    const state = this.thread(request.threadId)
    const records = this.requireOpen().prepare('SELECT value FROM subagent_rows WHERE thread_id = ? AND sequence < ? ORDER BY sequence DESC LIMIT ?').all(request.threadId, request.before ?? Number.MAX_SAFE_INTEGER, SUBAGENT_PAGE_SIZE + 1)
    this.counts.pageRowsRead += records.length
    const rows = records.slice(0, SUBAGENT_PAGE_SIZE).map(record => JSON.parse(String(record.value)) as SubagentRow).reverse()
    return { threadId: request.threadId, revision: state.revision, rows, summary: state.summary, ...(records.length > SUBAGENT_PAGE_SIZE ? { before: rows[0]!.sequence } : {}) }
  }
  assignments(request: SubagentAssignmentsRequest): SubagentAssignmentsPage {
    const records = this.requireOpen().prepare('SELECT value FROM subagent_assignments WHERE thread_id = ? AND agent_id = ? AND sequence < ? ORDER BY sequence DESC LIMIT ?').all(request.threadId, request.agentId, request.before ?? Number.MAX_SAFE_INTEGER, SUBAGENT_ASSIGNMENT_PAGE_SIZE + 1)
    this.counts.pageRowsRead += records.length
    const assignments = records.slice(0, SUBAGENT_ASSIGNMENT_PAGE_SIZE).map(record => JSON.parse(String(record.value)) as SubagentAssignment)
    return { threadId: request.threadId, agentId: request.agentId, assignments, ...(records.length > SUBAGENT_ASSIGNMENT_PAGE_SIZE ? { before: assignments.at(-1)!.sequence } : {}) }
  }
}