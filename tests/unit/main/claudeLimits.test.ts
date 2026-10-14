// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ClaudeLimits, readClaudeLimits, type ClaudeControl } from '../../../src/main/agents/claudeLimits'
import { ClaudeRejected } from '../../../src/main/agents/claudeProtocol'
import recordedUsage from '../../fixtures/claudeUsageAnswer.json'

const fake = resolve('tests/fixtures/fakeClaudeUsage.mjs')
const now = () => new Date('2099-10-14T18:00:00.000Z')
let root = ''
let log = ''
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'sotto-claude-limits-')); log = join(root, 'spawns.jsonl') })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

const probe = (mode: string, extra: Record<string, unknown> = {}, delay = 50) => ({
  executable: process.execPath, prefixArgs: [fake, mode, log, String(delay)], environment: { ...process.env }, workingDirectory: root, now, ...extra,
})
const spawns = async (): Promise<Array<{ flags: string[]; cwd: string }>> =>
  (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line) as { flags: string[]; cwd: string })
const ids = (read: { windows: Array<{ id: string }> }) => read.windows.map(window => window.id)

describe('reading Claude limits through a live runtime', () => {
  it('sends get_usage without the transcript scan and reads the answer', async () => {
    const control = vi.fn<ClaudeControl>(async () => recordedUsage)
    const result = await readClaudeLimits({ control, now })
    expect(control).toHaveBeenCalledTimes(1)
    expect(control).toHaveBeenCalledWith({ subtype: 'get_usage', skip_behaviors: true })
    expect(result).toMatchObject({ providerId: 'claude', status: 'available', refreshable: true, observedAt: now().toISOString() })
    expect(ids(result).slice(0, 2)).toEqual(['claude-five-hour', 'claude-seven-day'])
  })
  it('lets the installed client decide when a runtime refuses get_usage', async () => {
    const refusing = async (): Promise<Record<string, unknown>> => { throw new ClaudeRejected('no') }
    expect(await readClaudeLimits({ control: refusing, ...probe('usage') })).toMatchObject({ status: 'available', refreshable: true })
    expect(await readClaudeLimits({ control: refusing, ...probe('unsupported') }))
      .toMatchObject({ status: 'unavailable', reason: 'refresh-unavailable', refreshable: false, windows: [] })
    expect(await spawns()).toHaveLength(2)
    // With no client to ask, a runtime's refusal is not taken as the answer.
    expect(await readClaudeLimits({ control: refusing, now })).toMatchObject({ reason: 'refresh-unavailable', refreshable: true })
  })
  it('falls back to a probe when the runtime went away before answering', async () => {
    const result = await readClaudeLimits({ control: async () => { throw new Error('Claude is disconnected.') }, ...probe('usage') })
    expect(result).toMatchObject({ status: 'available', refreshable: true })
    expect(await spawns()).toHaveLength(1)
  })
  it('gives an unavailable read when the runtime never answers, and swallows the late answer', async () => {
    let fail: (error: Error) => void = () => undefined
    const result = await readClaudeLimits({ control: () => new Promise((_, reject) => { fail = reject }), timeoutMs: 30, now })
    expect(result).toMatchObject({ status: 'unavailable', reason: 'refresh-unavailable', refreshable: true })
    fail(new Error('late'))
  })
  it('shares one request among concurrent reads through the same runtime', async () => {
    let answer: (value: Record<string, unknown>) => void = () => undefined
    const control = vi.fn<ClaudeControl>(() => new Promise(done => { answer = done }))
    const reads = [readClaudeLimits({ control, now }), readClaudeLimits({ control, now })]
    answer(recordedUsage)
    const [first, second] = await Promise.all(reads)
    expect(control).toHaveBeenCalledTimes(1)
    expect(second).toBe(first)
    await readClaudeLimits({ control: async () => recordedUsage, now })
    expect(control).toHaveBeenCalledTimes(1)
  })
  it('says the limits cannot be read when it has neither a runtime nor a client', async () => {
    expect(await readClaudeLimits({ now })).toMatchObject({ status: 'unavailable', reason: 'refresh-unavailable', refreshable: true })
  })
})

