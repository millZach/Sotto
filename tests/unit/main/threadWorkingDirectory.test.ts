// @vitest-environment node

import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { existingWorkingDirectory } from '../../../src/main/agents/threadWorktrees'
import { resolveThreadWorkingDirectory } from '../../../src/shared/threadWorkingDirectory'

import '../../fixtures/threadWorktreeFixture'

describe("independent working-copy allocation", () => {
  it('resolves authoritative cwd before project fallback and blocks unresolved setup', () => {
    expect(resolveThreadWorkingDirectory({ workingDirectory: '/actual' }, { path: '/project' })).toBe('/actual')
    expect(resolveThreadWorkingDirectory({}, { path: '/legacy' })).toBe('/legacy')
    expect(() => resolveThreadWorkingDirectory({ worktree: { mode: 'independent', status: 'error', error: 'setup failed' } }, { path: '/project' })).toThrow('setup failed')
  })
})

describe('a working folder that is gone', () => {
  it('says so in plain words, not as the file system error code', async () => {
    const missing = join(tmpdir(), `sotto-missing-${Date.now()}`)
    await expect(existingWorkingDirectory(missing)).rejects.toThrow(`The folder ${missing} is not there any more. Move it back, or add the project again from where it is now.`)
  })
})
