import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite'

import { z } from 'zod'

import { migrateDatabase } from './migrations.mjs'

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
  lastConfirmedAt: timestampSchema,
  lastUsedAt: timestampSchema,
  validFrom: timestampSchema,
  validTo: timestampSchema.nullable(),
  supersededBy: z.string().min(1).nullable(),
  provenance: z.array(z.object({
    threadId: z.string(), sessionId: z.string(), provider: z.string(), ref: z.string(),
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

  // The caller supplies a path under app.getPath('userData'); Electron wiring
  // belongs to the feature that consumes this store.
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
    db.prepare(`INSERT INTO memories (
      id, type, scope, content, sourceClass, confidence, evidenceCount, importance,
      createdAt, lastConfirmedAt, lastUsedAt, validFrom, validTo, supersededBy,
      provenance, tags, state, authority, embedding
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
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

  search(query: string, options: { limit: number; projectId?: string }): Memory[] {
    const db = this.requireOpen()
    const { limit, projectId } = searchOptionsSchema.parse(options)
    const terms = z.string().parse(query).replaceAll('"', '').split(/\s+/u).filter(Boolean)
    if (terms.length === 0) return []
    // Bind SQL parameters and quote each FTS term separately: user input is text,
    // including reserved operators such as OR, rather than an FTS expression.
    const match = terms.map((term) => `"${term}"`).join(' ')
    const statement = db.prepare(`
      SELECT memories.* FROM memories_fts
      JOIN memories ON memories.rowid = memories_fts.rowid
      WHERE memories_fts MATCH ? AND memories.state = 'active'
      ${projectId === undefined ? '' : 'AND memories.scope = ?'}
      ORDER BY bm25(memories_fts), memories.id LIMIT ?
    `)
    const rows = projectId === undefined
      ? statement.all(match, limit)
      : statement.all(match, projectId, limit)
    return rows.map(parseRow)
  }

  supersede(id: string, byId: string): void {
    const db = this.requireOpen()
    z.string().min(1).parse(id)
    z.string().min(1).parse(byId)
    if (id === byId) throw new Error('A memory cannot supersede itself')
    db.exec('BEGIN IMMEDIATE')
    try {
      for (const candidate of [id, byId]) {
        if (!db.prepare('SELECT id FROM memories WHERE id = ?').get(candidate)) {
          throw new Error(`Missing memory: ${candidate}`)
        }
      }
      db.prepare("UPDATE memories SET validTo = ?, state = 'superseded', supersededBy = ? WHERE id = ?")
        .run(new Date().toISOString(), byId, id)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  close(): void {
    this.db?.close()
    this.db = undefined
  }

  private requireOpen(): DatabaseSync {
    if (this.db === undefined) throw new Error('Memory store is not open')
    return this.db
  }
}
