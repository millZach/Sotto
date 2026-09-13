// @vitest-environment node
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@playwright/test', () => ({ _electron: { launch: vi.fn() } }))
import { _electron as electron } from '@playwright/test'
import { latestMigrationVersion } from '../../../src/main/memory/migrations.mjs'
import { verifyPackagedMemoryStore } from '../../../scripts/verify-packaged-resources.mjs'

afterEach(() => vi.restoreAllMocks())
const evidence = { sqliteVersion: '3.51.2', migrationVersion: latestMigrationVersion, matchedId: 'memory-probe', fts5: true }
const terminal = { modules: '148', napi: '10', exitCode: 0, output: 'SOTTO_PTY_PACKAGE_OK' }
function launchResult(output, exitCode = 0) {
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  const application = {
    process: () => child,
    evaluate: vi.fn(async () => {
      child.stdout.write(output)
      child.emit('close', exitCode, null)
    }).mockResolvedValueOnce(terminal),
    close: vi.fn(async () => undefined),
  }
  electron.launch.mockResolvedValue(application)
  return application
}

describe('packaged memory probe', () => {
  it('launches the packaged application with an isolated profile, collects evidence and cleans up', async () => {
    launchResult(`${JSON.stringify(evidence)}\n`)
    await expect(verifyPackagedMemoryStore('release/win-unpacked')).resolves.toEqual({ ...evidence, terminal })
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

  it('fails verification and closes the app when the packaged native terminal cannot execute', async () => {
    const application = launchResult(JSON.stringify(evidence))
    application.evaluate.mockReset().mockRejectedValueOnce(new Error('packaged native helper failed'))
    await expect(verifyPackagedMemoryStore('release/win-unpacked')).rejects.toThrow(/native helper failed/)
    expect(application.close).toHaveBeenCalledOnce()
  })

  it('expects the latest migration when the schema gains another version', async () => {
    vi.resetModules()
    vi.doMock('../../../src/main/memory/migrations.mjs', async importOriginal => ({
      ...await importOriginal(), latestMigrationVersion: latestMigrationVersion + 1,
    }))
    try {
      const { verifyPackagedMemoryStore } = await import('../../../scripts/verify-packaged-resources.mjs')
      const next = { ...evidence, migrationVersion: latestMigrationVersion + 1 }
      launchResult(JSON.stringify(next))
      await expect(verifyPackagedMemoryStore('release/win-unpacked')).resolves.toEqual({ ...next, terminal })
      launchResult(JSON.stringify(evidence))
      await expect(verifyPackagedMemoryStore('release/win-unpacked')).rejects.toThrow(/invalid store evidence/)
    } finally {
      vi.doUnmock('../../../src/main/memory/migrations.mjs')
      vi.resetModules()
    }
  })
})
