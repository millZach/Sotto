// @vitest-environment node
import { EventEmitter } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { connectEngineClient } from '../../../src/main/engine/transport'
import { THREAD_WORDS_HOST_WAIT_MS } from '../../../src/shared/threadWords'

let fakeServerClose: (() => void) | undefined

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
  return {
    ...actual,
    spawn: (_command: string, args: readonly string[], options?: { env?: NodeJS.ProcessEnv }) => {
      const child = new EventEmitter() as EventEmitter & {
        exitCode: number | null
        signalCode: NodeJS.Signals | null
        kill: (signal?: NodeJS.Signals) => boolean
      }
      child.exitCode = null
      child.signalCode = null
      child.kill = () => {
        if (child.exitCode === null) {
          child.exitCode = 0
          child.emit('exit', 0, null)
        }
        return true
      }

      const endpointIdx = args.indexOf('--endpoint')
      const endpoint = endpointIdx >= 0 ? args[endpointIdx + 1] : undefined
      const token = options?.env?.SOTTO_ENGINE_TOKEN ?? ''
      if (endpoint && token) {
        void connectEngineClient(endpoint, token).then(conn => {
          conn.onRequest(async method => {
            if (method === 'engine.ping') {
              return { ok: true, runtime: 'rust', version: '0.1.43', pid: 4242 }
            }
            if (method === 'engine.shutdown') {
              setImmediate(() => {
                conn.close()
                child.kill()
              })
              return { ok: true }
            }
            if (method === 'ops.threadWords') {
              // Deliberately stall forever to verify the 2_500 ms timeout returns undefined before the router wait.
              return await new Promise<never>(() => undefined)
            }
            throw new Error(`Unexpected method ${method}`)
          })
          fakeServerClose = () => { conn.close() }
        }).catch(() => undefined)
      }
      return child
    },
  }
})

import { startRustLocalEngine } from '../../../src/main/engine/rustLocalEngineClient'

describe('Rust local desktop engine searchThreadWords timeout (PR #2814 / #2834)', () => {
  afterEach(() => {
    vi.useRealTimers()
    fakeServerClose?.()
    fakeServerClose = undefined
  })

  it('times out a stalled ops.threadWords call at 2_500 ms (below THREAD_WORDS_HOST_WAIT_MS) and returns undefined for TS fallback', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sotto-rust-client-timeout-'))
    const fakeBin = join(dir, 'sotto-engine-stub')
    await writeFile(fakeBin, 'stub', 'utf8')
    const client = await startRustLocalEngine({
      userDataPath: dir,
      isPackaged: false,
      binaryPath: fakeBin,
    })

    try {
      expect(client).toBeDefined()
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

      let settled = false
      let result: unknown = 'pending'
      const promise = client!.searchThreadWords('stalled-query').then(value => {
        settled = true
        result = value
        return value
      })

      await vi.advanceTimersByTimeAsync(2_499)
      expect(settled).toBe(false)

      await vi.advanceTimersByTimeAsync(1)
      expect(await promise).toBeUndefined()
      expect(settled).toBe(true)
      expect(result).toBeUndefined()
      expect(2_500).toBeLessThan(THREAD_WORDS_HOST_WAIT_MS)
    } finally {
      vi.useRealTimers()
      await client?.close().catch(() => undefined)
      await rm(dir, { recursive: true, force: true }).catch(() => undefined)
    }
  })
})
