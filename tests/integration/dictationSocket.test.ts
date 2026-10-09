// @vitest-environment node
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DictationSocket } from '../../src/main/hotkeys/dictationSocket'
import { dictationSocketPath } from '../../src/main/hotkeys/dictationCommand'

describe.skipIf(process.platform !== 'linux')('dictation Unix socket', () => {
  let runtime: string
  const services: DictationSocket[] = []
  beforeEach(() => { mkdirSync('.cache', { recursive: true }); runtime = mkdtempSync(join(process.cwd(), '.cache/c-')) })
  afterEach(() => { services.splice(0).forEach(service => service.dispose()); rmSync(runtime, { recursive: true, force: true }) })
  function service(dispatch = vi.fn(async () => true)): DictationSocket {
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
    expect(lstatSync(server.path).mode & 0o777).toBe(0o600)
    expect(lstatSync(server.path).isSocket()).toBe(true)
    for (const command of ['start', 'stop', 'toggle', 'cancel']) expect(await send(`${command}\n`)).toBe('ok\n')
    expect(dispatch.mock.calls).toEqual([['start'], ['stop'], ['toggle'], ['cancel']])
    server.dispose()
    server.dispose()
    expect(existsSync(server.path)).toBe(false)
  })
  it('rejects text, multiple commands, and oversized messages without dispatch', async () => {
    const dispatch = vi.fn(async () => true)
    await service(dispatch).start()
    for (const input of ['retry\n', 'start\nstop\n', `${'x'.repeat(17)}\n`, 'start \n']) expect(await send(input)).toBe('invalid\n')
    expect(dispatch).not.toHaveBeenCalled()
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
  it('recovers a socket left by a process that exited without cleanup', async () => {
    mkdirSync(join(runtime, 'sotto'), { mode: 0o700 })
    const abandoned = spawnSync(process.execPath, ['-e', 'require("node:net").createServer().listen(process.argv[1], () => process.exit(0))', dictationSocketPath(runtime)])
    expect(abandoned.status).toBe(0)
    await service().start()
    expect(await send('toggle\n')).toBe('ok\n')
  })
  it('refuses a symlink folder or a non-socket endpoint without removing it', async () => {
    const target = join(runtime, 'target')
    mkdirSync(target)
    symlinkSync(target, join(runtime, 'sotto'))
    await expect(service().start()).rejects.toThrow()
    rmSync(join(runtime, 'sotto'))
    mkdirSync(join(runtime, 'sotto'))
    writeFileSync(dictationSocketPath(runtime), 'keep')
    await expect(service().start()).rejects.toThrow()
    expect(lstatSync(dictationSocketPath(runtime)).isFile()).toBe(true)
  })
})
