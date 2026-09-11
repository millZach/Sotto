// @vitest-environment node
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@playwright/test', () => ({ _electron: { launch: vi.fn() } }))
import { _electron as electron } from '@playwright/test'
import { verifyPackagedMemoryStore } from '../../../scripts/verify-packaged-resources.mjs'

afterEach(() => vi.restoreAllMocks())
const evidence = { sqliteVersion: '3.51.2', migrationVersion: 1, matchedId: 'memory-probe', fts5: true }
function launchResult(output, exitCode = 0) {
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  const application = {
    process: () => child,
    evaluate: vi.fn(async () => {
      child.stdout.write(output)
      child.emit('close', exitCode, null)
    }),
    close: vi.fn(async () => undefined),
  }
  electron.launch.mockResolvedValue(application)
  return application
}

describe('packaged memory probe', () => {
  it('launches the packaged application with an isolated profile, collects evidence and cleans up', async () => {
    launchResult(`${JSON.stringify(evidence)}\n`)
    await expect(verifyPackagedMemoryStore('release/win-unpacked')).resolves.toEqual(evidence)
    const options = electron.launch.mock.calls.at(-1)[0]
    expect(options.env.ELECTRON_RUN_AS_NODE).toBeUndefined()
    expect(options.env.SOTTO_MEMORY_PROBE).toBe('1')
    expect(isAbsolute(options.env.SOTTO_MEMORY_PROBE_USER_DATA)).toBe(true)
    expect(existsSync(options.env.SOTTO_MEMORY_PROBE_USER_DATA)).toBe(false)
    expect(options.args.some(arg => arg.includes('probe-memory-store.mjs'))).toBe(false)
  })

  it.each([
    '', 'not JSON', JSON.stringify({ ...evidence, migrationVersion: 0 }),
    JSON.stringify({ ...evidence, matchedId: null }), JSON.stringify({ ...evidence, fts5: false }),
    JSON.stringify({ ...evidence, sqliteVersion: null }),
  ])('rejects missing or invalid packaged-store evidence: %s', async output => {
    launchResult(output)
    await expect(verifyPackagedMemoryStore('release/win-unpacked')).rejects.toThrow(/memory store probe/)
  })

  it('rejects a failed packaged process even if it printed valid evidence', async () => {
    launchResult(JSON.stringify(evidence), 1)
    await expect(verifyPackagedMemoryStore('release/win-unpacked')).rejects.toThrow(/memory store probe/)
  })

  it('rejects missing packaged resources that prevent launch', async () => {
    electron.launch.mockRejectedValue(new Error('missing main module'))
    await expect(verifyPackagedMemoryStore('release/win-unpacked')).rejects.toThrow(/missing main module/)
  })
})
