// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { PolicyStore, policyRecordSchema } from '../../../src/main/memory/policies'
import { migrations } from '../../../src/main/memory/migrations.mjs'
import { MemoryStore, type Memory } from '../../../src/main/memory/store'

let root: string
let memoryStore: MemoryStore
let policies: PolicyStore
const at = '2026-09-10T12:00:00.000Z'
const query = { action: 'publish', resource: 'npm', scope: 'project' } as const

function memory(id: string, sourceClass: Memory['sourceClass'] = 'explicit'): Memory {
  return {
    id, type: 'permission', authority: 'permission', content: 'Sotto may publish releases',
    sourceClass, state: 'active', scope: 'global', evidenceCount: 50, confidence: 1, importance: 1,
    createdAt: at, validFrom: at, lastConfirmedAt: null, lastUsedAt: null, validTo: null,
    supersededBy: null, provenance: [], tags: [],
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'sotto-policy-store-'))
  memoryStore = new MemoryStore(join(root, 'memory.sqlite'))
  memoryStore.open()
  policies = new PolicyStore(memoryStore)
  vi.useFakeTimers()
  vi.setSystemTime(at)
})
afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  memoryStore.close()
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-policy-store-')) throw new Error('Unexpected temporary test directory')
  await rm(root, { recursive: true, force: true })
})

