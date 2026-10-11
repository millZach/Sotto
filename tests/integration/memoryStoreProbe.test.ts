// @vitest-environment node
import { execFileSync } from 'node:child_process'

import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { latestMigrationVersion } from '../../src/main/memory/migrations.mjs'

import '../fixtures/memoryStoreFixture'

describe("MemoryStore", () => {

  it('runs the real migration and full-text probe with system Node', () => {
    const output = execFileSync(process.execPath, [resolve('scripts/probe-memory-store.mjs')], {
      encoding: 'utf8', windowsHide: true, timeout: 60_000,
    })
    expect(JSON.parse(output.trim())).toEqual({
      sqliteVersion: expect.stringMatching(/^\d+\.\d+\.\d+$/),
      migrationVersion: latestMigrationVersion, matchedId: 'memory-probe', fts5: true,
    })
  })
})
