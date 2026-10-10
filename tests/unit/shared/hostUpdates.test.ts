// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { hostIsNewer, hostIsOlder } from '../../../src/shared/hostProtocol'
import { HOST_ARCHIVE_PATTERN, hostArchiveName, hostUpdateCommandSchema, threadKeepsHostBusy } from '../../../src/shared/hostUpdates'
import { hostsCommandSchema } from '../../../src/shared/hosts'

describe('comparing a host\'s Sotto version with this computer\'s', () => {
  it('calls a host older by release number, part by part, and never one it cannot read', () => {
    expect(hostIsOlder('0.1.22', '0.1.24')).toBe(true)
    expect(hostIsOlder('0.9.0', '0.10.0')).toBe(true)
    expect(hostIsOlder('0.1.24', '1.0.0')).toBe(true)
    expect(hostIsOlder('0.1.24', '0.1.24')).toBe(false)
    expect(hostIsOlder('0.1.25', '0.1.24')).toBe(false)
    expect(hostIsOlder('0.10.0', '0.9.0')).toBe(false)
    expect(hostIsOlder(undefined, '0.1.24')).toBe(false)
    expect(hostIsOlder('unknown', '0.1.24')).toBe(false)
    // Older and newer are never both true, and a release number with a suffix reads by its numbers.
    for (const [host, client] of [['0.1.22', '0.1.24'], ['0.1.24', '0.1.22'], ['0.1.24', '0.1.24']] as const) expect(hostIsOlder(host, client) && hostIsNewer(host, client)).toBe(false)
    expect(hostIsOlder('0.1.23-beta.1', '0.1.24')).toBe(true)
  })
})

describe('a thread that keeps its host busy', () => {
  const idle = { status: 'idle' as const, archivedAt: null }
  it('is one whose turn runs, whose context compacts, or whose turn left background work, unless it is archived', () => {
    expect(threadKeepsHostBusy(idle)).toBe(false)
    expect(threadKeepsHostBusy({ ...idle, status: 'running' })).toBe(true)
    expect(threadKeepsHostBusy({ ...idle, compaction: { commandId: 'c', status: 'running' } })).toBe(true)
    expect(threadKeepsHostBusy({ ...idle, compaction: { commandId: 'c', status: 'completed' } })).toBe(false)
    expect(threadKeepsHostBusy({ ...idle, backgroundWork: [{ id: 'w', type: 'command', title: 'npm test', startedAt: '2026-09-29T08:00:00.000Z' }] as never })).toBe(true)
    expect(threadKeepsHostBusy({ ...idle, status: 'running', archivedAt: '2026-09-29T08:00:00.000Z' })).toBe(false)
  })
})

describe('the archive and the command', () => {
  it('names archives the way the release procedure publishes them, and reads back only such names', () => {
    expect(hostArchiveName('0.1.24')).toBe('Sotto-host-0.1.24-linux-x64.tar.gz')
    expect(hostArchiveName('0.1.24', 'darwin', 'arm64')).toBe('Sotto-host-0.1.24-darwin-arm64.tar.gz')
    expect(HOST_ARCHIVE_PATTERN.test('Sotto-host-0.1.24-linux-x64.tar.gz')).toBe(true)
    for (const name of ['../Sotto-host-0.1.24-linux-x64.tar.gz', 'Sotto-host-0.1.24-linux-x64.tar.gz/x', 'Sotto-host-latest-linux-x64.tar.gz']) expect(HOST_ARCHIVE_PATTERN.test(name)).toBe(false)
  })
  it('takes one of the panel\'s presses for one saved host, and nothing else', () => {
    const id = '11111111-1111-4111-8111-111111111111'
    for (const action of ['update', 'when-idle', 'stop-threads', 'cancel', 'not-now', 'dismiss']) {
      expect(hostsCommandSchema.parse({ type: 'host-update', id, action })).toEqual({ type: 'host-update', id, action })
    }
    expect(hostUpdateCommandSchema.safeParse({ type: 'host-update', id, action: 'install' }).success).toBe(false)
    expect(hostUpdateCommandSchema.safeParse({ type: 'host-update', id, action: 'update', version: '9.9.9' }).success).toBe(false)
  })
})
