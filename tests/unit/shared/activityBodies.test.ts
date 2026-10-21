import { describe, expect, it } from 'vitest'
import { ACTIVITY_BODY_LIMIT, activityBodySize, CutBodies, cutActivityBodies, cutText, utf8Bytes } from '../../../src/shared/activityBodies'
import { agentActivitySchema, type AgentActivity } from '../../../src/shared/agentActivity'
import { agentActivitySignature } from '../../../src/shared/agentThreadDetail'
import { activityInput } from '../../../src/renderer/src/agents/threadActivityView'

const record = (patch: Partial<AgentActivity>): AgentActivity => ({ id: 'a1', turnId: 't1', sequence: 0, kind: 'command', status: 'completed', title: 'Ran npm test', ...patch })
/** `count` lines of `width` characters each, numbered so a test can tell which end a cut kept. */
const lines = (count: number, width = 40): string => Array.from({ length: count }, (_, index) => `line ${String(index).padStart(4, '0')} `.padEnd(width, 'x')).join('\n')

describe('cut bodies', () => {
  it('counts UTF-8 bytes, a surrogate pair as four', () => {
    expect(utf8Bytes('abc')).toBe(3)
    expect(utf8Bytes('é')).toBe(2)
    expect(utf8Bytes('€')).toBe(3)
    expect(utf8Bytes('😀')).toBe(4)
    expect(utf8Bytes('a😀b')).toBe(Buffer.byteLength('a😀b'))
  })

  it('keeps the start of text up to the last line break inside the limit', () => {
    const value = lines(200)
    const kept = cutText(value, 'start')
    expect(utf8Bytes(kept)).toBeLessThanOrEqual(ACTIVITY_BODY_LIMIT)
    expect(value.startsWith(kept)).toBe(true)
    expect(value[kept.length]).toBe('\n')
    expect(kept.startsWith('line 0000')).toBe(true)
    // Every whole line that fits is kept: one more would not fit.
    expect(utf8Bytes(value.slice(0, value.indexOf('\n', kept.length + 1)))).toBeGreaterThan(ACTIVITY_BODY_LIMIT)
  })

  it('keeps the end of output from the first line break inside the limit', () => {
    const value = lines(200)
    const kept = cutText(value, 'end')
    expect(utf8Bytes(kept)).toBeLessThanOrEqual(ACTIVITY_BODY_LIMIT)
    expect(value.endsWith(kept)).toBe(true)
    expect(value[value.length - kept.length - 1]).toBe('\n')
    expect(kept.endsWith('line 0199 '.padEnd(40, 'x'))).toBe(true)
  })

  it('keeps nothing of a window with no line break in it', () => {
    expect(cutText('x'.repeat(5_000), 'start')).toBe('')
    expect(cutText('x'.repeat(5_000), 'end')).toBe('')
  })

  it('keeps a window that ends exactly at a line break whole', () => {
    const value = 'a'.repeat(ACTIVITY_BODY_LIMIT) + '\n' + 'b'.repeat(10)
    expect(cutText(value, 'start')).toBe('a'.repeat(ACTIVITY_BODY_LIMIT))
    const tail = 'b'.repeat(10) + '\n' + 'a'.repeat(ACTIVITY_BODY_LIMIT)
    expect(cutText(tail, 'end')).toBe('a'.repeat(ACTIVITY_BODY_LIMIT))
  })

  it('never splits a surrogate pair', () => {
    // 2,047 bytes of ASCII, then an emoji that would end at byte 2,051: the window stops before it.
    const start = 'a'.repeat(ACTIVITY_BODY_LIMIT - 1) + '😀\nrest'
    const keptStart = cutText('x\n' + start.slice(2), 'start')
    expect(keptStart).toBe('x')
    const value = 'a\n' + '😀'.repeat(600)
    for (const keep of ['start', 'end'] as const) {
      const kept = cutText(value, keep, 2_049)
      expect(kept).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u)
    }
    // A window that cuts mid-emoji at the end keeps whole code points only.
    const emojiLines = Array.from({ length: 400 }, () => '😀😀😀').join('\n')
    const end = cutText(emojiLines, 'end')
    expect(end).toMatch(/^(😀😀😀\n)*😀😀😀$/u)
    expect(utf8Bytes(end)).toBeLessThanOrEqual(ACTIVITY_BODY_LIMIT)
  })

  it('leaves a body of exactly 2,048 bytes whole and cuts one of 2,049', () => {
    const exact = lines(60, 39).slice(0, ACTIVITY_BODY_LIMIT)
    expect(utf8Bytes(exact)).toBe(ACTIVITY_BODY_LIMIT)
    const whole = record({ output: exact })
    expect(cutActivityBodies(whole)).toBe(whole)
    const over = record({ output: exact + 'y' })
    const cut = cutActivityBodies(over)
    expect(cut.cut).toEqual({ output: ACTIVITY_BODY_LIMIT + 1 })
    expect(over.output!.endsWith(cut.output!)).toBe(true)
  })

  it('sends a record with no body over the limit as it is, without cut', () => {
    const small = record({ output: 'ok', text: 'short', changes: [{ path: 'a.ts', kind: 'edit', diff: '+one' }] })
    expect(cutActivityBodies(small)).toBe(small)
    expect('cut' in cutActivityBodies(small)).toBe(false)
  })

  it('cuts output at its end, text and diffs at their start, and names each whole size', () => {
    const output = lines(300), text = lines(120), diff = lines(90)
    const whole = record({ kind: 'file-change', output, text, command: 'npm test', cwd: '/srv/sotto',
      changes: [{ path: 'small.ts', kind: 'edit', diff: '+tiny' }, { path: 'big.ts', kind: 'edit', diff }] })
    const cut = cutActivityBodies(whole)
    expect(cut.cut).toEqual({ output: utf8Bytes(output), text: utf8Bytes(text), diffs: [{ index: 1, bytes: utf8Bytes(diff) }] })
    expect(output.endsWith(cut.output!)).toBe(true)
    expect(text.startsWith(cut.text!)).toBe(true)
    expect(diff.startsWith(cut.changes![1]!.diff!)).toBe(true)
    expect(cut.changes![0]).toBe(whole.changes![0])
    // Every other field goes whole, and the record still reads under the shared schema.
    expect({ ...cut, output: whole.output, text: whole.text, changes: whole.changes, cut: undefined }).toEqual({ ...whole, cut: undefined })
    expect(agentActivitySchema.parse(cut)).toEqual(cut)
    expect(whole.cut).toBeUndefined()
  })

  it('keeps tool input JSON valid and its short fields whole', () => {
    const input = { file_path: '/srv/sotto/src/main/hosts/hostRouter.ts', content: lines(400), mode: 'write' }
    const whole = record({ kind: 'file-change', text: JSON.stringify(input, null, 2), changes: [{ path: input.file_path, kind: 'Write' }] })
    const cut = cutActivityBodies(whole)
    expect(utf8Bytes(cut.text!)).toBeLessThanOrEqual(ACTIVITY_BODY_LIMIT)
    const parsed = JSON.parse(cut.text!) as typeof input
    expect(parsed.file_path).toBe(input.file_path)
    expect(parsed.mode).toBe('write')
    expect(input.content.startsWith(parsed.content)).toBe(true)
    expect(parsed.content.length).toBeGreaterThan(1_000)
    // The desktop's preview still finds the file path.
    expect(activityInput(cut)?.file_path).toBe(input.file_path)
    expect(cut.cut).toEqual({ text: utf8Bytes(whole.text!) })
  })

  it('shortens every long string in a JSON array', () => {
    const value = [lines(100), { pattern: 'needle', body: lines(100) }]
    const cut = cutActivityBodies(record({ kind: 'tool', text: JSON.stringify(value) }))
    const parsed = JSON.parse(cut.text!) as [string, { pattern: string; body: string }]
    expect(parsed[1].pattern).toBe('needle')
    expect(utf8Bytes(cut.text!)).toBeLessThanOrEqual(ACTIVITY_BODY_LIMIT)
  })

  it('compacts pretty-printed JSON that then fits without marking it cut', () => {
    const input = Object.fromEntries(Array.from({ length: 120 }, (_, index) => [`k${index}`, index]))
    const text = JSON.stringify(input, null, 16)
    expect(utf8Bytes(text)).toBeGreaterThan(ACTIVITY_BODY_LIMIT)
    const cut = cutActivityBodies(record({ kind: 'tool', text }))
    expect(cut.cut).toBeUndefined()
    expect(JSON.parse(cut.text!)).toEqual(input)
  })

  it('falls back to a plain cut when JSON cannot be made to fit', () => {
    const text = JSON.stringify(Array.from({ length: 900 }, (_, index) => index), null, 1)
    const cut = cutActivityBodies(record({ kind: 'tool', text }))
    expect(text.startsWith(cut.text!)).toBe(true)
    expect(cut.cut).toEqual({ text: utf8Bytes(text) })
  })

  it('cuts thinking as text, never as tool input', () => {
    const text = JSON.stringify({ note: lines(100) })
    const cut = cutActivityBodies(record({ kind: 'reasoning', title: 'Thinking', text }))
    expect(text.startsWith(cut.text!)).toBe(true)
  })

  it('reads a cut body at its whole size', () => {
    const cut = cutActivityBodies(record({ output: lines(200) }))
    expect(activityBodySize(cut, 'output')).toBe(utf8Bytes(lines(200)))
    expect(activityBodySize(record({ output: 'ok' }), 'output')).toBe(2)
    expect(activityBodySize(record({}), 'text')).toBeUndefined()
  })

  it('gives a cut record a new signature when its whole grows, even if the kept part does not', () => {
    const first = cutActivityBodies(record({ status: 'running', output: lines(200) + '\n' + 'z'.repeat(3_000) }))
    const second = cutActivityBodies(record({ status: 'running', output: lines(200) + '\n' + 'z'.repeat(3_100) }))
    expect(first.output).toBe(second.output)
    expect(agentActivitySignature(first)).not.toBe(agentActivitySignature(second))
    // A record without a cut keeps the signature it always had.
    expect(agentActivitySignature(record({ output: 'ok' }))).not.toContain('=')
  })

  it('makes each cut record once, and again when the record changed in place', () => {
    const bodies = new CutBodies()
    const whole = record({ output: lines(200) })
    const first = bodies.record(whole)
    expect(bodies.record(whole)).toBe(first)
    whole.output = lines(260)
    expect(bodies.record(whole)).not.toBe(first)
    expect(bodies.record(whole).cut?.output).toBe(utf8Bytes(lines(260)))
  })

  it('cuts every record a delta carries and leaves removals alone', () => {
    const bodies = new CutBodies()
    const delta = bodies.delta({ threadId: 'th', baseRevision: 1, revision: 2, messageDeltas: [], activityDeltas: [{ record: record({ output: lines(200) }) }, { id: 'gone', removed: true }] })
    expect(delta.activityDeltas[0]).toMatchObject({ record: { cut: { output: utf8Bytes(lines(200)) } } })
    expect(delta.activityDeltas[1]).toEqual({ id: 'gone', removed: true })
  })

  it('validates cut on the shared schema', () => {
    expect(agentActivitySchema.safeParse(record({ cut: { diffs: [{ index: 200, bytes: 1 }] } })).success).toBe(false)
    expect(agentActivitySchema.safeParse(record({ cut: { output: -1 } })).success).toBe(false)
    expect(agentActivitySchema.parse(record({ cut: { output: 5000, diffs: [{ index: 0, bytes: 9000 }] } })).cut).toEqual({ output: 5000, diffs: [{ index: 0, bytes: 9000 }] })
  })
})
