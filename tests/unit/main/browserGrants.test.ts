// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { BrowserGrants } from '../../../src/main/tools/browserGrants'

describe('browser grants (ADR-0029)', () => {
  it('grants every thread by default while the setting is on, shaped like a policy record', () => {
    const grants = new BrowserGrants(() => true)
    const grant = grants.active('thread-a', 100)
    expect(grant).toMatchObject({ action: 'browser-use', resource: '*', scope: 'thread:thread-a', effect: 'allow', source: 'settings', grantedAt: 100, expiresAt: null, revokedAt: null })
    expect(grants.active('thread-b', 200)?.source).toBe('settings')
  })

  it('keeps the settings grant’s first grantedAt stable across repeated checks', () => {
    const grants = new BrowserGrants(() => true)
    const first = grants.active('thread-a', 100)
    expect(grants.active('thread-a', 200)).toEqual(first)
  })

  it('grants nothing by default while the setting is off, and asks again', () => {
    const grants = new BrowserGrants(() => false)
    expect(grants.active('thread-a')).toBeNull()
  })

  it('records the user’s own answer, keeps the first one, and it outlives the setting turning off', () => {
    let on = true
    const grants = new BrowserGrants(() => on)
    const first = grants.grant('thread-a', 100)
    expect(first).toMatchObject({ source: 'user', grantedAt: 100 })
    expect(grants.grant('thread-a', 200)).toBe(first)
    on = false
    expect(grants.active('thread-a')).toBe(first)
  })

  it('turning the setting off ends every settings grant at once, but a stopped or unstopped thread reflects it live', () => {
    let on = true
    const grants = new BrowserGrants(() => on)
    expect(grants.active('thread-a')?.source).toBe('settings')
    on = false
    expect(grants.active('thread-a')).toBeNull()
    on = true
    expect(grants.active('thread-a')?.source).toBe('settings')
  })

  it('stop ends whatever is active, whichever its source, and the thread asks again even with the setting on', () => {
    const grants = new BrowserGrants(() => true)
    const active = grants.active('thread-a', 100)!
    expect(grants.stop('thread-a', 150)).toBe(true)
    expect(active.revokedAt).toBe(150)
    expect(grants.active('thread-a')).toBeNull()
    expect(grants.stop('thread-a', 160)).toBe(false)
  })

  it('a fresh answer after Stop lifts it and grants the thread again', () => {
    const grants = new BrowserGrants(() => true)
    grants.stop('thread-a')
    expect(grants.active('thread-a')).toBeNull()
    const granted = grants.grant('thread-a', 300)
    expect(granted.source).toBe('user')
    expect(grants.active('thread-a')).toBe(granted)
  })

  it('reaches no other thread', () => {
    const grants = new BrowserGrants(() => true)
    grants.stop('thread-a')
    expect(grants.active('thread-a')).toBeNull()
    expect(grants.active('thread-b')?.source).toBe('settings')
  })

  it('forgets a gone thread without treating it as a session Stop', () => {
    const grants = new BrowserGrants(() => true)
    grants.grant('thread-a')
    grants.forget('thread-a')
    // Forgetting is not a Stop: the thread is granted again by the setting, not left asking.
    expect(grants.active('thread-a')?.source).toBe('settings')
  })

  it('all end together when the browser shuts down, even with the setting still on', () => {
    const grants = new BrowserGrants(() => true)
    grants.active('thread-a'); grants.active('thread-b')
    expect(grants.clear().sort()).toEqual(['thread-a', 'thread-b'])
    expect(grants.active('thread-a')).toBeNull()
    expect(grants.active('thread-b')).toBeNull()
  })
})
