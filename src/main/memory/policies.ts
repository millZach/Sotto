import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { remoteAnswerScope, type AuthorizationQuery, type AuthorizationResult, type ClientGrantResult } from '../agents/authority'
import type { ClientIdentity } from '../agents/hostService'
import { memoryPolicySchema } from '../../shared/memory'
import { policyInsertSql } from './migrations.mjs'
import type { MemoryStore } from './store'

export const policyRecordSchema = memoryPolicySchema
export type PolicyRecord = z.infer<typeof policyRecordSchema>
type GrantInput = Pick<PolicyRecord, 'action' | 'note'> &
  Partial<Omit<PolicyRecord, 'action' | 'note' | 'revokedAt'>>

function isInactiveAt(record: PolicyRecord, at: string): boolean {
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
    return rows.map(row => policyRecordSchema.parse(row)).filter(record => includeInactive || !isInactiveAt(record, at))
  }

  authorizes({ action, resource, scope, at = new Date().toISOString() }: AuthorizationQuery): AuthorizationResult {
    z.iso.datetime().parse(at)
    // Authorization reads only policies: never memories or memories_fts, including joins and subqueries.
    const rows = this.memoryStore.database().prepare(`SELECT * FROM policies
      WHERE action = ? AND (scope = ? OR scope = 'global')
      ORDER BY grantedAt DESC, id DESC`).all(action, scope)
    const matches = rows.map(row => policyRecordSchema.parse(row))
      .filter(record => record.resource === '*' || record.resource === resource ||
        (record.effect === 'always-confirm' && resource === '*'))
    const active = matches.filter(record => !isInactiveAt(record, at))
    const boundary = active.find(record => record.effect === 'always-confirm')
    if (boundary) return { allowed: false, reason: 'always-confirm', policyId: boundary.id }
    const allow = active.find(record => record.effect === 'allow')
    if (allow) return { allowed: true, reason: 'allowed', policyId: allow.id }
    if (!matches[0]) return { allowed: false, reason: 'no-policy' }
    const revoked = matches.some(record => record.revokedAt !== null && Date.parse(record.revokedAt) <= Date.parse(at))
    return { allowed: false, reason: revoked ? 'revoked' : 'expired', policyId: matches[0].id }
  }

  /**
   * Records that the user paired this client on this PC and will let its answers count as grants. The
   * record is the authority; the pairing token only says which client is speaking (ADR-0004).
   */
  grantRemoteAnswers(clientId: string, note: string, expiresAt: string | null = null): PolicyRecord {
    return this.grant({ action: 'remote-answer', resource: clientId, scope: remoteAnswerScope(clientId), note, expiresAt })
  }

  /**
   * Whether this client's answer may count as a grant. The local window always may; a remote client
   * may only while a record names it, and nothing else ever may. A record scoped `global` or to some
   * other client is not an answer about this one, which is why this does not go through `authorizes`.
   */
  mayGrant(client: ClientIdentity, at = new Date().toISOString()): ClientGrantResult {
    if (client.transport === 'ipc') return { allowed: true, reason: 'local-window' }
    z.iso.datetime().parse(at)
    // Authorization reads only policies: never memories or memories_fts, including joins and subqueries.
    const rows = this.memoryStore.database().prepare(`SELECT * FROM policies
      WHERE action = 'remote-answer' AND scope = ? AND resource = ?
      ORDER BY grantedAt DESC, id DESC`).all(remoteAnswerScope(client.clientId), client.clientId)
    const records = rows.map(row => policyRecordSchema.parse(row))
    if (records.length === 0) return { allowed: false, reason: 'no-policy' }
    const active = records.filter(record => !isInactiveAt(record, at))
    const boundary = active.find(record => record.effect === 'always-confirm')
    if (boundary) return { allowed: false, reason: 'unpaired', policyId: boundary.id }
    const allow = active.find(record => record.effect === 'allow')
    return allow ? { allowed: true, reason: 'paired-client', policyId: allow.id }
      : { allowed: false, reason: 'unpaired', policyId: records[0]!.id }
  }

  recordRiskBoundaries(
    boundaries: { action: PolicyRecord['action']; resource?: string; scope?: string; note: string }[],
    source: 'questionnaire',
  ): PolicyRecord[] {
    return boundaries.map(boundary => this.grant({ ...boundary, effect: 'always-confirm', source }))
  }
}
