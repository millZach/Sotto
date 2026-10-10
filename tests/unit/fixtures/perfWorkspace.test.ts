// @vitest-environment node
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { perfDataDirectory } from '../../fixtures/perfWorkspace'

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, access: vi.fn(actual.access) }
})

let directory: string
let source: string

beforeEach(async () => {
  vi.mocked(fs.access).mockClear()
  directory = await fs.mkdtemp(join(tmpdir(), 'sotto-perf-opt-in-'))
  source = join(directory, 'sotto')
  await fs.mkdir(source)
  await fs.writeFile(join(source, 'workspace.json'), JSON.stringify({ snapshot: { threads: [] } }))
})

afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(directory, { recursive: true, force: true })
})

describe('data-backed benchmark opt-in', () => {
  it.each([
    {},
    { SOTTO_PERF_BENCH: '1' },
    { SOTTO_PERF_BENCH: '1', SOTTO_PERF_DATA: '' },
    { SOTTO_PERF_BENCH: '1', SOTTO_PERF_DATA: '   ' },
  ])('does not probe a profile without an explicit directory: %j', async settings => {
    const probe = vi.mocked(fs.access)
    expect(await perfDataDirectory({ APPDATA: directory, ...settings })).toBeNull()
    expect(probe).not.toHaveBeenCalled()
  })

  it.each([undefined, '0', 'true'])('does not probe a selected directory without the benchmark switch: %s', async enabled => {
    const probe = vi.mocked(fs.access)
    expect(await perfDataDirectory({ APPDATA: directory, SOTTO_PERF_DATA: source, SOTTO_PERF_BENCH: enabled })).toBeNull()
    expect(probe).not.toHaveBeenCalled()
  })

  it('accepts only the explicitly selected existing workspace for an opt-in run', async () => {
    const probe = vi.mocked(fs.access)
    expect(await perfDataDirectory({ APPDATA: join(directory, 'unselected'), SOTTO_PERF_DATA: source, SOTTO_PERF_BENCH: '1' })).toBe(source)
    expect(probe).toHaveBeenCalledExactlyOnceWith(join(source, 'workspace.json'))
  })

  it('does not fall back to a profile when the selected workspace is absent', async () => {
    const missing = join(directory, 'missing')
    const probe = vi.mocked(fs.access)
    expect(await perfDataDirectory({ APPDATA: directory, SOTTO_PERF_DATA: missing, SOTTO_PERF_BENCH: '1' })).toBeNull()
    expect(probe).toHaveBeenCalledExactlyOnceWith(join(missing, 'workspace.json'))
  })
})
