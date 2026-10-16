// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { continuedMessagesShown, continuedPromptWords, continuedWordsOnly, continuePrefix } from '../../../src/main/agents/continueThread'
import { registerContinueIpc, type ContinueCalls } from '../../../src/main/agents/continueThreadIpc'
import { handoverPrefixProof } from '../../../src/main/agents/watcherHandover'
import { createAgentRuntime } from '../../../src/main/agents/runtime'
import { E2EAgentHost, e2eAgentReasoner } from '../../../src/main/e2e/agentEffects'
import type { AgentMessage, AgentThread, HandoverCounts } from '../../../src/shared/agents'
import { CONTINUE_READ, CONTINUE_START } from '../../../src/shared/continueThread'
import { HANDOVER_LEAD } from '../../../src/shared/handover'
import { owlFeaturesForTrack } from '../../../src/shared/owlFeatures'
import { DEFAULT_SETTINGS } from '../../../src/shared/settings'
import { ipcRegistry } from '../../fixtures/ipcHarness'
import { testCredentials } from '../../fixtures/testCredentials'

/**
 * A continued thread's first message as every copy shows it (ADR-0088): the handover split from the user's words by the
 * length and digest the thread's record keeps, and only then. Plus the bridge and the runtime, which stable builds none of.
 */
const counts: HandoverCounts = { total: 4, carried: 3, tooLong: 1, notCarried: 0, images: 0, files: 0, visuals: 0, toolRecords: 2, historyKept: true, answered: false }
const prefix = continuePrefix(`${HANDOVER_LEAD} The history below is context, not a new request.\n\nThe user, 2026-10-16 09:00 UTC:\nFix the WAV preview.`)
const at = '2026-10-16T10:00:00.000Z'
const first: AgentMessage = { id: 'first', role: 'user', text: `${prefix}Carry on with the mid-chunk test.`, createdAt: at }
const reply: AgentMessage = { id: 'reply', role: 'assistant', text: 'On it.', createdAt: at }
function continued(messages: AgentMessage[] = [first, reply], proof = handoverPrefixProof(prefix)): Pick<AgentThread, 'continuedFrom' | 'messages'> {
  return { continuedFrom: { threadId: 'source', provider: 'claude', at, handover: { ...proof, counts } }, messages }
}

describe('a continued thread’s first message, as shown', () => {
  it('is the user’s words, with the handover beside them as Sotto’s', () => {
    const shown = continuedMessagesShown(continued())
    expect(shown[0]).toEqual({ ...first, text: 'Carry on with the mid-chunk test.', handover: { text: prefix.trimEnd(), provider: 'claude', counts } })
    // The reply is the same object: nothing but the split message is copied.
    expect(shown[1]).toBe(reply)
  })

  it('is read once per list and per message, so a detail read again reuses the copy', () => {
    const thread = continued()
    const once = continuedMessagesShown(thread)
    expect(continuedMessagesShown(thread)).toBe(once)
    // A new list with the same first message reuses its split copy.
    expect(continuedMessagesShown({ ...thread, messages: [...thread.messages] })[0]).toBe(once[0])
  })

  it('is shown whole when its words no longer match the record, or when the thread continues nothing', () => {
    const changed: AgentMessage = { ...first, text: first.text.replace('Fix the WAV preview.', 'Fix the WAV previews') }
    const thread = continued([changed, reply])
    expect(continuedMessagesShown(thread)).toBe(thread.messages)
    const plain = { messages: [first, reply] }
    expect(continuedMessagesShown(plain)).toBe(plain.messages)
  })

  it('carries only the user’s words into a handover of the continued thread', () => {
    const words = continuedWordsOnly(continued(), first)
    expect(words).toEqual({ ...first, text: 'Carry on with the mid-chunk test.' })
    expect(words).not.toHaveProperty('handover')
    expect(continuedWordsOnly(continued(), reply)).toBe(reply)
  })

  it('names its branch from the user’s words, and any other prompt from itself', () => {
    expect(continuedPromptWords(continued(), first.text)).toBe('Carry on with the mid-chunk test.')
    expect(continuedPromptWords(continued(), 'A later message.')).toBe('A later message.')
    expect(continuedPromptWords({ continuedFrom: undefined }, first.text)).toBe(first.text)
  })
})

