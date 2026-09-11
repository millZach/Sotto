import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite'

import { z } from 'zod'

import { memoryInsertSql, migrateDatabase } from './migrations.mjs'

const timestampSchema = z.iso.datetime()

export const memorySchema = z.object({
  id: z.string().min(1),
  type: z.string(),
  // For project-scoped memories, scope is the project id, not the word "project".
  scope: z.string().describe('Project id for project-scoped memories; otherwise the scope name'),
  content: z.string().min(1),
  sourceClass: z.enum(['explicit', 'observed', 'inferred', 'imported', 'agent-confirmed']),
  confidence: z.number().min(0).max(1),
  evidenceCount: z.number().int().min(0),
  importance: z.number().min(0).max(1),
  createdAt: timestampSchema,
  lastConfirmedAt: timestampSchema.nullable(),
  lastUsedAt: timestampSchema.nullable(),
  validFrom: timestampSchema,
  validTo: timestampSchema.nullable(),
  supersededBy: z.string().min(1).nullable(),
  provenance: z.array(z.object({
    threadId: z.string().describe('Sotto thread ID'), ref: z.string(),
  })),
  tags: z.array(z.string()),
  state: z.enum(['active', 'superseded', 'disputed', 'temporary', 'archived']),
  authority: z.enum(['preference', 'policy', 'permission']),
  embedding: z.instanceof(Uint8Array).nullable().optional(),
})

export type Memory = z.infer<typeof memorySchema>

const searchOptionsSchema = z.object({
  limit: z.number().int().min(1),
  projectId: z.string().min(1).optional(),
  at: timestampSchema.optional(),
})

function parseRow(row: Record<string, SQLOutputValue>): Memory {
  return memorySchema.parse({
    ...row,
    provenance: JSON.parse(z.string().parse(row.provenance)) as unknown,
    tags: JSON.parse(z.string().parse(row.tags)) as unknown,
  })
}

export class MemoryStore {
  private db: DatabaseSync | undefined

  // The main runtime supplies a path under app.getPath('userData').
  constructor(private readonly path: string) {}

  open(): void {
    if (this.db !== undefined) return
    mkdirSync(dirname(this.path), { recursive: true })
    const db = new DatabaseSync(this.path, { timeout: 5_000 })
    try {
      migrateDatabase(db)
      this.db = db
    } catch (error) {
      db.close()
      throw error
    }
  }

  insert(input: Memory): void {
    const db = this.requireOpen()
    const memory = memorySchema.parse(input)
    db.prepare(memoryInsertSql)
      .run(
        memory.id, memory.type, memory.scope, memory.content, memory.sourceClass,
        memory.confidence, memory.evidenceCount, memory.importance, memory.createdAt,
        memory.lastConfirmedAt, memory.lastUsedAt, memory.validFrom, memory.validTo,
        memory.supersededBy, JSON.stringify(memory.provenance), JSON.stringify(memory.tags),
        memory.state, memory.authority, memory.embedding ?? null,
      )
  }

  get(id: string): Memory | undefined {
    const row = this.requireOpen().prepare('SELECT * FROM memories WHERE id = ?')
      .get(z.string().min(1).parse(id))
    return row === undefined ? undefined : parseRow(row)
  }

  search(query: string, options: { limit: number; projectId?: string; at?: string }): Memory[] {
    const db = this.requireOpen()
    const { limit, projectId, at = new Date().toISOString() } = searchOptionsSchema.parse(options)
    const terms = z.string().parse(query).replaceAll('"', '').split(/\s+/u).filter(Boolean)
    if (terms.length === 0) return []
    // Bind SQL parameters and quote each FTS term separately: user input is text,
    // including reserved operators such as OR, rather than an FTS expression.
    const match = terms.map((term) => `"${term}"`).join(' ')
    const statement = db.prepare(`
      SELECT memories.* FROM memories_fts
      JOIN memories ON memories.rowid = memories_fts.rowid
      WHERE memories_fts MATCH ? AND memories.state IN ('active', 'temporary')
      AND memories.validFrom <= ? AND (memories.validTo IS NULL OR memories.validTo > ?)
      ${projectId === undefined ? '' : 'AND memories.scope = ?'}
      ORDER BY bm25(memories_fts), memories.id LIMIT ?
    `)
    const rows = projectId === undefined
      ? statement.all(match, at, at, limit)
      : statement.all(match, at, at, projectId, limit)
    return rows.map(parseRow)
  }

  close(): void {
    this.db?.close()
    this.db = undefined
  }

  /** Shared with the policy store; not for use outside src/main/memory */
  database(): DatabaseSync { return this.requireOpen() }

  private requireOpen(): DatabaseSync {
    if (this.db === undefined) throw new Error('Memory store is not open')
    return this.db
  }
}
