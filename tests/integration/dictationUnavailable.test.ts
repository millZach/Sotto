// @vitest-environment node
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { build } from 'vite'

describe.skipIf(process.platform !== 'linux')('unreachable dictation command notifications across processes', () => {
  let root: string
  let bin: string
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'sotto-unreachable-'))
    bin = join(root, 'bin')
    mkdirSync(bin)
    // No live notification daemon is contacted. Record the exact argv instead.
    writeFileSync(join(bin, 'notify-send'), `#!${process.execPath}\nrequire('node:fs').appendFileSync(process.env.NOTICE_LOG, JSON.stringify(process.argv.slice(2)) + '\\n')\n`, { mode: 0o700 })
    await build({ configFile: false, logLevel: 'silent', build: {
      ssr: resolve('src/main/hotkeys/dictationClient.ts'), target: 'node24', outDir: root, emptyOutDir: false,
      rollupOptions: { external: id => isBuiltin(id), output: { format: 'cjs', entryFileNames: 'client.cjs' } },
    } })
  })
  afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }) })
  const run = (runtime: string, command: string) => new Promise<number | null>((resolve, reject) => {
    const child = spawn(process.execPath, [join(root, 'client.cjs'), 'dictation', command], {
      env: { ...process.env, PATH: bin, XDG_RUNTIME_DIR: runtime, NOTICE_LOG: join(runtime, 'notices') }, stdio: 'ignore',
    })
    child.once('error', reject)
    child.once('exit', resolve)
  })
  function notifications(runtime: string): string[][] {
    try { return readFileSync(join(runtime, 'notices'), 'utf8').trim().split('\n').map(line => JSON.parse(line)) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
  }
  it('shows one notice for an F9 tap and simultaneous repeated start/toggle clients, then allows another after the cooldown', async () => {
    const runtime = mkdtempSync(join(root, 'runtime-'))
    expect(await run(runtime, 'start')).toBe(1)
    expect(await run(runtime, 'stop')).toBe(1)
    expect(await run(runtime, 'cancel')).toBe(1)
    expect(await Promise.all(Array.from({ length: 8 }, (_, i) => run(runtime, i % 2 ? 'start' : 'toggle')))).toEqual(Array(8).fill(1))
    expect(notifications(runtime)).toHaveLength(1)
    expect(notifications(runtime)[0]).toContain('Open Sotto, then press F9 again.')
    const old = new Date(Date.now() - 5_001)
    utimesSync(join(runtime, 'sotto-dictation-notice'), old, old)
    expect(await Promise.all(Array.from({ length: 8 }, () => run(runtime, 'toggle')))).toEqual(Array(8).fill(1))
    expect(notifications(runtime)).toHaveLength(2)
    expect(notifications(runtime)[1]).toContain('Open Sotto, then try again.')
  })
  it('notifies for a stale socket whose listener is gone', async () => {
    const runtime = mkdtempSync(join(root, 'runtime-'))
    mkdirSync(join(runtime, 'sotto'), { mode: 0o700 })
    const socketPath = join(runtime, 'sotto/dictation.sock')
    // Exit without closing: the socket inode remains, but connections are refused.
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', 'require("node:net").createServer().listen(process.argv[1], () => process.exit(0))', socketPath], { stdio: 'ignore' })
      child.once('error', reject)
      child.once('exit', code => code === 0 ? resolve() : reject(new Error('Socket fixture failed')))
    })
    expect(await run(runtime, 'start')).toBe(1)
    expect(notifications(runtime)).toHaveLength(1)
  })
  it('does not notify when the running app accepts or rejects a command', async () => {
    const runtime = mkdtempSync(join(root, 'runtime-'))
    mkdirSync(join(runtime, 'sotto'), { mode: 0o700 })
    let reply = 'ok\n'
    const server = createServer(socket => socket.once('data', () => socket.end(reply)))
    await new Promise<void>(resolve => server.listen(join(runtime, 'sotto/dictation.sock'), resolve))
    try {
      expect(await run(runtime, 'toggle')).toBe(0)
      reply = 'unavailable\n'
      expect(await run(runtime, 'toggle')).toBe(1)
      expect(notifications(runtime)).toEqual([])
    } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
  })
})