describe('the window’s bridge for continuing (ADR-0088)', () => {
  it('registers nothing where stable built no service', () => {
    const { ipc, handlers, main } = ipcRegistry()
    registerContinueIpc(ipc, undefined, () => [main])()
    expect(handlers.size).toBe(0)
  })

  it('answers the main window only, checks each answer and removes its handlers on close', async () => {
    const { ipc, handlers, main, mainEvent, widgetEvent } = ipcRegistry()
    const calls: ContinueCalls = {
      read: vi.fn(() => ({ status: 'ok' as const, counts })),
      start: vi.fn(async () => ({ status: 'refused' as const, message: 'Wait for this turn to finish, or stop it. A handover carries finished turns.' })),
    }
    const close = registerContinueIpc(ipc, calls, () => [main])
    expect(await handlers.get(CONTINUE_READ)!(mainEvent, { threadId: 'source' })).toEqual({ status: 'ok', counts })
    expect(await handlers.get(CONTINUE_START)!(mainEvent, { threadId: 'source' })).toMatchObject({ status: 'refused' })
    expect(() => handlers.get(CONTINUE_READ)!(widgetEvent, { threadId: 'source' })).toThrow('main Sotto window')
    await expect(handlers.get(CONTINUE_START)!(widgetEvent, { threadId: 'source' })).rejects.toThrow('main Sotto window')
    // An answer that is not one the window can read never crosses.
    vi.mocked(calls.read).mockReturnValueOnce({ status: 'ok', counts, extra: true } as never)
    expect(() => handlers.get(CONTINUE_READ)!(mainEvent, { threadId: 'source' })).toThrow()
    close()
    expect(handlers.size).toBe(0)
  })
})

describe('the runtime (ADR-0072)', () => {
  const roots: string[] = []
  afterEach(async () => {
    for (const root of roots.splice(0)) {
      if (dirname(root) !== tmpdir() || !root.includes('sotto-runtime-continue-')) throw new Error('Unexpected test directory')
      await rm(root, { recursive: true, force: true })
    }
  })
  async function runtime(continueEnabled: boolean | undefined, runsAs?: 'headless-host') {
    const root = await mkdtemp(join(tmpdir(), 'sotto-runtime-continue-')); roots.push(root)
    const credentials = await testCredentials(root, { encryption: { isEncryptionAvailable: () => false, encryptString: () => { throw new Error('No test key') }, decryptString: () => '' } })
    return createAgentRuntime({ directory: root, credentials, settings: () => DEFAULT_SETTINGS, writingSettings: async () => DEFAULT_SETTINGS,
      historyEnabled: () => true, openExternal: async () => undefined, host: new E2EAgentHost(), reasoner: e2eAgentReasoner,
      ...(continueEnabled === undefined ? {} : { continueEnabled }), ...(runsAs ? { runsAs } : {}) })
  }

  it('is off on stable and on in Owl', () => {
    expect(owlFeaturesForTrack('stable')['continue-on-provider']).toBe(false)
    expect(owlFeaturesForTrack('owl')['continue-on-provider']).toBe(true)
  })

  it.each([[undefined], [false]] as const)('builds nothing when the Owl answer is %s', async enabled => {
    const host = await runtime(enabled)
    try { expect(host.continuation).toBeUndefined() } finally { await host.close() }
  })

  it('builds the service on the desktop when the Owl answer is on, and never on a headless host', async () => {
    const desktop = await runtime(true)
    try { expect(desktop.continuation).toBeDefined() } finally { await desktop.close() }
    const headless = await runtime(true, 'headless-host')
    try { expect(headless.continuation).toBeUndefined() } finally { await headless.close() }
  })
})
