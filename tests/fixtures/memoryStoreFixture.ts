// @vitest-environment node

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, vi } from 'vitest'

import { MemoryStore } from '../../src/main/memory/store'

let root: string | undefined
export let path: string
export let store: MemoryStore

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'sotto-memory-store-test-'))
  path = join(root, 'user-data', 'memory.sqlite')
  store = new MemoryStore(path)
})

afterEach(async () => {
  vi.useRealTimers()
  store?.close()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})
