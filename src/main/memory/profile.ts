import { randomUUID } from 'node:crypto'
import {
  MAX_PREFERENCE_CONTEXT_CHARACTERS, memoryCommandSchema, memoryItemSchema, memoryTopicSchema,
  type MemoryCommand, type MemorySnapshot, type MemoryTopic,
} from '../../shared/memory'
import { PolicyStore } from './policies'
import type { MemoryStore } from './store'
import { retrieveExplicitMemories, type RetrievalQuery, type RetrievedPreference } from './retrieval.mjs'

/** Local profile mutations share one SQLite transaction, including policy and FTS writes. */
export class MemoryProfile {
  private readonly policies: PolicyStore

  constructor(private readonly store: MemoryStore) {
    this.policies = new PolicyStore(store)
  }

  snapshot(): MemorySnapshot {
    const row = this.store.database().prepare('SELECT questionnaireCompletedAt FROM memory_profile WHERE id = 1').get()
    return {
      available: true,
      questionnaireCompletedAt: row === undefined ? null : String(row.questionnaireCompletedAt),
      memories: this.store.list().map(memory => memoryItemSchema.parse(memory)),
      policies: this.policies.list({ includeInactive: true }),
    }
  }

  command(input: unknown): MemorySnapshot {
    const command = memoryCommandSchema.parse(input)
    const db = this.store.database()
    db.exec('BEGIN IMMEDIATE')
    try {
      const at = new Date().toISOString()
      if (command.type === 'complete-questionnaire') this.completeQuestionnaire(command, at)
      else if (command.type === 'delete') this.deleteChain(command.id)
      else this.replace(command, at)
      const snapshot = this.snapshot()
      db.exec('COMMIT')
      return snapshot
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  retrieve(query: RetrievalQuery): RetrievedPreference[] {
    return retrieveExplicitMemories(this.store.database(), query)
  }

  preferences(projectId?: string): { id: string; content: string; topic?: MemoryTopic }[] {
    let remaining = MAX_PREFERENCE_CONTEXT_CHARACTERS
    return this.store.currentPreferences(projectId).flatMap(memory => {
      // Keep whole preferences so truncation cannot invert a qualification or exception.
      if (memory.content.length > remaining) return []
      remaining -= memory.content.length
      const topic = memory.tags.map(tag => memoryTopicSchema.safeParse(tag)).find(result => result.success)?.data
      return [{ id: memory.id, content: memory.content, ...(topic === undefined ? {} : { topic }) }]
    })
  }

  private completeQuestionnaire(command: Extract<MemoryCommand, { type: 'complete-questionnaire' }>, at: string): void {
    const db = this.store.database()
    if (db.prepare('SELECT id FROM memory_profile WHERE id = 1').get()) throw new Error('Questionnaire is already complete')
    const submissionId = randomUUID()
    for (const answer of command.answers) {
      this.store.insert({
        id: randomUUID(), type: 'preference', scope: 'global', content: answer.content,
        sourceClass: 'explicit', confidence: 1, evidenceCount: 1, importance: 0.8,
        createdAt: at, lastConfirmedAt: at, lastUsedAt: null, validFrom: at, validTo: null,
        supersededBy: null, provenance: [{ source: 'questionnaire', ref: `${submissionId}:${answer.topic}`, recordedAt: at }],
        tags: [answer.topic], state: 'active', authority: 'preference', embedding: null,
      })
    }
    this.policies.recordRiskBoundaries(command.boundaries.map(action => ({
      action, note: 'Always confirm, as requested in the questionnaire.',
    })), 'questionnaire')
    db.prepare('INSERT INTO memory_profile(id, questionnaireCompletedAt) VALUES (1, ?)').run(at)
  }

  private replace(command: Extract<MemoryCommand, { type: 'edit' | 'supersede' }>, at: string): void {
    const current = this.store.get(command.id)
    if (!current) throw new Error('This memory no longer exists. Refresh the inspector.')
    if (current.supersededBy !== null || current.state === 'superseded') {
      throw new Error('This memory has been superseded. Edit its current replacement.')
    }
    const replacementId = randomUUID()
    this.store.insert({
      ...current, id: replacementId, content: command.content, sourceClass: 'explicit', confidence: 1,
      evidenceCount: current.evidenceCount + 1, createdAt: at, lastConfirmedAt: at, lastUsedAt: null,
      validFrom: at, validTo: null, supersededBy: null, state: 'active', embedding: null,
      provenance: [...current.provenance, { source: 'inspector', ref: `${command.type}:${current.id}`, recordedAt: at }],
    })
    this.store.database().prepare('UPDATE memories SET state = ?, supersededBy = ?, validTo = ? WHERE id = ?')
      .run('superseded', replacementId, at, current.id)
  }

  private deleteChain(id: string): void {
    // Both ancestors and descendants are purged; historical text cannot resurface.
    this.store.database().prepare(`WITH RECURSIVE chain(id, supersededBy) AS (
      SELECT id, supersededBy FROM memories WHERE id = ?
      UNION
      SELECT memories.id, memories.supersededBy FROM memories JOIN chain
        ON memories.id = chain.supersededBy OR memories.supersededBy = chain.id
    ) DELETE FROM memories WHERE id IN (SELECT id FROM chain)`).run(id)
  }
}