describe('reading Claude limits through a short probe', () => {
  it('starts Claude Code tool-free with no session file, answers from get_usage, and keeps only the documented windows', async () => {
    const result = await readClaudeLimits(probe('usage'))
    expect(result).toMatchObject({ status: 'available', refreshable: true })
    expect(ids(result)).toEqual(['claude-five-hour', 'claude-seven-day', expect.stringMatching(/^claude-[a-f\d]{24}-model$/u)])
    expect(JSON.stringify(result)).not.toMatch(/tangerine|otter|max|cost|private/u)
    const [spawn] = await spawns()
    expect(spawn?.flags).toEqual(['--print', '--safe-mode', '--tools', '', '--permission-prompts', 'none', '--no-session-persistence',
      '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'])
    expect(resolve(spawn!.cwd)).toBe(resolve(root))
  })
  it('marks a client that answers get_usage with an error as not readable', async () => {
    expect(await readClaudeLimits(probe('unsupported'))).toMatchObject({ status: 'unavailable', reason: 'refresh-unavailable', refreshable: false })
  })
  it('gives up at the deadline on a client that never answers, and when the client exits or fails to start first', async () => {
    const started = Date.now()
    expect(await readClaudeLimits(probe('silent', { timeoutMs: 1_500 }))).toMatchObject({ status: 'unavailable', reason: 'refresh-unavailable', refreshable: true })
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(await readClaudeLimits(probe('exit'))).toMatchObject({ reason: 'refresh-unavailable', refreshable: true })
    expect(await readClaudeLimits(probe('no-init'))).toMatchObject({ reason: 'refresh-unavailable', refreshable: true })
    expect(await readClaudeLimits({ ...probe('usage'), executable: join(root, 'missing-claude.exe') }))
      .toMatchObject({ reason: 'refresh-unavailable', refreshable: true })
  })
  it('coalesces concurrent reads into one probe', async () => {
    const reads = await Promise.all([readClaudeLimits(probe('usage', {}, 200)), readClaudeLimits(probe('usage', {}, 200)), readClaudeLimits(probe('usage', {}, 200))])
    expect(await spawns()).toHaveLength(1)
    expect(reads[1]).toBe(reads[0])
    expect(reads[2]).toBe(reads[0])
    await readClaudeLimits(probe('usage', {}, 0))
    expect(await spawns()).toHaveLength(2)
  })
  it('lets one caller stop waiting without stopping the others, and stops the probe when nobody waits', async () => {
    const leaving = new AbortController()
    const left = readClaudeLimits(probe('usage', { signal: leaving.signal }, 300))
    const staying = readClaudeLimits(probe('usage', {}, 300))
    leaving.abort()
    await expect(left).rejects.toThrow()
    expect(await staying).toMatchObject({ status: 'available' })
    const all = new AbortController()
    const started = Date.now()
    const both = [readClaudeLimits(probe('silent', { signal: all.signal })), readClaudeLimits(probe('silent', { signal: all.signal }))]
    all.abort()
    for (const read of both) await expect(read).rejects.toThrow()
    expect(Date.now() - started).toBeLessThan(5_000)
    await expect(readClaudeLimits(probe('usage', { signal: all.signal }))).rejects.toThrow()
  })
})

describe('the adapter reading', () => {
  const at = new Date('2026-10-12T18:00:00.000Z')
  const reset = Date.parse('2026-10-12T23:00:00.000Z') / 1_000
  const answer = { rate_limits_available: true, rate_limits: { five_hour: { utilization: 40, resets_at: '2026-10-12T23:00:00Z' },
    seven_day: { utilization: 5, resets_at: '2026-10-19T13:00:00Z' } } }
  it('merges passive events and get_usage answers, and asks only on refresh', async () => {
    let clock = at
    const limits = new ClaudeLimits({ now: () => clock })
    const control = vi.fn<ClaudeControl>(async () => answer)
    expect(await limits.read(false, { control })).toMatchObject({ status: 'unavailable', reason: 'not-read', refreshable: true })
    limits.observe({ type: 'rate_limit_event', rate_limit_info: { rateLimitType: 'five_hour', status: 'allowed', resetsAt: reset } })
    limits.observe({ type: 'assistant', message: { content: 'private' } })
    const passive = await limits.read(false, { control })
    expect(passive).toMatchObject({ status: 'available', refreshable: true, windows: [{ id: 'claude-five-hour', status: 'allowed' }] })
    expect(passive.windows[0]).not.toHaveProperty('usedPercent')
    expect(control).not.toHaveBeenCalled()
    clock = new Date('2026-10-12T18:01:00.000Z')
    const fresh = await limits.read(true, { control })
    expect(fresh.windows.map(window => [window.id, window.usedPercent])).toEqual([['claude-five-hour', 40], ['claude-seven-day', 5]])
    clock = new Date('2026-10-12T23:00:00.000Z')
    expect(ids(await limits.read(false, { control }))).toEqual(['claude-seven-day'])
  })
  it('keeps the passive reading and stops asking once the client refuses, until the client changes or it is cleared', async () => {
    const limits = new ClaudeLimits({ now: () => at })
    const source = probe('unsupported')
    limits.observe({ type: 'rate_limit_event', rate_limit_info: { rateLimitType: 'five_hour', status: 'allowed_warning', utilization: 0.8, resetsAt: reset } })
    expect(await limits.read(true, source)).toMatchObject({ status: 'available', refreshable: false, windows: [{ usedPercent: 80 }] })
    await limits.read(true, source)
    expect(await spawns()).toHaveLength(1)
    limits.clientChanged()
    expect(await limits.read(false, source)).toMatchObject({ refreshable: true, windows: [{ usedPercent: 80 }] })
    await limits.read(true, source)
    expect(await spawns()).toHaveLength(2)
    limits.clear()
    expect(await limits.read(false, source)).toMatchObject({ reason: 'not-read', refreshable: true, windows: [] })
  })
  it('shares one refresh among concurrent reads even when each brings its own control function', async () => {
    const limits = new ClaudeLimits({ now: () => at })
    let calls = 0
    const control = (): ClaudeControl => async () => { calls++; await new Promise(done => setTimeout(done, 20)); return answer }
    const stopped = new AbortController()
    const reads = [limits.read(true, { control: control() }), limits.read(true, { control: control() }), limits.read(true, { control: control() }, stopped.signal)]
    stopped.abort()
    await expect(reads[2]).rejects.toThrow()
    const [first, second] = await Promise.all(reads.slice(0, 2))
    expect(calls).toBe(1)
    expect(first).toEqual(second)
    expect(ids(first!)).toEqual(['claude-five-hour', 'claude-seven-day'])
  })
  it('discards an answer that arrives after a reconnect cleared the reading', async () => {
    const limits = new ClaudeLimits({ now: () => at })
    let respond: (value: Record<string, unknown>) => void = () => undefined
    const pending = limits.read(true, { control: () => new Promise(done => { respond = done }) })
    limits.clear()
    respond(answer)
    expect(await pending).toMatchObject({ status: 'unavailable', reason: 'not-read', windows: [] })
  })
})
