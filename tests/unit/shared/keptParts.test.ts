// @vitest-environment node
/**
 * Putting a shell's kept parts back (`src/shared/keptParts.ts`), which the window's page and the desktop's client of a
 * paired host share (ADR-0028, October 30 and November 10 amendments).
 */
import { describe, expect, it } from 'vitest'
import { withKeptPartsPutBack, type HeldParts } from '../../../src/shared/keptParts'
import { withKeptParts } from '../../../src/main/agents/agentStateBroadcast'

const projects = [{ id: 'synthetic-project', title: 'Synthetic project' }]
const deliveries = [{ threadId: 'synthetic-thread', draftId: 'synthetic-draft' }]
const held: HeldParts = { revision: 4, top: { deliveries, error: null, host: {} }, host: { name: 'Synthetic host', projects, threads: [] } }

describe('putting kept parts back', () => {
  it('puts back each part named, as the very object held, and keeps every part carried', () => {
    const wire = { kept: ['deliveries', 'error'], configuration: { enabled: true }, host: { kept: ['projects'], name: 'Renamed host', threads: [] } }
    const whole = withKeptPartsPutBack<Record<string, unknown> & { host: Record<string, unknown> }>(wire, 4, held)!
    expect(whole).toEqual({ deliveries, error: null, configuration: { enabled: true }, host: { name: 'Renamed host', projects, threads: [] } })
    expect(whole.deliveries).toBe(deliveries)
    expect(whole.host.projects).toBe(projects)
    // The names go: nothing past the receiver sees the wire's form, and the shell that crossed is not written into.
    expect(whole).not.toHaveProperty('kept')
    expect(whole.host).not.toHaveProperty('kept')
    expect(wire.kept).toEqual(['deliveries', 'error'])
  })

  it('hands back a shell that kept nothing as it came, whatever is held', () => {
    const wire = { configuration: {}, host: { threads: [] } }
    expect(withKeptPartsPutBack(wire, null, null)).toBe(wire)
    expect(withKeptPartsPutBack(wire, 99, held)).toBe(wire)
  })

  it('puts nothing back when the parts are measured from another shell, or name one the held shell did not have', () => {
    const wire = { kept: ['deliveries'], host: { threads: [] } }
    expect(withKeptPartsPutBack(wire, 4, null)).toBeUndefined()
    expect(withKeptPartsPutBack(wire, 3, held)).toBeUndefined()
    expect(withKeptPartsPutBack(wire, undefined, held)).toBeUndefined()
    expect(withKeptPartsPutBack({ kept: ['followups'], host: { threads: [] } }, 4, held)).toBeUndefined()
    expect(withKeptPartsPutBack({ host: { kept: ['providers'], threads: [] } }, 4, held)).toBeUndefined()
    expect(withKeptPartsPutBack({ kept: [7], host: { threads: [] } }, 4, held)).toBeUndefined()
  })

  it('gives back what the sender left out, for the parts a socket push always carries too', () => {
    const catalog = [{ id: 'synthetic-model' }]
    const before = { deliveries, configuration: { enabled: true }, host: { name: 'Synthetic host', projects, threads: [], models: catalog, modelsRevision: 2 } }
    const after = { deliveries: deliveries.map(item => ({ ...item })), configuration: { enabled: false }, host: { name: 'Synthetic host', projects, threads: [], models: catalog, modelsRevision: 2 } }
    const sent = withKeptParts(after, { top: before, host: before.host }, new Set(['threads', 'models', 'modelsRevision', 'providerModeLists']))
    // Equal data is kept though it is a new object; the catalog's fields and the threads always go.
    expect(sent).toEqual({ kept: ['deliveries'], configuration: { enabled: false }, host: { kept: ['name', 'projects'], threads: [], models: catalog, modelsRevision: 2 } })
    expect(withKeptPartsPutBack(sent, 1, { revision: 1, top: before, host: before.host })).toEqual(after)
  })

  it('never names kept a part JSON leaves out, so a push read off the wire puts back what the client holds (review)', () => {
    const hostSent = new Set(['threads', 'models', 'modelsRevision', 'providerModeLists'])
    // A part set to undefined is valid state but goes nowhere on the wire: the client never held it.
    const whole = { deliveries, notice: undefined, host: { name: 'Synthetic host', error: undefined, projects, threads: [] } }
    const written = JSON.parse(JSON.stringify(whole)) as typeof whole
    const sent = JSON.parse(JSON.stringify(withKeptParts(whole, { top: whole, host: whole.host }, hostSent))) as { kept?: string[]; host: { kept?: string[] } }
    expect(sent.kept).toEqual(['deliveries'])
    expect(sent.host.kept).toEqual(['name', 'projects'])
    // What the client held is the first push as it was read; the second puts back from it.
    expect(withKeptPartsPutBack(sent, 1, { revision: 1, top: written, host: written.host })).toEqual(written)
  })
})
