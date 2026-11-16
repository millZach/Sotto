// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SoundRecords, type SoundRecord } from '../../../../../src/main/tools/elevenlabs/records'

/** The record of sounds (ADR-0205; slice 12, part 2): what the month's spending is counted from. Every account is made up. */
const STUDIO = '55555555-5555-4555-8555-000000000001'
const OTHER = '55555555-5555-4555-8555-000000000002'
let directory: string
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'sotto-sound-records-')) })
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

const NOW = new Date(2026, 10, 15, 12)
let next = 0
const sound = (extra: Partial<SoundRecord> = {}): SoundRecord => ({
  id: `sound-${++next}`, threadId: 'one', accountId: STUDIO, kind: 'speech', name: 'Welcome video', words: 'Welcome to Lumen.', voice: 'Rachel',
  folder: join(directory, 'sounds'), fileName: 'Welcome video.mp3', bytes: 2_048, cost: 0.5, askedAt: new Date(2026, 10, 10).toISOString(), state: 'made', ...extra,
})
const file = async (): Promise<string> => readFile(join(directory, 'sounds.json'), 'utf8')

describe('the record of sounds', () => {
  it('counts each account’s sounds this month from the 1st by this computer’s clock, made and being made, and no failed one', async () => {
    const records = new SoundRecords(directory, { historyEnabled: () => true, now: () => NOW })
    await records.add(sound({ cost: 0.5 }))
    await records.add(sound({ cost: 0.25, state: 'making', askedAt: new Date(2026, 10, 1, 0, 0, 1).toISOString() }))
    await records.add(sound({ cost: 0, state: 'failed', failure: 'rejected' }))
    await records.add(sound({ cost: 2, askedAt: new Date(2026, 9, 31, 23, 59).toISOString() }))
    await records.add(sound({ cost: 0.1, accountId: OTHER }))
    const spent = await records.monthSpent()
    expect(spent.get(STUDIO)).toBeCloseTo(0.75, 9)
    expect(spent.get(OTHER)).toBeCloseTo(0.1, 9)
  })

  it('keeps the words sent only while Keep local history is on, and takes them out of the file when it is turned off', async () => {
    let history = true
    const records = new SoundRecords(directory, { historyEnabled: () => history })
    await records.add(sound())
    expect(await file()).toContain('Welcome to Lumen.')
    history = false
    await records.privacyChanged()
    expect(await file()).not.toContain('Welcome to Lumen.')
    expect((await records.list())[0]).toMatchObject({ name: 'Welcome video', voice: 'Rachel', fileName: 'Welcome video.mp3' })
    expect((await records.list())[0]!.words).toBeUndefined()
    // Added with it off, none are kept.
    await records.add(sound({ words: 'Thank you for shopping.' }))
    expect(await file()).not.toContain('Thank you for shopping.')
    // Read again from the file by a new start, still none.
    expect((await new SoundRecords(directory, { historyEnabled: () => false }).list()).every(record => record.words === undefined)).toBe(true)
  })

  it('forgets a thread’s sounds and keeps what they cost this month, by account and when alone', async () => {
    const records = new SoundRecords(directory, { historyEnabled: () => true, now: () => NOW })
    await records.add(sound({ threadId: 'gone', cost: 0.5 }))
    await records.add(sound({ threadId: 'gone', cost: 0, state: 'failed', failure: 'busy' }))
    await records.add(sound({ threadId: 'kept', cost: 0.25 }))
    await records.forgetThreads(['gone'])
    expect((await records.list()).map(record => record.threadId)).toEqual(['kept'])
    expect((await records.monthSpent()).get(STUDIO)).toBeCloseTo(0.75, 9)
    // The ledger holds the account, the cost and when it was asked for, and nothing of the sound itself.
    const kept = JSON.parse(await file()) as { spent: Record<string, unknown>[] }
    expect(kept.spent).toEqual([{ accountId: STUDIO, askedAt: new Date(2026, 10, 10).toISOString(), cost: 0.5 }])
    // And across a restart.
    expect((await new SoundRecords(directory, { historyEnabled: () => true, now: () => NOW }).monthSpent()).get(STUDIO)).toBeCloseTo(0.75, 9)
  })

  it('keeps the cost of the oldest records past the most kept', async () => {
    const records = new SoundRecords(directory, { historyEnabled: () => true, kept: 2, now: () => NOW })
    for (const cost of [0.1, 0.2, 0.3]) await records.add(sound({ cost }))
    expect(await records.list()).toHaveLength(2)
    expect((await records.monthSpent()).get(STUDIO)).toBeCloseTo(0.6, 9)
  })

  it('takes back the cost of a sound whose thread was forgotten while it was made, once it is known not to be made', async () => {
    const records = new SoundRecords(directory, { historyEnabled: () => true, now: () => NOW })
    const making = await records.add(sound({ cost: 0.5, state: 'making', fileName: undefined, bytes: undefined }))
    await records.add(sound({ cost: 0.25, threadId: 'two' }))
    await records.forgetThreads(['one'])
    expect((await records.monthSpent()).get(STUDIO)).toBeCloseTo(0.75, 9)
    expect(await records.update(making.id, record => ({ ...record, state: 'failed', cost: 0 }))).toBeUndefined()
    await records.refundForgotten(making.id)
    expect((await records.monthSpent()).get(STUDIO)).toBeCloseTo(0.25, 9)
    // A made sound's cost in the ledger is never taken back.
    await records.refundForgotten('sound-unknown')
    expect((await records.monthSpent()).get(STUDIO)).toBeCloseTo(0.25, 9)
  })

  it('refuses to count a month from a file it cannot read, and leaves the file as it was', async () => {
    await writeFile(join(directory, 'sounds.json'), '{"version":1,"sounds":[')
    const records = new SoundRecords(directory, { historyEnabled: () => true, now: () => NOW })
    await expect(records.monthSpent()).rejects.toThrow()
    await expect(records.add(sound())).rejects.toThrow()
    expect(await file()).toBe('{"version":1,"sounds":[')
  })

  it('writes a change it could not write with the next one, so a refused sound is not left counted', async () => {
    const records = new SoundRecords(directory, { historyEnabled: () => true, now: () => NOW })
    const making = await records.add(sound({ cost: 0.5, state: 'making', fileName: undefined, bytes: undefined }))
    // The next write cannot be made: its file's place is taken by a folder.
    await mkdir(join(directory, 'sounds.json.next'))
    await expect(records.update(making.id, record => ({ ...record, state: 'failed', failure: 'rejected', cost: 0 }))).rejects.toThrow()
    // Read before it is written, the record is as the change says, and so is the month (Bug Bot on #2653, L2).
    expect(await records.sound(making.id)).toMatchObject({ state: 'failed', cost: 0 })
    expect((await records.list()).find(record => record.id === making.id)).toMatchObject({ state: 'failed', cost: 0 })
    expect((await records.monthSpent()).get(STUDIO) ?? 0).toBe(0)
    await rm(join(directory, 'sounds.json.next'), { recursive: true })
    await records.add(sound({ cost: 0.1 }))
    expect((await records.list()).find(record => record.id === making.id)).toMatchObject({ state: 'failed', cost: 0 })
    expect((await records.monthSpent()).get(STUDIO)).toBeCloseTo(0.1, 9)
    expect(JSON.parse(await file()).sounds.find((record: SoundRecord) => record.id === making.id).state).toBe('failed')
  })

  it('settles a sound cut off when Sotto last stopped as stopped, its cost still counted', async () => {
    const before = new SoundRecords(directory, { historyEnabled: () => true, now: () => NOW })
    await before.add(sound({ state: 'making', cost: 0.4 }))
    const after = new SoundRecords(directory, { historyEnabled: () => true, now: () => NOW })
    await after.settleUnfinished()
    expect((await after.list())[0]).toMatchObject({ state: 'failed', failure: 'stopped', cost: 0.4 })
    expect((await after.monthSpent()).get(STUDIO)).toBeCloseTo(0.4, 9)
  })

  it('reads what it kept again on the next start', async () => {
    const records = new SoundRecords(directory, { historyEnabled: () => true })
    await records.add(sound())
    const again = new SoundRecords(directory, { historyEnabled: () => true })
    expect(await again.list()).toHaveLength(1)
  })
})
