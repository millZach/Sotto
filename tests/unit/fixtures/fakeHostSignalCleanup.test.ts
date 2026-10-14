// @vitest-environment node
import fs from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FAKE_HOST_MARKER, fakeHostKill } from '../../fixtures/fakeHostSignalCleanup.mjs'

const directories: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function ownedLease() {
  const directory = await mkdtemp(join(tmpdir(), 'sotto-fake-host-signals-'))
  directories.push(directory)
  const lock = join(directory, 'host-listener.lock'), descriptor = join(directory, 'host-listener.json')
  const lease = { fixture: FAKE_HOST_MARKER, pid: 42, nonce: 'owned-lease', instance: 'owned-instance' }
  const owner = { fixture: FAKE_HOST_MARKER, pid: 42, instance: 'owned-instance' }
  await writeFile(lock, JSON.stringify(lease)); await writeFile(descriptor, JSON.stringify(owner))
  return { directory, lock, descriptor, lease, owner }
}
const gone = () => Object.assign(new Error('No such process'), { code: 'ESRCH' })

describe('Windows synthetic host signal cleanup', () => {
  it('retires only the captured lease when the existing caller first observes native ESRCH', async () => {
    const fixture = await ownedLease(), error = gone()
    const native = vi.fn((_pid: number, signal: string | number) => { if (signal === 0) throw error; return true })
    const kill = fakeHostKill(fixture.directory, native, 'win32')
    kill(42, 'SIGTERM')
    expect(await readFile(fixture.lock, 'utf8')).toBe(JSON.stringify(fixture.lease))
    let thrown: unknown
    try { kill(42, 0) } catch (caught) { thrown = caught }
    expect(thrown).toBe(error)
    await expect(readFile(fixture.lock)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(native.mock.calls).toEqual([[42, 'SIGTERM'], [42, 0]])
    expect(await readFile(fixture.descriptor, 'utf8')).toBe(JSON.stringify(fixture.owner))
  })

  it.each(['alive (including PID reuse)', 'EPERM'])('keeps the captured lease while native liveness reports %s', async status => {
    const fixture = await ownedLease()
    const error = Object.assign(new Error('Permission denied'), { code: 'EPERM' })
    const native = vi.fn((_pid: number, signal: string | number) => { if (signal === 0 && status === 'EPERM') throw error; return true })
    const kill = fakeHostKill(fixture.directory, native, 'win32')
    kill(42, 'SIGTERM')
    if (status === 'EPERM') expect(() => kill(42, 0)).toThrow(error)
    else expect(kill(42, 0)).toBe(true)
    expect(await readFile(fixture.lock, 'utf8')).toBe(JSON.stringify(fixture.lease))
    expect(native.mock.calls).toEqual([[42, 'SIGTERM'], [42, 0]])
  })

  it.each(['lease', 'descriptor'])('keeps a replacement %s after the captured owner exits', async replacement => {
    const fixture = await ownedLease(), error = gone()
    const native = vi.fn((_pid: number, signal: string | number) => { if (signal === 0) throw error; return true })
    const kill = fakeHostKill(fixture.directory, native, 'win32')
    kill(42, 'SIGTERM')
    if (replacement === 'lease') await writeFile(fixture.lock, JSON.stringify({ ...fixture.lease, nonce: 'replacement-lease' }))
    else await writeFile(fixture.descriptor, JSON.stringify({ ...fixture.owner, instance: 'replacement-instance' }))
    const before = await readFile(fixture.lock, 'utf8')
    expect(() => kill(42, 0)).toThrow(error)
    expect(await readFile(fixture.lock, 'utf8')).toBe(before)
  })

  it.each(['unmarked lease', 'unmarked descriptor', 'different instance', 'different PID'])('refuses cleanup for %s', async mismatch => {
    const fixture = await ownedLease(), error = gone()
    if (mismatch === 'unmarked lease') await writeFile(fixture.lock, JSON.stringify({ ...fixture.lease, fixture: 'another-host' }))
    else await writeFile(fixture.descriptor, JSON.stringify({ ...fixture.owner,
      ...(mismatch === 'unmarked descriptor' ? { fixture: 'another-host' } : mismatch === 'different instance' ? { instance: 'another-instance' } : { pid: 43 }) }))
    const before = await readFile(fixture.lock, 'utf8')
    const native = vi.fn((_pid: number, signal: string | number) => { if (signal === 0) throw error; return true })
    const kill = fakeHostKill(fixture.directory, native, 'win32')
    kill(42, 'SIGTERM')
    expect(() => kill(42, 0)).toThrow(error)
    expect(await readFile(fixture.lock, 'utf8')).toBe(before)
  })

  it('does not infer a grant from ESRCH without a successful captured SIGTERM', async () => {
    const fixture = await ownedLease(), error = gone()
    const native = vi.fn(() => { throw error })
    const kill = fakeHostKill(fixture.directory, native, 'win32')
    expect(() => kill(42, 0)).toThrow(error)
    expect(() => kill(42, 'SIGTERM')).toThrow(error)
    expect(() => kill(42, 0)).toThrow(error)
    expect(await readFile(fixture.lock, 'utf8')).toBe(JSON.stringify(fixture.lease))
  })

  it('preserves native signals and errors when fixture identity cannot be read', async () => {
    const fixture = await ownedLease(), error = gone()
    const native = vi.fn((_pid: number, signal: string | number) => { if (signal === 0) throw error; return true })
    vi.spyOn(fs, 'readFileSync').mockImplementation(() => { throw Object.assign(new Error('Denied'), { code: 'EACCES' }) })
    const kill = fakeHostKill(fixture.directory, native, 'win32')
    expect(kill(42, 'SIGTERM')).toBe(true)
    expect(() => kill(42, 0)).toThrow(error)
    expect(native.mock.calls).toEqual([[42, 'SIGTERM'], [42, 0]])
    expect(await readFile(fixture.lock, 'utf8')).toBe(JSON.stringify(fixture.lease))
  })

  it('preserves the native ESRCH and lease when removal is denied', async () => {
    const fixture = await ownedLease(), error = gone()
    const native = vi.fn((_pid: number, signal: string | number) => { if (signal === 0) throw error; return true })
    const kill = fakeHostKill(fixture.directory, native, 'win32')
    kill(42, 'SIGTERM')
    vi.spyOn(fs, 'rmSync').mockImplementation(() => { throw Object.assign(new Error('Denied'), { code: 'EACCES' }) })
    let thrown: unknown
    try { kill(42, 0) } catch (caught) { thrown = caught }
    expect(thrown).toBe(error)
    expect(await readFile(fixture.lock, 'utf8')).toBe(JSON.stringify(fixture.lease))
  })

  it('leaves non-Windows callers unchanged', async () => {
    const fixture = await ownedLease(), native = vi.fn(() => true)
    expect(fakeHostKill(fixture.directory, native, 'linux')).toBe(native)
    expect(fakeHostKill(fixture.directory, native, 'darwin')).toBe(native)
    expect(native).not.toHaveBeenCalled()
  })
})
