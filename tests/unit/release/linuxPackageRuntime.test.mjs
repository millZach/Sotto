// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'vitest'
import { createLinuxPackageRuntime } from '../../../scripts/linux-package-runtime.mjs'

describe.skipIf(process.platform !== 'linux')('Linux package runtime', () => {
  it('binds the full private socket name at the release worktree path length', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'sotto-runtime-'))
    // Reproduce the 62-byte cache path of the release-command worktree using a normal temp fixture.
    const cache = join(parent, 'x'.repeat(62 - parent.length - 1))
    mkdirSync(cache)
    const runtime = createLinuxPackageRuntime(cache)
    const second = createLinuxPackageRuntime(cache)
    const folder = join(runtime, 'sotto')
    mkdirSync(folder, { mode: 0o700 })
    const socket = join(folder, 'dictation-9999999-ffffffff.sock')
    const server = createServer()
    try {
      expect(statSync(runtime).mode & 0o777).toBe(0o700)
      expect(second).not.toBe(runtime)
      await new Promise((done, reject) => { server.once('error', reject); server.listen(socket, done) })
      expect(statSync(socket).isSocket()).toBe(true)
    } finally {
      await new Promise(done => server.close(done))
      rmSync(parent, { recursive: true, force: true })
    }
  })
  it('rejects an overlong cache before creating a runtime folder', () => {
    expect(() => createLinuxPackageRuntime('/long/'.repeat(20))).toThrow('checkout path is too long')
  })
})
