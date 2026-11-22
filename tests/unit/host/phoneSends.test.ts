// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PHONE_SENDS_FILE, PHONE_SENDS_PER_RUN, PHONE_SENDS_SWITCH_FILE, PHONE_SENDS_WINDOW_MS, phoneSends, phoneSendsFor, type PhoneSendsLine } from '../../../src/host/phoneSends'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

function recorder() {
  const lines: PhoneSendsLine[] = []
  let at = Date.UTC(2026, 10, 20, 12)
  const sends = phoneSends(line => lines.push(line), () => at)
  return { lines, sends, pass: (ms: number) => { at += ms } }
}

describe('what each phone is sent (#2755)', () => {
  it('writes one line a window for each phone, by kind and by thread', () => {
    const { lines, sends, pass } = recorder()
    const phone = {}, other = {}
    sends.sent(phone, 'detail-delta', 300, 'thread-a')
    sends.sent(phone, 'detail-delta', 200, 'thread-a')
    sends.sent(phone, 'answer', 50, undefined, 'observe')
    sends.sent(phone, 'answer', 400, undefined, 'detail')
    sends.sent(phone, 'answer', 250, undefined, 'detail')
    sends.sent(other, 'shell', 1_000)
    expect(lines).toEqual([])
    pass(PHONE_SENDS_WINDOW_MS)
    sends.sent(phone, 'shell', 10)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ phone: 1, seconds: 10, kinds: { 'detail-delta': { frames: 2, bytes: 500 }, answer: { frames: 3, bytes: 700 } },
      answers: { observe: { frames: 1, bytes: 50 }, detail: { frames: 2, bytes: 650 } },
      threads: { 'thread-a': { frames: 2, bytes: 500 } } })
    sends.flush()
    expect(lines.map(line => line.phone)).toEqual([1, 1, 2])
    expect(lines[1]!.kinds).toEqual({ shell: { frames: 1, bytes: 10 } })
    expect(lines[1]!.answers).toEqual({})
    expect(lines[2]!.answers).toEqual({})
  })

  it('ignores an answer op on non-answer pushes', () => {
    const { lines, sends } = recorder()
    const phone = {}
    sends.sent(phone, 'detail', 120, 'thread-a', 'detail')
    sends.flush()
    expect(lines[0]!.kinds).toEqual({ detail: { frames: 1, bytes: 120 } })
    expect(lines[0]!.answers).toEqual({})
  })

  it('names the parts a shell carried whole and the record fields that changed, never a value', () => {
    const { lines, sends } = recorder()
    const phone = {}
    const first = { id: 'thread-a', title: 'Secret title', status: 'running', usage: { contextUsed: 1 } }
    sends.shell(phone, { kept: ['models'], watcher: { conversation: ['words'] }, host: { kept: ['projects'], threads: [], revision: 3 } }, [first])
    const second = { ...first, status: 'idle', usage: { contextUsed: 1 } }
    sends.shell(phone, { host: { threads: [] } }, [second])
    sends.flush()
    const line = lines[0]!
    expect(Object.keys(line.parts).sort()).toEqual(['host.revision', 'watcher'])
    expect(line.parts.watcher!.frames).toBe(1)
    expect(line.fields).toEqual({ '(new record)': 1, status: 1 })
    expect(JSON.stringify(lines)).not.toContain('Secret title')
    expect(JSON.stringify(lines)).not.toContain('words')
  })

  it('writes a closed phone\'s window and forgets it', () => {
    const { lines, sends } = recorder()
    const phone = {}
    sends.sent(phone, 'shell', 10)
    sends.ended(phone)
    sends.ended(phone)
    sends.flush()
    expect(lines).toHaveLength(1)
  })

  it(`stops at ${PHONE_SENDS_PER_RUN} lines a run`, () => {
    const { lines, sends } = recorder()
    for (let index = 0; index < PHONE_SENDS_PER_RUN + 5; index++) { const phone = {}; sends.sent(phone, 'shell', 1); sends.ended(phone) }
    expect(lines).toHaveLength(PHONE_SENDS_PER_RUN)
  })

  it('is off until its switch is on, and then appends to its file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-phone-sends-')); roots.push(root)
    expect(phoneSendsFor(root, {})).toBeUndefined()
    await writeFile(join(root, PHONE_SENDS_SWITCH_FILE), '')
    const sends = phoneSendsFor(root, {})!
    sends.sent({}, 'shell', 10)
    sends.flush()
    await expect.poll(async () => readFile(join(root, PHONE_SENDS_FILE), 'utf8').catch(() => '')).toContain('"shell":{"frames":1,"bytes":10}')
    const byEnvironment = await mkdtemp(join(tmpdir(), 'sotto-phone-sends-')); roots.push(byEnvironment)
    expect(phoneSendsFor(byEnvironment, { SOTTO_PHONE_SEND_DIAGNOSTICS: '1' })).toBeDefined()
  })
})
