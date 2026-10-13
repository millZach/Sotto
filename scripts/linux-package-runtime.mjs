import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

/** Reserve an owned 0700 runtime in the cache, leaving room for Linux's private socket name. */
export function createLinuxPackageRuntime(cache) {
  for (let attempt = 0; attempt < 16; attempt++) {
    const runtime = join(cache, randomBytes(1).toString('hex'))
    // Linux's largest PID has seven digits. AF_UNIX also needs its terminating NUL.
    assert.ok(Buffer.byteLength(join(runtime, 'sotto/dictation-9999999-ffffffff.sock')) < 108,
      'This checkout path is too long for the package dictation probe. Use a shorter checkout path.')
    try { mkdirSync(runtime, { mode: 0o700 }); return runtime }
    catch (error) { if (error.code !== 'EEXIST') throw error }
  }
  throw new Error('Could not reserve a private package runtime. Remove only old runtime folders you own before trying again.')
}
