// @vitest-environment node

import { describe, expect, it } from 'vitest'

import { clientVersionOf } from '../../src/main/agents/clientVersions'

import { root } from '../fixtures/providerClientInstallFixture'

describe('reading the installed version of a client that is only connected', () => {
  it('asks Claude Code for its own version instead of waiting for a session to say it', async () => {
    // Claude Code reports claude_code_version in a running session's init frame and nowhere else,
    // so a connected but idle provider had no version to compare or to show (screenshot, 0.1.12).
    const { ClaudeSubscriptionClient } = await import('../../src/main/agents/subscriptionClaude')
    const directory = await root('sotto-claude-version-')
    const client = new ClaudeSubscriptionClient(directory, {
      executable: process.execPath,
      prefixArgs: ['-e', "process.stdout.write('2.1.278 (Claude Code)')", '--'],
    })
    expect(clientVersionOf(await client.version(process.execPath))).toBe('2.1.278')
  })

  it('says nothing about a version it could not read', async () => {
    const { ClaudeSubscriptionClient } = await import('../../src/main/agents/subscriptionClaude')
    const directory = await root('sotto-claude-version-missing-')
    const client = new ClaudeSubscriptionClient(directory, { executable: process.execPath, prefixArgs: ['-e', 'process.exit(1)', '--'] })
    expect(await client.version(process.execPath, 5_000)).toBe('')
  })
})
