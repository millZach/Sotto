import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  isOwnedE2EProfileName,
  requireOwnedE2EProfile,
} from '../../../scripts/e2e-profile-policy.mjs'

describe('E2E temporary profile safety policy', () => {
  it('admits only a direct, TalkType-owned child of the temporary directory', () => {
    const owned = join(tmpdir(), 'talktype-e2e-safe_123')

    expect(isOwnedE2EProfileName('talktype-e2e-safe_123')).toBe(true)
    expect(requireOwnedE2EProfile(owned)).toBe(resolve(owned))
    expect(() => requireOwnedE2EProfile(join(tmpdir(), 'caller-owned-profile')))
      .toThrow('Refusing to remove an unsafe E2E profile path.')
    expect(() => requireOwnedE2EProfile(join(tmpdir(), 'talktype-e2e-parent', 'child')))
      .toThrow('Refusing to remove an unsafe E2E profile path.')
  })

  it('is the single policy imported by both launch and stale-profile cleanup', () => {
    const launch = readFileSync(resolve('tests/e2e/support/talktypeLaunch.ts'), 'utf8')
    const cleanup = readFileSync(resolve('scripts/cleanup-e2e-profiles.mjs'), 'utf8')

    expect(launch).toContain("../../../scripts/e2e-profile-policy.mjs")
    expect(cleanup).toContain("./e2e-profile-policy.mjs")
    expect(launch).not.toContain('/^talktype-e2e-')
    expect(cleanup).not.toContain('/^talktype-e2e-')
  })
})
