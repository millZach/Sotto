import { DatabaseSync } from 'node:sqlite'
import { memoryInsertSql, migrateDatabase } from '../../../src/main/memory/migrations.mjs'
import { retrieveExplicitMemories } from '../../../src/main/memory/retrieval.mjs'

const timestamp = value => new Date(value).toISOString()

export function createBackend() {
  let database
  return {
    name: 'explicit-lexical',
    reset() {
      database?.close()
      database = new DatabaseSync(':memory:')
      migrateDatabase(database)
    },
    observe(event) {
      const memory = event.acceptedMemory
      if (!memory) return // No heuristic extraction or labels enter the retriever.
      const at = timestamp(event.at)
      database.prepare(memoryInsertSql).run(
        memory.id, 'preference', memory.scope, event.text, memory.sourceClass,
        1, 1, 0.8, at, at, null, at, memory.validTo === null ? null : timestamp(memory.validTo),
        null, JSON.stringify([{ source: 'questionnaire', ref: memory.id, recordedAt: at }]),
        JSON.stringify(memory.tags), memory.state, memory.authority, null,
      )
    },
    answer({ question, project, threadId, asOf }) {
      const memories = retrieveExplicitMemories(database, {
        query: question, projectId: project, ...(threadId === undefined ? {} : { threadId }), at: timestamp(asOf),
      })
      // An extractive reader measures accessible evidence, not model response quality.
      return { answer: memories.length ? memories.map(memory => memory.content).join('\n') : null,
        memoryIds: memories.map(memory => memory.id) }
    },
    dispose() { database?.close(); database = undefined },
  }
}
