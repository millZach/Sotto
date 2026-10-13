// @vitest-environment node
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createOwnedProofProcesses } from '../../../scripts/owned-proof-processes.mjs'

const fixture = vi.hoisted(() => ({ directory: undefined, slice: undefined, discoveries: 0,
  operation: undefined, relative: undefined, code: 'ENOENT', injected: false, commands: [] }))

vi.mock('node:child_process', async importOriginal => {
  const execute = vi.fn(async (executable, args) => {
    fixture.commands.push({ executable, args })
    return { stdout: args[1] === 'show' ? 'inactive\n' : '', stderr: '' }
  })
  return { ...await importOriginal(), execFile: Object.assign(vi.fn(), {
    [Symbol.for('nodejs.util.promisify.custom')]: execute,
  }) }
})

vi.mock('node:fs', async importOriginal => {
  const original = await importOriginal()
  const ownedPath = path => {
    const normalized = String(path).replaceAll('\\', '/')
    const prefix = `/sys/fs/cgroup/user.slice/${fixture.slice}`
    if (normalized !== prefix && !normalized.startsWith(`${prefix}/`)) return undefined
    const relative = normalized.slice(prefix.length).replace(/^\//u, '')
    return { relative, path: join(fixture.directory, 'owned', relative) }
  }
  const disappear = (operation, owned) => {
    if (fixture.injected || fixture.operation !== operation || fixture.relative !== owned.relative) return
    fixture.injected = true
    if (fixture.code !== 'ENOENT') throw Object.assign(new Error(`Synthetic ${fixture.code}`), { code: fixture.code })
    // Remove only this fixture's owned cgroup, then let the real filesystem read produce ENOENT.
    const directory = operation === 'readdir' ? owned.path : join(owned.path, '..')
    original.rmSync(directory, { recursive: true })
  }
  return {
    ...original,
    existsSync: path => {
      const owned = ownedPath(path)
      return original.existsSync(owned?.path ?? path)
    },
    readdirSync: (path, options) => {
      if (path === '/proc') return fixture.discoveries++ === 0 ? ['888', '999'] : ['999']
      const owned = ownedPath(path)
      if (!owned) return original.readdirSync(path, options)
      disappear('readdir', owned)
      return original.readdirSync(owned.path, options)
    },
    readFileSync: (path, options) => {
      if (path === '/proc/888/cgroup') return `0::/user.slice/${fixture.slice}/command.scope\n`
      if (path === '/proc/999/cgroup') return '0::/user.slice/unrelated.scope\n'
      // The recorded owner is already a zombie: cleanup must inspect its collected cgroup, without waiting.
      if (path === '/proc/888/stat') return `888 (owned fixture) ${['Z', ...Array(18).fill('0'), 'fixture-start'].join(' ')}`
      const owned = ownedPath(path)
      if (!owned) return original.readFileSync(path, options)
      disappear('read', owned)
      return original.readFileSync(owned.path, options)
    },
  }
})

beforeEach(() => {
  fixture.directory = mkdtempSync(join(tmpdir(), 'sotto-proof-cgroups-'))
  fixture.slice = undefined; fixture.discoveries = 0; fixture.operation = undefined
  fixture.relative = undefined; fixture.code = 'ENOENT'; fixture.injected = false; fixture.commands = []
  vi.stubEnv('XDG_RUNTIME_DIR', '/run/user/1000')
  vi.stubEnv('DBUS_SESSION_BUS_ADDRESS', 'unix:path=/run/user/1000/bus')
  // There are no real processes or systemd commands in this filesystem race fixture.
  vi.spyOn(process, 'kill').mockImplementation(() => true)
})
afterEach(() => {
  const directory = resolve(fixture.directory)
  if (!directory.startsWith(`${resolve(tmpdir())}${sep}`) || !basename(directory).startsWith('sotto-proof-cgroups-')) throw new Error('Unexpected owned fixture directory')
  rmSync(directory, { recursive: true, force: true })
  vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllEnvs()
})

function ownedFixture(pids = '', events = 'populated 0\n') {
  const report = vi.fn(), owned = createOwnedProofProcesses(report)
  fixture.slice = owned.slice
  mkdirSync(join(fixture.directory, 'owned'))
  writeFileSync(join(fixture.directory, 'owned', 'cgroup.procs'), pids)
  writeFileSync(join(fixture.directory, 'owned', 'cgroup.events'), events)
  return { owned, report }
}

describe('collected proof cgroups disappearing during cleanup', () => {
  it.each([
    { name: 'process-list read', operation: 'read', relative: 'cgroup.procs' },
    { name: 'child enumeration', operation: 'readdir', relative: '' },
    { name: 'population-event read', operation: 'read', relative: 'cgroup.events' },
    { name: 'nested process-list read', operation: 'read', relative: 'child/cgroup.procs' },
  ])('finishes cleanup when an owned cgroup vanishes at its $name', async seam => {
    const { owned, report } = ownedFixture()
    mkdirSync(join(fixture.directory, 'owned', 'child'))
    writeFileSync(join(fixture.directory, 'owned', 'child', 'cgroup.procs'), '')
    fixture.operation = seam.operation; fixture.relative = seam.relative
    await expect(owned.stop()).resolves.toBeUndefined()
    expect(fixture.injected).toBe(true)
    expect(report).toHaveBeenCalledWith('Proof cgroup processes after cleanup: []')
    expect(report).toHaveBeenCalledWith('Owned processes still running: []')
    expect(process.kill).not.toHaveBeenCalled()
    expect(fixture.commands.map(command => command.args)).toEqual([
      ['--user', 'stop', owned.slice], ['--user', 'show', owned.slice, '--property=ActiveState', '--value'],
    ])
  })

  it.each(['EACCES', 'EIO'].flatMap(code => [
    { code, operation: 'read', relative: 'cgroup.procs' },
    { code, operation: 'readdir', relative: '' },
    { code, operation: 'read', relative: 'cgroup.events' },
  ]))('propagates $code at $operation $relative rather than claiming an unread cgroup is empty', async seam => {
    const { owned } = ownedFixture()
    fixture.operation = seam.operation; fixture.relative = seam.relative; fixture.code = seam.code
    await expect(owned.stop()).rejects.toMatchObject({ code: seam.code })
    expect(fixture.injected).toBe(true)
  })

  it('keeps already-read PIDs when the cgroup vanishes during enumeration', async () => {
    const { owned, report } = ownedFixture('123456\n')
    fixture.operation = 'readdir'; fixture.relative = ''
    await expect(owned.stop()).rejects.toThrow('The proof cgroup must be empty')
    expect(report).toHaveBeenCalledWith('Proof cgroup processes after cleanup: [123456]')
  })

  it('still refuses a collected cgroup that reports populated work', async () => {
    const { owned } = ownedFixture('', 'populated 1\n')
    await expect(owned.stop()).rejects.toMatchObject({ code: 'ERR_ASSERTION', actual: 'populated 1\n' })
    expect(fixture.commands).toHaveLength(1)
  })
})
