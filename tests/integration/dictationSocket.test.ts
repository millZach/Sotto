// @vitest-environment node
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { createConnection, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DictationSocket } from '../../src/main/hotkeys/dictationSocket'
import { DICTATION_REQUEST_MAX_BYTES, dictationSocketPath, type CompositorDictationCommand } from '../../src/main/hotkeys/dictationCommand'
import { validateDictationRuntime } from '../../src/main/hotkeys/dictationRuntime'

describe.skipIf(process.platform !== 'linux')('dictation Unix socket', () => {
  let runtime: string
  const services: DictationSocket[] = []
  beforeEach(() => { runtime = mkdtempSync(join(tmpdir(), 'sotto-')) })
  afterEach(() => { vi.restoreAllMocks(); services.splice(0).forEach(service => service.dispose()); rmSync(runtime, { recursive: true, force: true }) })
  function service(dispatch: (command: CompositorDictationCommand) => Promise<boolean> = vi.fn(async () => true)): DictationSocket {
    const instance = new DictationSocket(runtime, dispatch)
    services.push(instance)
    return instance
  }
  function send(input: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(dictationSocketPath(runtime))
      let reply = ''
      socket.setEncoding('utf8')
      socket.setTimeout(5_000, () => socket.destroy(new Error('No command reply')))
      socket.on('error', reject)
      socket.on('data', data => { reply += data })
      socket.once('end', () => resolve(reply))
      socket.once('connect', () => socket.write(input))
    })
  }
  it('routes each command once and keeps the folder and socket private', async () => {
    const dispatch = vi.fn(async () => true)
    const server = service(dispatch)
    await server.start()
    expect(lstatSync(dirname(server.path)).mode & 0o777).toBe(0o700)
    expect(lstatSync(server.path).isSymbolicLink()).toBe(true)
    expect(readlinkSync(server.path)).toMatch(/^dictation-\d+-[a-f0-9]{8}\.sock$/)
    expect(statSync(server.path).mode & 0o777).toBe(0o600)
    expect(statSync(server.path).isSocket()).toBe(true)
    for (const command of ['start', 'stop', 'toggle', 'cancel']) expect(await send(`${command}\n`)).toBe('ok\n')
    expect(dispatch.mock.calls).toEqual([['start'], ['stop'], ['toggle'], ['cancel']])
    server.dispose()
    server.dispose()
    expect(existsSync(server.path)).toBe(false)
    expect(readdirSync(dirname(server.path))).toEqual([])
  })
  it('rejects text, multiple commands, and oversized messages without dispatch', async () => {
    const dispatch = vi.fn(async () => true)
    await service(dispatch).start()
    for (const input of ['retry\n', 'start\nstop\n', `${'x'.repeat(DICTATION_REQUEST_MAX_BYTES)}\n`, 'start \n', 'start --at 123\nstop\n']) expect(await send(input)).toBe('invalid\n')
    expect(dispatch).not.toHaveBeenCalled()
  })
  it.each(['stop', 'cancel'])('does not start recording when an unpaired stamped %s arrives before an older start', async end => {
    const dispatch = vi.fn(async () => true)
    const at = BigInt(Date.now()) * 1_000_000n
    await service(dispatch).start()
    expect(await send(`${end} --at ${at}\n`)).toBe('ok\n')
    expect(await send(`start --at ${at - 15_000_000n}\n`)).toBe('ok\n')
    expect(await send(`start --at ${at}\n`)).toBe('ok\n')
    // The renderer never receives a microphone start, including an equal-stamp replay.
    expect(dispatch.mock.calls).toEqual([[end]])
    expect(await send('start\n')).toBe('ok\n')
    expect(dispatch.mock.calls).toEqual([[end], ['start']])
  })
  it('records a normal stamped hold and permits the next hold after its release', async () => {
    let recording = false
    const dispatch = vi.fn(async (command: CompositorDictationCommand) => {
      recording = command === 'start'
      return true
    })
    const at = BigInt(Date.now()) * 1_000_000n - 100_000_000n
    await service(dispatch).start()
    expect(await send(`start --at ${at}\n`)).toBe('ok\n')
    expect(recording).toBe(true)
    expect(await send(`stop --at ${at + 15_000_000n}\n`)).toBe('ok\n')
    expect(recording).toBe(false)
    expect(await send(`start --at ${at + 20_000_000n}\n`)).toBe('ok\n')
    expect(recording).toBe(true)
    expect(await send(`stop --at ${at + 30_000_000n}\n`)).toBe('ok\n')
    expect(recording).toBe(false)
    expect(dispatch.mock.calls).toEqual([['start'], ['stop'], ['start'], ['stop']])
  })
  it('keeps the latest end stamp when an older release arrives later', async () => {
    const dispatch = vi.fn(async () => true)
    const at = BigInt(Date.now()) * 1_000_000n
    await service(dispatch).start()
    await send(`stop --at ${at}\n`)
    await send(`cancel --at ${at - 30_000_000n}\n`)
    await send(`start --at ${at - 15_000_000n}\n`)
    expect(dispatch.mock.calls).toEqual([['stop'], ['cancel']])
  })
  it('rejects stale and future stamps before they affect delivery or the release stamp', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_791_486_000_000)
    const at = BigInt(Date.now()) * 1_000_000n
    const dispatch = vi.fn(async () => true)
    await service(dispatch).start()
    for (const stamp of [at - 5_000_000_001n, at + 250_000_001n]) {
      expect(await send(`stop --at ${stamp}\n`)).toBe('invalid\n')
    }
    expect(dispatch).not.toHaveBeenCalled()
    for (const stamp of [at - 5_000_000_000n, at, at + 250_000_000n]) {
      expect(await send(`start --at ${stamp}\n`)).toBe('ok\n')
    }
    expect(dispatch).toHaveBeenCalledTimes(3)
  })
  it('ignores an older start while delivery of the release is pending', async () => {
    const held = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    const dispatch = vi.fn(async () => { entered.resolve(); await held.promise; return true })
    await service(dispatch).start()
    const at = BigInt(Date.now()) * 1_000_000n
    const stopping = send(`stop --at ${at}\n`)
    await entered.promise
    const starting = send(`start --at ${at - 15_000_000n}\n`)
    held.resolve()
    expect(await Promise.all([stopping, starting])).toEqual(['ok\n', 'ok\n'])
    expect(dispatch.mock.calls).toEqual([['stop']])
  })
  it.each([false, 'throw'])('reports failed delivery (%s) without crashing', async result => {
    await service(vi.fn(async () => { if (result === 'throw') throw new Error('private failure'); return false })).start()
    expect(await send('start\n')).toBe('unavailable\n')
  })
  it('leaves an active listener intact when another profile starts', async () => {
    const first = service()
    await first.start()
    await expect(service().start()).rejects.toThrow('already listening')
    expect(await send('start\n')).toBe('ok\n')
  })
  it('leaves another process\'s replacement socket intact on quit', async () => {
    const first = service()
    await first.start()
    const privatePath = join(dirname(first.path), readlinkSync(first.path))
    unlinkSync(first.path)
    const replacement = spawn(process.execPath, ['-e', 'require("node:net").createServer(s => s.once("data", () => s.end("replacement\\n"))).listen(process.argv[1], () => console.log("ready"))', first.path])
    const exited = new Promise(resolve => replacement.once('exit', resolve))
    try {
      await new Promise<void>((resolve, reject) => {
        replacement.once('error', reject)
        replacement.stdout.once('data', () => resolve())
        replacement.once('exit', () => reject(new Error('Replacement listener exited before binding')))
      })
      const inode = lstatSync(first.path).ino
      first.dispose()
      expect(lstatSync(first.path).ino).toBe(inode)
      expect(await send('start\n')).toBe('replacement\n')
      expect(existsSync(privatePath)).toBe(false)
    } finally {
      if (replacement.exitCode === null && replacement.signalCode === null) process.kill(replacement.pid!, 'SIGTERM')
      await exited
    }
  })
  it('publishes only one endpoint when profiles start concurrently', async () => {
    const results = await Promise.allSettled([service().start(), service().start()])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(await send('start\n')).toBe('ok\n')
    expect(readdirSync(join(runtime, 'sotto'))).toHaveLength(2)
  })
  it('refuses a foreign-owned runtime before creating the dictation folder', async () => {
    // Treat the on-disk owner as another UID without requiring chown or root.
    vi.spyOn(process, 'getuid').mockReturnValue(process.getuid!() + 1)
    expect(() => validateDictationRuntime(runtime)).toThrow('only you can access')
    await expect(service().start()).rejects.toThrow('only you can access')
    expect(existsSync(join(runtime, 'sotto'))).toBe(false)
  })
  it.each([0o755, 0o770, 0o1700])('refuses runtime permissions %s without changing them', async mode => {
    chmodSync(runtime, mode)
    expect(() => validateDictationRuntime(runtime)).toThrow('only you can access')
    await expect(service().start()).rejects.toThrow('only you can access')
    expect(lstatSync(runtime).mode & 0o7777).toBe(mode)
    expect(existsSync(join(runtime, 'sotto'))).toBe(false)
  })
  it('refuses a runtime link and a linked ancestor, including before a dot-dot', async () => {
    const target = join(runtime, 'real')
    const link = join(runtime, 'link')
    mkdirSync(target, { mode: 0o700 })
    mkdirSync(join(target, 'child'), { mode: 0o700 })
    symlinkSync(target, link)
    for (const path of [link, `${link}/`, join(link, 'child'), `${link}/../real`]) {
      expect(() => validateDictationRuntime(path)).toThrow('real desktop runtime folder')
      const server = new DictationSocket(path, vi.fn(async () => true))
      services.push(server)
      await expect(server.start()).rejects.toThrow('real desktop runtime folder')
    }
    expect(existsSync(join(target, 'sotto'))).toBe(false)
    expect(existsSync(join(target, 'child/sotto'))).toBe(false)
  })
  it.each(['runtime', 'sotto'])('leaves the endpoint alone when the %s directory is replaced during recovery', async replaced => {
    const folder = join(runtime, 'sotto')
    mkdirSync(folder, { mode: 0o700 })
    const path = dictationSocketPath(runtime)
    const abandoned = spawnSync(process.execPath, ['-e', 'require("node:net").createServer().listen(process.argv[1], () => process.exit(0))', path])
    expect(abandoned.status).toBe(0)
    const inode = lstatSync(path).ino
    const starting = service().start()
    // start has reached the asynchronous connection probe. Move the same socket inode
    // into a new directory so checking the endpoint inode alone cannot detect this swap.
    const directory = replaced === 'runtime' ? runtime : folder
    const moved = `${directory}-old`
    renameSync(directory, moved)
    mkdirSync(directory, { mode: 0o700 })
    if (replaced === 'runtime') mkdirSync(folder, { mode: 0o700 })
    renameSync(replaced === 'runtime' ? join(moved, 'sotto/dictation.sock') : join(moved, 'dictation.sock'), path)
    try {
      await expect(starting).rejects.toThrow('runtime folder changed')
      expect(lstatSync(path).ino).toBe(inode)
    } finally { rmSync(moved, { recursive: true, force: true }) }
  })
  it('recovers a socket left by a process that exited without cleanup', async () => {
    mkdirSync(join(runtime, 'sotto'), { mode: 0o700 })
    const abandoned = spawnSync(process.execPath, ['-e', 'require("node:net").createServer().listen(process.argv[1], () => process.exit(0))', dictationSocketPath(runtime)])
    expect(abandoned.status).toBe(0)
    await service().start()
    expect(await send('toggle\n')).toBe('ok\n')
  })
  it('recovers a dead instance\'s public link and private socket', async () => {
    const folder = join(runtime, 'sotto')
    mkdirSync(folder, { mode: 0o700 })
    const oldSocket = join(folder, 'dictation-123-1a2b3c4d.sock')
    const abandoned = spawnSync(process.execPath, ['-e', 'require("node:net").createServer().listen(process.argv[1], () => process.exit(0))', oldSocket])
    expect(abandoned.status).toBe(0)
    symlinkSync('dictation-123-1a2b3c4d.sock', dictationSocketPath(runtime))
    await service().start()
    expect(existsSync(oldSocket)).toBe(false)
    expect(await send('toggle\n')).toBe('ok\n')
    expect(readdirSync(folder)).toHaveLength(2)
  })
  it('removes an unpublished private socket left by a crash', async () => {
    const folder = join(runtime, 'sotto')
    mkdirSync(folder, { mode: 0o700 })
    const oldSocket = join(folder, 'dictation-123-1a2b3c4d.sock')
    const abandoned = spawnSync(process.execPath, ['-e', 'require("node:net").createServer().listen(process.argv[1], () => process.exit(0))', oldSocket])
    expect(abandoned.status).toBe(0)
    expect(lstatSync(oldSocket).isSocket()).toBe(true)
    expect(existsSync(dictationSocketPath(runtime))).toBe(false)
    await service().start()
    expect(existsSync(oldSocket)).toBe(false)
    expect(await send('start\n')).toBe('ok\n')
    expect(readdirSync(folder)).toHaveLength(2)
  })
  it('preserves live unpublished listeners, files, links and unrelated socket names', async () => {
    const folder = join(runtime, 'sotto')
    mkdirSync(folder, { mode: 0o700 })
    const livePath = join(folder, 'dictation-123-1a2b3c4d.sock')
    const file = join(folder, 'dictation-123-2a2b3c4d.sock')
    const link = join(folder, 'dictation-123-3a2b3c4d.sock')
    const unrelated = join(folder, 'other.sock')
    writeFileSync(file, 'keep')
    symlinkSync('dictation-123-2a2b3c4d.sock', link)
    const abandoned = spawnSync(process.execPath, ['-e', 'require("node:net").createServer().listen(process.argv[1], () => process.exit(0))', unrelated])
    expect(abandoned.status).toBe(0)
    const listener = createServer(socket => {
      socket.on('error', () => socket.destroy())
      socket.end('still live\n')
    })
    await new Promise<void>(resolve => listener.listen(livePath, resolve))
    try {
      await service().start()
      expect(lstatSync(file).isFile()).toBe(true)
      expect(readlinkSync(link)).toBe('dictation-123-2a2b3c4d.sock')
      expect(lstatSync(unrelated).isSocket()).toBe(true)
      const reply = await new Promise<string>((resolve, reject) => {
        const socket = createConnection(livePath)
        let reply = ''
        socket.on('error', reject)
        socket.on('data', data => { reply += data })
        socket.once('end', () => resolve(reply))
      })
      expect(reply).toBe('still live\n')
    } finally { await new Promise<void>(resolve => listener.close(() => resolve())) }
  })
  it('recovers a dead instance\'s link when its private socket is already gone', async () => {
    mkdirSync(join(runtime, 'sotto'), { mode: 0o700 })
    symlinkSync('dictation-123-1a2b3c4d.sock', dictationSocketPath(runtime))
    await service().start()
    expect(await send('toggle\n')).toBe('ok\n')
  })
  it.each(['../dictation-123-1a2b3c4d.sock', '/tmp/dictation-123-1a2b3c4d.sock', 'other.sock'])('leaves an unrelated endpoint link to %s intact', async target => {
    mkdirSync(join(runtime, 'sotto'), { mode: 0o700 })
    symlinkSync(target, dictationSocketPath(runtime))
    await expect(service().start()).rejects.toThrow('socket is unavailable')
    expect(readlinkSync(dictationSocketPath(runtime))).toBe(target)
  })
  it('refuses a symlink folder or a non-socket endpoint without removing it', async () => {
    const target = join(runtime, 'target')
    mkdirSync(target)
    symlinkSync(target, join(runtime, 'sotto'))
    await expect(service().start()).rejects.toThrow()
    unlinkSync(join(runtime, 'sotto'))
    mkdirSync(join(runtime, 'sotto'))
    writeFileSync(dictationSocketPath(runtime), 'keep')
    await expect(service().start()).rejects.toThrow()
    expect(lstatSync(dictationSocketPath(runtime)).isFile()).toBe(true)
  })
})
