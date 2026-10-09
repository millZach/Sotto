// @vitest-environment node
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import process from 'node:process'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@playwright/test', () => ({ _electron: { launch: vi.fn() } }))
// Electron is scripted here. Use the Windows package fixture on Linux without adding a Linux release profile.
vi.mock('../../../scripts/release-platform-profile.mjs', async importOriginal => {
  const original = await importOriginal()
  return { ...original, releasePlatformProfile: (platform = process.platform, arch) =>
    original.releasePlatformProfile(platform === 'linux' ? 'win32' : platform, arch) }
})
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
    evaluate: vi.fn().mockResolvedValueOnce(terminal).mockImplementationOnce(async () => {
      if (exitCode !== 0) throw new Error('packaged process failed')
      return JSON.parse(output)
    }),
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
    expect(options.env.SOTTO_MEMORY_PROBE).toBeUndefined()
    const root = options.args[0].slice('--user-data-dir='.length)
    expect(isAbsolute(root)).toBe(true)
    expect(existsSync(root)).toBe(false)
    expect(options.args.some(arg => arg.includes('probe-memory-store.mjs'))).toBe(false)
  })

  it('invokes the probe exported by the shipped main entry rather than checkout code', async () => {
    const application = launchResult(JSON.stringify(evidence))
    await verifyPackagedMemoryStore('release/win-unpacked')
    const [evaluate, root] = application.evaluate.mock.calls[1]
    const probe = vi.fn(() => evidence)
    const requireApp = vi.fn(path => path === './package.json' ? { main: 'out/main/index.js' } : { probeMemoryStore: probe })
    const builtin = process.getBuiltinModule.bind(process)
    vi.spyOn(process, 'getBuiltinModule').mockImplementation(name => name === 'node:module'
      ? { createRequire: vi.fn(() => requireApp) } : builtin(name))
    const { join } = builtin('node:path')
    const shipped = join(root, 'shipped-app')
    expect(evaluate({ app: { getAppPath: () => shipped } }, root)).toEqual(evidence)
    expect(requireApp.mock.calls).toEqual([['./package.json'], [join(shipped, 'out/main/index.js')]])
    expect(probe).toHaveBeenCalledWith(join(root, 'memory.sqlite'))
  })

  it.each([
    '', 'not JSON', JSON.stringify({ ...evidence, migrationVersion: 0 }),
    JSON.stringify({ ...evidence, matchedId: null }), JSON.stringify({ ...evidence, fts5: false }),
    JSON.stringify({ ...evidence, sqliteVersion: null }),
  ])('rejects missing or invalid packaged-store evidence: %s', async output => {
    launchResult(output)
    await expect(verifyPackagedMemoryStore('release/win-unpacked')).rejects.toThrow(/memory store probe/)
  })

  it('rejects a failed packaged process even if valid evidence was prepared', async () => {
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
