// @vitest-environment node
import { serialize } from 'node:v8'
import { describe, expect, it } from 'vitest'
import { WindowActivityBodies, windowHistories } from '../../../src/main/agents/windowActivityBodies'
import { ACTIVITY_BODY_LIMIT, utf8Bytes } from '../../../src/shared/activityBodies'
import type { AgentActivity } from '../../../src/shared/agentActivity'
import { applyAgentThreadDetailDelta, isAgentThreadDetailDelta } from '../../../src/shared/agentThreadDetail'
import type { AgentThreadDetail, AgentThreadDetailDelta, AgentThreadDetailUpdate } from '../../../src/shared/agents'

const long = (lines: number): string => Array.from({ length: lines }, (_, index) => `line ${index} `.padEnd(60, 'x')).join('\n')
const record = (patch: Partial<AgentActivity>): AgentActivity => ({ id: 'build', turnId: 't1', sequence: 0, kind: 'command', status: 'completed', title: 'Ran npm test', ...patch })
const history = (activities: AgentActivity[]): AgentThreadDetail => ({ threadId: 'thread', revision: 1, messages: [], activities })
const delta = (activityDeltas: AgentThreadDetailDelta['activityDeltas']): AgentThreadDetailDelta => ({ threadId: 'thread', baseRevision: 1, revision: 2, messageDeltas: [], activityDeltas })

