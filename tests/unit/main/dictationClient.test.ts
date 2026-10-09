// @vitest-environment node
import { EventEmitter } from 'node:events'
import type { Stats } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { lstat, readlink, connect } = vi.hoisted(() => ({ lstat: vi.fn(), readlink: vi.fn(), connect: vi.fn() }))
vi.mock('node:fs', () => ({ lstatSync: lstat, readlinkSync: readlink }))
vi.mock('node:net', () => ({ createConnection: connect }))

describe('dictation command client endpoint validation', () => {
  const entries = new Map<string, Stats>()
  const folder = join('/run/user/1000', 'sotto')
  const endpoint = join(folder, 'dictation.sock')
  const privateName = 'dictation-123-1a2b3c4d.sock'
  const privatePath = join(folder, privateName)
  const originalArgv = process.argv
  const originalExitCode = process.exitCode
  const originalGetuid = process.getuid
  let guidance: ReturnType<typeof vi.spyOn>
  function stat(kind: 'directory' | 'socket' | 'link' | 'file', uid = 1000, mode = 0o700): Stats {
    return { uid, mode, dev: 1, ino: 1, isDirectory: () => kind === 'directory',
      isSocket: () => kind === 'socket', isSymbolicLink: () => kind === 'link' } as Stats
  }
  beforeEach(() => {
    vi.resetModules()
    process.getuid = vi.fn(() => 1000)
    vi.stubEnv('XDG_RUNTIME_DIR', '/run/user/1000')
    guidance = vi.spyOn(console, 'error').mockImplementation(() => {})
    process.argv = ['node', 'dictationClient.js', 'dictation', 'start']
    process.exitCode = undefined
    entries.clear()
    for (const path of ['/', '/run', '/run/user']) entries.set(path, stat('directory', 0, 0o755))
    entries.set('/run/user/1000', stat('directory'))
    entries.set(folder, stat('directory'))
    entries.set(endpoint, stat('link'))
    entries.set(privatePath, stat('socket', 1000, 0o600))
    lstat.mockImplementation(path => {
      if (!entries.has(path)) throw Object.assign(new Error('Missing fixture'), { code: 'ENOENT' })
      return entries.get(path)
    })
    readlink.mockReturnValue(privateName)
  })
  afterEach(() => {
    process.argv = originalArgv
    process.exitCode = originalExitCode
    if (originalGetuid === undefined) Reflect.deleteProperty(process, 'getuid')
    else process.getuid = originalGetuid
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    lstat.mockReset(); readlink.mockReset(); connect.mockReset()
  })
  async function refuses(): Promise<void> {
    await import('../../../src/main/hotkeys/dictationClient')
    expect(connect).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
    expect(guidance).toHaveBeenCalledWith('Sotto’s dictation socket is unavailable. Open Sotto in this desktop session, then try again.')
  }

  it('refuses sotto as a symlink', async () => { entries.set(folder, stat('link')); await refuses() })
  it.each([0o755, 0o1700])('refuses folder permissions %s', async mode => {
    entries.set(folder, stat('directory', 1000, mode)); await refuses()
  })
  it('refuses a foreign-owned folder', async () => { entries.set(folder, stat('directory', 2000)); await refuses() })
  it('refuses a foreign-owned direct socket', async () => { entries.set(endpoint, stat('socket', 2000)); await refuses() })
  it('refuses a foreign-owned private target', async () => { entries.set(privatePath, stat('socket', 2000)); await refuses() })
  it('refuses a foreign-owned public link', async () => { entries.set(endpoint, stat('link', 2000)); await refuses() })
  it.each(['/tmp/dictation-123-1a2b3c4d.sock', '../dictation-123-1a2b3c4d.sock', 'other.sock', 'dictation-123-1a2b3c4d.sock\n'])('refuses a link to %s', async target => {
    readlink.mockReturnValue(target); await refuses()
  })
  it.each(['file', 'link', 'directory'] as const)('refuses a link to a %s', async kind => {
    entries.set(privatePath, stat(kind)); await refuses()
  })
  it('refuses a missing private target', async () => { entries.delete(privatePath); await refuses() })
  it.each(['link', 'socket'] as const)('sends the command and accepts the reply through an owned %s', async kind => {
    entries.set(endpoint, stat(kind, 1000, 0o600))
    const socket = Object.assign(new EventEmitter(), {
      setTimeout: vi.fn(), setEncoding: vi.fn(), write: vi.fn(), destroy: vi.fn(),
    })
    connect.mockReturnValue(socket)
    await import('../../../src/main/hotkeys/dictationClient')
    expect(connect).toHaveBeenCalledWith(kind === 'link' ? privatePath : endpoint)
    socket.emit('connect')
    expect(socket.write).toHaveBeenCalledWith('start\n')
    socket.emit('data', 'ok\n')
    socket.emit('end')
    expect(process.exitCode).toBeUndefined()
    expect(guidance).not.toHaveBeenCalled()
  })
  it('passes the binding stamp through without replacing it with client startup time', async () => {
    process.argv.push('--at', '1791486000123456789')
    const socket = Object.assign(new EventEmitter(), {
      setTimeout: vi.fn(), setEncoding: vi.fn(), write: vi.fn(), destroy: vi.fn(),
    })
    connect.mockReturnValue(socket)
    await import('../../../src/main/hotkeys/dictationClient')
    socket.emit('connect')
    expect(socket.write).toHaveBeenCalledWith('start --at 1791486000123456789\n')
  })
})
