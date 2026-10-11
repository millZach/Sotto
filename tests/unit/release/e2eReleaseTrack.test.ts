// @vitest-environment node
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import { onReleaseTrack, OWL_E2E_VERSION } from '../../e2e/support/releaseTrack'

it.each(['stable', 'owl'] as const)('isolates %s from inherited overrides and restores them after failure', async track => {
  vi.stubEnv('SOTTO_E2E_MAIN_ENTRY', 'synthetic-inherited-entry')
  vi.stubEnv('SOTTO_WATCHER_ENABLED', '1')
  let entry: string | undefined
  try {
    await expect(onReleaseTrack(track, async () => {
      expect(process.env.SOTTO_WATCHER_ENABLED).toBeUndefined()
      entry = process.env.SOTTO_E2E_MAIN_ENTRY
      if (track === 'stable') expect(entry).toBeUndefined()
      else {
        expect(entry).not.toBe('synthetic-inherited-entry')
        expect(JSON.parse(await readFile(join(entry!, 'package.json'), 'utf8'))).toMatchObject({
          version: OWL_E2E_VERSION, main: resolve('out/main/index.js'),
        })
      }
      throw new Error('Synthetic test failure')
    })).rejects.toThrow('Synthetic test failure')
    expect(process.env.SOTTO_E2E_MAIN_ENTRY).toBe('synthetic-inherited-entry')
    expect(process.env.SOTTO_WATCHER_ENABLED).toBe('1')
    if (entry) expect(existsSync(entry)).toBe(false)
  } finally { vi.unstubAllEnvs() }
})

it('restores absent overrides and removes its entry after success', async () => {
  vi.stubEnv('SOTTO_E2E_MAIN_ENTRY', undefined)
  vi.stubEnv('SOTTO_WATCHER_ENABLED', undefined)
  let entry: string | undefined
  try {
    await onReleaseTrack('owl', async () => { entry = process.env.SOTTO_E2E_MAIN_ENTRY; expect(entry).toBeDefined() })
    expect(process.env.SOTTO_E2E_MAIN_ENTRY).toBeUndefined()
    expect(process.env.SOTTO_WATCHER_ENABLED).toBeUndefined()
    expect(existsSync(entry!)).toBe(false)
  } finally { vi.unstubAllEnvs() }
})
