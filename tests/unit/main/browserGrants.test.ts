// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { PageOpeningGrants } from '../../../src/main/tools/browserGrants'

describe('page-opening grants', () => {
  it('are shaped like a policy record, scoped to one thread and given only by the user', () => {
    const grants = new PageOpeningGrants()
    const grant = grants.grant('thread-a', 100)
    expect(grant).toMatchObject({ action: 'browser-open-pages', resource: '*', scope: 'thread:thread-a', effect: 'allow', source: 'user', grantedAt: 100, expiresAt: null, revokedAt: null })
    expect(grants.active('thread-a')).toBe(grant)
    expect(grants.active('thread-b')).toBeNull()
  })

  it('keeps the first answer rather than stacking a second', () => {
    const grants = new PageOpeningGrants()
    const first = grants.grant('thread-a', 100)
    expect(grants.grant('thread-a', 200)).toBe(first)
    expect(grants.active('thread-a')?.grantedAt).toBe(100)
  })

  it('never allows once revoked, and a new answer is a new record', () => {
    const grants = new PageOpeningGrants()
    const first = grants.grant('thread-a', 100)
    expect(grants.revoke('thread-a', 150)).toBe(true)
    expect(first.revokedAt).toBe(150)
    expect(grants.active('thread-a')).toBeNull()
    expect(grants.revoke('thread-a', 160)).toBe(false)
    const second = grants.grant('thread-a', 200)
    expect(second.id).not.toBe(first.id)
    expect(grants.active('thread-a')).toBe(second)
  })

  it('all end together when the browser shuts down', () => {
    const grants = new PageOpeningGrants()
    grants.grant('thread-a'); grants.grant('thread-b')
    expect(grants.clear().sort()).toEqual(['thread-a', 'thread-b'])
    expect(grants.active('thread-a')).toBeNull()
    expect(grants.active('thread-b')).toBeNull()
  })
})
