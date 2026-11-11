// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { agentStateSchema } from '../../../src/shared/agents'
import { PHONE_UNREAD_SHELL_PARTS } from '../../../src/shared/hostProtocol'

/**
 * Every part of a shell is on one of two lists: the parts a phone is sent, here, or the parts a host leaves out of a
 * phone's shell because no phone reads them (`PHONE_UNREAD_SHELL_PARTS`, ADR-0025's November 10, 2026 amendment). A new
 * part of the state fails this until it is put on one, so what a phone is sent is decided rather than inherited: a part
 * went to every phone in every push for two months with no phone reading it (#2392).
 */
const PHONE_SENT_SHELL_PARTS = ['legacyManagement', 'worktreeReclaimPreview', 'threadDeletePreview', 'threadClearPreview', 'threadClearResult', 'checkoutHold',
  'clientScoped', 'connections', 'hostId', 'configuration', 'providerUpgrade', 'clientUpdateRun', 'clientUpdatesDismissedAt', 'installedProviders', 'connection',
  'host', 'activeThreadId', 'activeProjectId', 'draft', 'draftThreadId', 'composing', 'draftAttachments', 'deliveredDrafts', 'deliveries', 'followups',
  'followupReceipts', 'draftRequestId', 'globalLaneBusy', 'notice', 'error', 'busyThreadIds', 'unconfirmedSettings', 'nextTurnSettings', 'credentials',
  'reasoningAccounts', 'historyEnabled', 'stale']

/** Every source file of a native client, as one text. */
function sources(folder: string, extension: string): string {
  return readdirSync(folder, { recursive: true }).map(String).filter(name => name.endsWith(extension)).map(name => readFileSync(join(folder, name), 'utf8')).join('\n')
}

describe('the parts of a shell a phone is sent', () => {
  const parts = Object.keys(agentStateSchema.shape)

  it('puts every part of the state on one list or the other', () => {
    expect([...PHONE_SENT_SHELL_PARTS, ...PHONE_UNREAD_SHELL_PARTS].sort()).toEqual([...parts].sort())
  })

  it.each(PHONE_UNREAD_SHELL_PARTS)('leaves out %s only while it is optional on the wire', part => {
    expect(agentStateSchema.shape[part].safeParse(undefined).success).toBe(true)
  })

  it.each(PHONE_UNREAD_SHELL_PARTS)('leaves out %s only while no iPhone or Android source names it', part => {
    expect(sources('apps/ios/Sources', '.swift') + sources('apps/ios/Sotto', '.swift')).not.toContain(part)
    expect(sources('apps/android/app/src/main', '.kt')).not.toContain(part)
  })
})