describe("this computer's histories as the main window is sent them (#2737)", () => {
  it('cuts a finished record over the limit, keeps one under it, and keeps a running record whole', () => {
    const finished = record({ output: long(400) })
    const short = record({ id: 'short', output: 'ok' })
    const running = record({ id: 'running', status: 'running', output: long(400) })
    const bodies = new WindowActivityBodies(() => null)
    const sent = bodies.detail(history([finished, short, running]))!
    const [cut, kept, live] = sent.activities!
    expect(utf8Bytes(cut!.output!)).toBeLessThanOrEqual(ACTIVITY_BODY_LIMIT)
    expect(cut!.cut).toEqual({ output: utf8Bytes(finished.output!) })
    expect(finished.output!.endsWith(cut!.output!)).toBe(true)
    expect(kept).toBe(short)
    expect(live).toBe(running)
  })

  it('cuts a record restored from disk, whose run Sotto can no longer tell, and keeps whole what the window reads unopened', () => {
    const restored = record({ id: 'restored', status: 'unknown', output: long(400) })
    const edit = record({ id: 'edit', kind: 'file-change', title: 'Edit', changes: [{ path: 'a.ts', kind: 'edit', diff: long(400) }] })
    const browser = record({ id: 'browser', kind: 'tool', title: 'mcp__sotto_browser__browser_action', output: long(400) })
    const thinking = record({ id: 'thinking', kind: 'reasoning', title: 'Thinking', text: long(400) })
    const [cut, ...whole] = new WindowActivityBodies(() => null).detail(history([restored, edit, browser, thinking]))!.activities!
    expect(cut!.cut?.output).toBe(utf8Bytes(restored.output!))
    expect(whole).toEqual([edit, browser, thinking])
  })

  it('hands the window a history whose size does not grow with its records’ output, at the owner’s 2,000 records', () => {
    // The owner's largest history held 2,000 records, most with long output (#2737). What a click reads through the local
    // host connection is sized by what the rows draw: ten times the output per record crosses as the same bytes, but for
    // the size each cut names.
    const sized = (lines: number): number => {
      const stored = history(Array.from({ length: 2000 }, (_, index) => record({ id: `r${index}`, sequence: index, output: long(lines) })))
      const connection = windowHistories({ threadDetail: () => stored, subscribeThreadDetail: () => () => undefined, threadActivity: () => null })
      return serialize(connection.detail('thread')).byteLength
    }
    const short = sized(60), longer = sized(600)
    // Only the whole size each record's `cut` names is longer, a few bytes a record.
    expect(longer - short).toBeLessThanOrEqual(2000 * 8)
    expect(short).toBeLessThan(2000 * (ACTIVITY_BODY_LIMIT + 512))
  })

  it('reuses a record’s cut on a fresh read of the same history, with its other fields as they are now', () => {
    const whole = record({ output: long(400), title: 'Ran npm test' })
    const bodies = new WindowActivityBodies(() => null)
    const first = bodies.detail(history([whole]))!.activities![0]!
    // A read hands over copies; a title of the same length changes nothing the signature measures.
    const again = bodies.detail(history([{ ...structuredClone(whole), title: 'Ran npm lint' }]))!.activities![0]!
    expect(again.output).toBe(first.output)
    expect(again.cut).toBe(first.cut)
    expect(again.title).toBe('Ran npm lint')
    const grown = bodies.detail(history([{ ...whole, output: `${whole.output}\nmore` }]))!.activities![0]!
    expect(grown.output!.endsWith('\nmore')).toBe(true)
  })

  it('streams the local connection with appends asked for, cut, and reads a record whole when its row opens', async () => {
    const whole = record({ output: long(400) })
    let listener: ((update: AgentThreadDetailUpdate) => void) | undefined
    let options: { readonly appends?: boolean } | undefined
    const connection = windowHistories({ threadDetail: () => history([whole]),
      subscribeThreadDetail: (heard, asked) => { listener = heard; options = asked; return () => undefined },
      threadActivity: (threadId, activityId) => threadId === 'thread' && activityId === 'build' ? whole : null })
    const sent: AgentThreadDetailUpdate[] = []
    connection.subscribeDetail(update => sent.push(update))
    expect(options).toEqual({ appends: true })
    listener!(delta([{ record: whole }]))
    const item = (sent[0] as AgentThreadDetailDelta).activityDeltas[0]!
    expect('record' in item && item.record.cut?.output).toBe(utf8Bytes(whole.output!))
    await expect(connection.activityBody('thread', 'build')).resolves.toBe(whole)
  })

  it('sends a history with nothing to cut as it is', () => {
    const detail = history([record({ output: 'ok' })])
    expect(new WindowActivityBodies(() => null).detail(detail)).toBe(detail)
    expect(new WindowActivityBodies(() => null).detail(null)).toBeNull()
  })

  it('keeps a running record streaming as appends, and cuts it by the change that finishes it', () => {
    const running = record({ status: 'running', output: long(400) })
    const bodies = new WindowActivityBodies(() => null)
    const window = bodies.detail(history([running]))!
    const append = delta([{ id: 'build', appendOutput: '\nmore' }])
    expect(bodies.update(append)).toBe(append)
    const finished = bodies.update(delta([{ record: { ...running, status: 'completed', output: `${running.output}\nmore` } }]))
    expect(finished && isAgentThreadDetailDelta(finished)).toBe(true)
    const applied = applyAgentThreadDetailDelta(window, finished as AgentThreadDetailDelta)!
    expect(applied.activities![0]!.cut?.output).toBe(utf8Bytes(`${running.output}\nmore`))
    expect(applied.activities![0]!.output!.endsWith('\nmore')).toBe(true)
  })

  it('sends an append to a record the window holds cut as the record cut again, from the history as it stands', () => {
    let whole = record({ output: long(400) })
    const bodies = new WindowActivityBodies((threadId, activityId) => threadId === 'thread' && activityId === 'build' ? whole : null)
    bodies.detail(history([whole]))
    whole = { ...whole, output: `${whole.output}\ntail` }
    const sent = bodies.update(delta([{ id: 'build', appendOutput: '\ntail' }])) as AgentThreadDetailDelta
    expect(sent.activityDeltas).toHaveLength(1)
    const item = sent.activityDeltas[0]!
    expect('record' in item && item.record.cut?.output).toBe(utf8Bytes(whole.output!))
    expect('record' in item && item.record.output!.endsWith('\ntail')).toBe(true)
  })

  it('reads the history again when a record an append to a cut record names is gone', () => {
    const bodies = new WindowActivityBodies(() => null)
    bodies.detail(history([record({ output: long(400) })]))
    expect(bodies.update(delta([{ id: 'build', appendOutput: 'x' }]))).toBeNull()
  })

  it('forgets a removed record and one sent whole again, so a later append to it stays an append', () => {
    const bodies = new WindowActivityBodies(() => { throw new Error('not read') })
    bodies.detail(history([record({ output: long(400) }), record({ id: 'other', output: long(400) })]))
    bodies.update(delta([{ id: 'build', removed: true }]))
    bodies.update(delta([{ record: record({ id: 'other', status: 'running', output: 'restarted' }) }]))
    const append = delta([{ id: 'other', appendOutput: 'x' }])
    expect(bodies.update(append)).toBe(append)
  })

  it('cuts a whole history sent as an update the same way, and forgets what the last one held', () => {
    const bodies = new WindowActivityBodies(() => { throw new Error('not read') })
    bodies.detail(history([record({ output: long(400) })]))
    const fresh = history([record({ status: 'running', output: 'again' })])
    expect(bodies.update(fresh)).toBe(fresh)
    const append = delta([{ id: 'build', appendOutput: 'x' }])
    expect(bodies.update(append)).toBe(append)
  })
})
