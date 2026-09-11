import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { AuthorizationQuery, AuthorizationResult } from '../agents/authority'
import { policyInsertSql } from './migrations.mjs'
import type { MemoryStore } from './store'

export const policyRecordSchema = z.object({
  id: z.string().min(1),
  action: z.enum(['spend', 'publish', 'destroy', 'relax-verification']),
  resource: z.string().min(1), scope: z.string().min(1),
  effect: z.enum(['allow', 'always-confirm']), source: z.enum(['user', 'questionnaire']),
  note: z.string(), grantedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime().nullable(), revokedAt: z.iso.datetime().nullable(),
})
export type PolicyRecord = z.infer<typeof policyRecordSchema>
type GrantInput = Pick<PolicyRecord, 'action' | 'note'> &
  Partial<Omit<PolicyRecord, 'action' | 'note' | 'revokedAt'>>

function inactiveAt(record: PolicyRecord, at: string): boolean {
  return (record.revokedAt !== null && Date.parse(record.revokedAt) <= Date.parse(at)) ||
    (record.expiresAt !== null && Date.parse(record.expiresAt) <= Date.parse(at))
}

export class PolicyStore {
  constructor(private readonly memoryStore: MemoryStore) {}

  grant(input: GrantInput): PolicyRecord {
    const record = policyRecordSchema.parse({
      id: randomUUID(), grantedAt: new Date().toISOString(), expiresAt: null,
      effect: 'allow', resource: '*', scope: 'global', source: 'user', ...input, revokedAt: null,
    })
    this.memoryStore.database().prepare(policyInsertSql).run(
      record.id, record.action, record.resource, record.scope, record.effect, record.source,
      record.note, record.grantedAt, record.expiresAt, record.revokedAt,
    )
    return record
  }

  revoke(id: string, at = new Date().toISOString()): void {
    const result = this.memoryStore.database().prepare('UPDATE policies SET revokedAt = ? WHERE id = ?')
      .run(z.iso.datetime().parse(at), z.string().min(1).parse(id))
    if (result.changes === 0) throw new Error('Unknown policy record')
  }

  list({ scope, includeInactive = false }: { scope?: string; includeInactive?: boolean } = {}): PolicyRecord[] {
    const rows = this.memoryStore.database().prepare(`SELECT * FROM policies
      WHERE (? IS NULL OR scope = ? OR scope = 'global') ORDER BY grantedAt, id`)
      .all(scope ?? null, scope ?? null)
    const at = new Date().toISOString()
    return rows.map(row => policyRecordSchema.parse(row)).filter(record => includeInactive || !inactiveAt(record, at))
  }

  authorizes({ action, resource, scope, at = new Date().toISOString() }: AuthorizationQuery): AuthorizationResult {
    z.iso.datetime().parse(at)
    // Authorization reads only policies: never memories or memories_fts, including joins and subqueries.
    const rows = this.memoryStore.database().prepare(`SELECT * FROM policies
      WHERE action = ? AND (resource = ? OR resource = '*') AND (scope = ? OR scope = 'global')
      ORDER BY grantedAt DESC, id DESC`).all(action, resource, scope)
    const matches = rows.map(row => policyRecordSchema.parse(row))
    const active = matches.filter(record => !inactiveAt(record, at))
    const boundary = active.find(record => record.effect === 'always-confirm')
    if (boundary) return { allowed: false, reason: 'always-confirm', policyId: boundary.id }
    const allow = active.find(record => record.effect === 'allow')
    if (allow) return { allowed: true, reason: 'allowed', policyId: allow.id }
    if (!matches[0]) return { allowed: false, reason: 'no-policy' }
    const revoked = matches.some(record => record.revokedAt !== null && Date.parse(record.revokedAt) <= Date.parse(at))
    return { allowed: false, reason: revoked ? 'revoked' : 'expired', policyId: matches[0].id }
  }

  recordRiskBoundaries(
    boundaries: { action: PolicyRecord['action']; resource?: string; scope?: string; note: string }[],
    source: 'questionnaire',
  ): PolicyRecord[] {
    return boundaries.map(boundary => this.grant({ ...boundary, effect: 'always-confirm', source }))
  }
}