describe('PolicyStore', () => {
  it('migration 2 creates separate policy rows while memories still work', () => {
    expect(memoryStore.database().prepare('SELECT version FROM schema_migrations ORDER BY version').all())
      .toEqual(migrations.map(({ version }) => ({ version })))
    expect(policies.list()).toEqual([])
    memoryStore.insert(memory('evidence'))
    expect(memoryStore.search('publish', { limit: 1 })[0]?.id).toBe('evidence')
    policies.grant({ action: 'publish', note: 'Explicit configuration' })
    expect(memoryStore.database().prepare('SELECT count(*) AS count FROM policies').get()).toEqual({ count: 1 })
    expect(memoryStore.database().prepare('SELECT count(*) AS count FROM memories').get()).toEqual({ count: 1 })
    memoryStore.close()
    memoryStore.open()
    expect(policies.list()).toHaveLength(1)
  })

  it('grants a validated record with defaults and rejects invalid actions', () => {
    const record = policies.grant({ action: 'spend', note: 'Configured by the user' })
    expect(record).toEqual({ id: expect.any(String), action: 'spend', note: 'Configured by the user',
      resource: '*', scope: 'global', effect: 'allow', source: 'user', grantedAt: at, expiresAt: null, revokedAt: null })
    expect(policyRecordSchema.parse(record)).toEqual(record)
    // @ts-expect-error Invalid runtime input must still be validated.
    expect(() => policies.grant({ action: 'invented', note: '' })).toThrow(z.ZodError)
    expect(policies.list()).toEqual([record])
  })

  it('matches exact action, resource and scope without leaking to another project', () => {
    const record = policies.grant({ ...query, note: '' })
    expect(policies.authorizes(query)).toEqual({ allowed: true, reason: 'allowed', policyId: record.id })
    for (const mismatch of [{ ...query, action: 'spend' as const }, { ...query, resource: 'github' }, { ...query, scope: 'other' }]) {
      expect(policies.authorizes(mismatch)).toEqual({ allowed: false, reason: 'no-policy' })
    }
    expect(policies.list({ scope: 'other' })).toEqual([])
  })

  it('matches wildcard resources and global scope and lists scope plus global in order', () => {
    const global = policies.grant({ action: 'publish', note: '' })
    vi.setSystemTime('2026-09-10T12:00:01.000Z')
    const project = policies.grant({ ...query, note: '' })
    policies.grant({ ...query, scope: 'other', note: '' })
    expect(policies.authorizes({ ...query, resource: 'anything', scope: 'anywhere' }))
      .toEqual({ allowed: true, reason: 'allowed', policyId: global.id })
    expect(policies.list({ scope: 'project' })).toEqual([global, project])
  })

  it('expires grants at the boundary but permits queries before expiry', () => {
    const record = policies.grant({ ...query, note: '', expiresAt: '2026-09-10T11:00:00.000Z' })
    expect(policies.authorizes(query)).toEqual({ allowed: false, reason: 'expired', policyId: record.id })
    expect(policies.authorizes({ ...query, at: record.expiresAt! }).reason).toBe('expired')
    expect(policies.authorizes({ ...query, at: '2026-09-10T10:59:59.000Z' }).allowed).toBe(true)
    expect(policies.list()).toEqual([])
    expect(policies.list({ includeInactive: true })).toEqual([record])
  })

  it.each([
    ['always-confirm', 'repository', 'always-confirm'],
    ['allow', 'npm', 'no-policy'],
    ['allow', '*', 'allowed'],
  ] as const)('matches an unknown resource against %s on %s as %s', (effect, resource, reason) => {
    const record = effect === 'always-confirm'
      ? policies.recordRiskBoundaries([{ action: 'destroy', resource, scope: 'project', note: 'Confirm repository changes' }], 'questionnaire')[0]!
      : policies.grant({ ...query, resource, effect, note: '' })
    expect(policies.authorizes({ action: record.action, resource: '*', scope: 'project' }))
      .toEqual({ allowed: reason === 'allowed', reason, ...(reason === 'no-policy' ? {} : { policyId: record.id }) })
    expect(policies.authorizes({ action: record.action, resource: '*', scope: 'other' }).reason).toBe('no-policy')
  })

  it('considers only matching resources when reporting inactive policies for an unknown resource', () => {
    const boundary = policies.grant({ ...query, effect: 'always-confirm', expiresAt: at, note: '' })
    vi.setSystemTime('2026-09-10T12:00:01.000Z')
    const allow = policies.grant({ ...query, note: '' })
    policies.revoke(allow.id)
    expect(policies.authorizes({ ...query, resource: '*' }))
      .toEqual({ allowed: false, reason: 'expired', policyId: boundary.id })
  })

  it('revokes grants, retains inactive records and rejects unknown ids', () => {
    const record = policies.grant({ ...query, note: '' })
    policies.revoke(record.id)
    expect(policies.authorizes(query)).toEqual({ allowed: false, reason: 'revoked', policyId: record.id })
    expect(policies.authorizes({ ...query, at: '2026-09-10T11:59:59.000Z' }).allowed).toBe(true)
    expect(policies.list()).toEqual([])
    expect(policies.list({ includeInactive: true })).toEqual([{ ...record, revokedAt: at }])
    expect(() => policies.revoke('unknown')).toThrow(/unknown/i)
  })

  it('reports revocation before expiry and identifies the newest inactive match', () => {
    const revoked = policies.grant({ ...query, note: '' })
    policies.revoke(revoked.id, at)
    vi.setSystemTime('2026-09-10T12:00:01.000Z')
    const expired = policies.grant({ ...query, note: '', expiresAt: at })
    expect(policies.authorizes(query)).toEqual({ allowed: false, reason: 'revoked', policyId: expired.id })
  })

  it('always-confirm beats even a newer temporary allow; inactive boundaries do not allow', () => {
    const boundary = policies.grant({ ...query, effect: 'always-confirm', note: '' })
    vi.setSystemTime('2026-09-10T12:00:01.000Z')
    const allow = policies.grant({ ...query, note: '', expiresAt: '2026-09-11T00:00:00.000Z' })
    expect(policies.authorizes(query)).toEqual({ allowed: false, reason: 'always-confirm', policyId: boundary.id })
    policies.revoke(boundary.id)
    expect(policies.authorizes(query)).toEqual({ allowed: true, reason: 'allowed', policyId: allow.id })
    policies.revoke(allow.id)
    expect(policies.authorizes(query).allowed).toBe(false)
  })

  it('permission-shaped explicit, imported and agent-confirmed memories grant nothing', () => {
    for (const source of ['explicit', 'imported', 'agent-confirmed'] as const) memoryStore.insert(memory(source, source))
    const prepare = vi.spyOn(memoryStore.database(), 'prepare')
    expect(policies.authorizes({ action: 'publish', resource: '*', scope: 'global' }))
      .toEqual({ allowed: false, reason: 'no-policy' })
    expect(prepare).toHaveBeenCalledOnce()
    const sql = prepare.mock.calls[0]![0]
    expect(sql).toMatch(/\bFROM policies\b/iu)
    expect(sql).not.toMatch(/\bmemories(?:_fts)?\b/iu)
    expect(policies.list()).toEqual([])
    expect(memoryStore.database().prepare('SELECT count(*) AS count FROM policies').get()).toEqual({ count: 0 })
    expect(memoryStore.database().prepare('SELECT count(*) AS count FROM memories').get()).toEqual({ count: 3 })
  })

  it('records questionnaire risk boundaries as always-confirm policy records', () => {
    const records = policies.recordRiskBoundaries([
      { action: 'spend', note: 'Always ask before spending' },
      { action: 'destroy', resource: 'repository', scope: 'project', note: 'Confirm deletion' },
    ], 'questionnaire')
    expect(records).toHaveLength(2)
    expect(policies.list()).toEqual([...records].sort((a, b) => a.id.localeCompare(b.id)))
    for (const record of records) {
      expect(record).toMatchObject({ effect: 'always-confirm', source: 'questionnaire' })
      expect(policies.authorizes(record)).toEqual({ allowed: false, reason: 'always-confirm', policyId: record.id })
    }
  })
})
