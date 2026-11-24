// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { withWatcherPhoneParts } from '../../../src/main/agents/agentStateBroadcast'
import { withWatcherPhonePartsPutBack, type WatcherConversationMessage } from '../../../src/shared/keptParts'

interface SyntheticWatcherPage {
  readonly hostId: string
  readonly working: boolean
  readonly observedAt: string
  readonly recoveryNotice: string | null
  readonly runtimeMode?: string | undefined
  readonly nextTurnOptions?: { readonly modelId: string } | undefined
  readonly receiptGroups: readonly { readonly requestId: string; readonly count: number }[]
  readonly watchedThreads: readonly { readonly id: string; readonly status: string }[]
  readonly conversation: {
    readonly messages: readonly WatcherConversationMessage[]
    readonly earlierAvailable: boolean
    readonly revision: number
  }
}

function makeMessages(count: number, start = 0): WatcherConversationMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    id: 'msg-' + (start + index),
    role: (start + index) % 2 ? 'assistant' : 'user',
    text: 'Synthetic Watcher words '.repeat(12) + (start + index),
    createdAt: new Date(Date.UTC(2026, 10, 22, 12, 0, start + index)).toISOString(),
  }))
}

function basePage(overrides: Partial<SyntheticWatcherPage> = {}): SyntheticWatcherPage {
  return {
    hostId: 'host-1',
    working: true,
    observedAt: '2026-11-22T12:00:00.000Z',
    recoveryNotice: null,
    runtimeMode: 'auto',
    receiptGroups: Array.from({ length: 40 }, (_, index) => ({ requestId: 'req-' + index, count: index })),
    watchedThreads: [{ id: 'thread-1', status: 'running' }],
    conversation: { messages: makeMessages(200), earlierAvailable: true, revision: 10 },
    ...overrides,
  }
}

describe('watcher-phone-parts encoding and reassembly', () => {
  it('omits unchanged sub-parts and sends only appended text when Watcher streams into the last message', () => {
    const prev = basePage()
    const messages = prev.conversation.messages.slice()
    const last = messages[messages.length - 1]!
    messages[messages.length - 1] = { ...last, text: last.text + ' and one new sentence.' }
    const next = basePage({
      observedAt: '2026-11-22T12:00:00.250Z',
      conversation: { messages, earlierAvailable: true, revision: 11 },
    })

    const wire = withWatcherPhoneParts(next, prev)
    expect(wire.conversation).toBeUndefined()
    expect(wire.conversationDelta).toEqual({
      dropHead: 0,
      keep: 200,
      appendLastText: ' and one new sentence.',
      tail: [],
      earlierAvailable: true,
      revision: 11,
    })
    expect(wire.kept).toEqual(expect.arrayContaining(['hostId', 'working', 'recoveryNotice', 'runtimeMode', 'receiptGroups', 'watchedThreads']))
    expect(wire.receiptGroups).toBeUndefined()
    expect(wire.observedAt).toBe(next.observedAt)
    expect(Buffer.byteLength(JSON.stringify(wire))).toBeLessThan(600)
    expect(withWatcherPhonePartsPutBack(wire, prev)).toEqual(next)
  })

  it('slides the 200-message window with dropHead and sends only the new tail message', () => {
    const prev = basePage()
    const appended: WatcherConversationMessage = {
      id: 'msg-200',
      role: 'assistant',
      text: 'Brand new reply at the cap.',
      createdAt: '2026-11-22T12:05:00.000Z',
    }
    const next = basePage({
      observedAt: '2026-11-22T12:05:00.000Z',
      conversation: { messages: [...prev.conversation.messages.slice(1), appended], earlierAvailable: true, revision: 12 },
    })

    const wire = withWatcherPhoneParts(next, prev)
    expect(wire.conversation).toBeUndefined()
    expect(wire.conversationDelta).toEqual({
      dropHead: 1,
      keep: 199,
      tail: [appended],
      earlierAvailable: true,
      revision: 12,
    })
    expect(withWatcherPhonePartsPutBack(wire, prev)).toEqual(next)
  })

  it('keeps the entire conversation when only non-conversation fields change', () => {
    const prev = basePage({ working: true, nextTurnOptions: { modelId: 'model-a' } })
    const next = basePage({
      working: false,
      observedAt: '2026-11-22T12:00:05.000Z',
      nextTurnOptions: undefined,
    })

    const wire = withWatcherPhoneParts(next, prev)
    expect(wire.conversation).toBeUndefined()
    expect(wire.conversationDelta).toBeUndefined()
    expect(wire.kept).toContain('conversation')
    expect(wire.kept).toContain('receiptGroups')
    expect(wire.kept).not.toContain('nextTurnOptions')
    expect(wire.working).toBe(false)
    const restored = withWatcherPhonePartsPutBack(wire, prev)
    expect(restored).toEqual(next)
    expect(restored?.nextTurnOptions).toBeUndefined()
  })

  it('falls back to sending conversation whole when a new Watcher replaces the history', () => {
    const prev = basePage()
    const next = basePage({
      observedAt: '2026-11-22T12:06:00.000Z',
      conversation: { messages: makeMessages(2, 900), earlierAvailable: false, revision: 1 },
    })

    const wire = withWatcherPhoneParts(next, prev)
    expect(wire.conversationDelta).toBeUndefined()
    expect(wire.conversation).toEqual(next.conversation)
    expect(withWatcherPhonePartsPutBack(wire, prev)).toEqual(next)
  })

  it('falls back to tail replacement rather than append when a message shrinks or attachments change', () => {
    const prev = basePage()
    const messages = prev.conversation.messages.slice()
    const last = messages[messages.length - 1]!
    messages[messages.length - 1] = { ...last, text: last.text + ' with attachment', attachments: [{ id: 'a1' }] }
    const next = basePage({
      observedAt: '2026-11-22T12:00:01.000Z',
      conversation: { messages, earlierAvailable: true, revision: 11 },
    })

    const wire = withWatcherPhoneParts(next, prev)
    expect(wire.conversationDelta).toEqual({
      dropHead: 0,
      keep: 199,
      tail: [messages[199]!],
      earlierAvailable: true,
      revision: 11,
    })
    expect(withWatcherPhonePartsPutBack(wire, prev)).toEqual(next)
  })

  it('rejects malformed, conflicting, or out-of-bounds wire updates', () => {
    const prev = basePage()
    expect(withWatcherPhonePartsPutBack({ kept: ['working'] }, null)).toBeUndefined()
    expect(withWatcherPhonePartsPutBack({ kept: ['missingField'] }, prev)).toBeUndefined()
    expect(withWatcherPhonePartsPutBack({ kept: ['kept'] }, prev)).toBeUndefined()
    expect(withWatcherPhonePartsPutBack({
      kept: ['conversation'],
      conversationDelta: { dropHead: 0, keep: 1, tail: [], earlierAvailable: false, revision: 11 },
    }, prev)).toBeUndefined()
    expect(withWatcherPhonePartsPutBack({
      conversation: prev.conversation,
      conversationDelta: { dropHead: 0, keep: 1, tail: [], earlierAvailable: false, revision: 11 },
    }, prev)).toBeUndefined()
    expect(withWatcherPhonePartsPutBack({
      conversationDelta: { dropHead: 150, keep: 60, tail: [], earlierAvailable: false, revision: 11 },
    }, prev)).toBeUndefined()
    expect(withWatcherPhonePartsPutBack({
      conversationDelta: { dropHead: -1, keep: 1, tail: [], earlierAvailable: false, revision: 11 },
    }, prev)).toBeUndefined()
    expect(withWatcherPhonePartsPutBack({
      conversationDelta: { dropHead: Number.MAX_SAFE_INTEGER, keep: 1, tail: [], earlierAvailable: false, revision: 11 },
    }, prev)).toBeUndefined()
    expect(withWatcherPhonePartsPutBack({
      conversationDelta: { dropHead: 1, keep: Number.MAX_SAFE_INTEGER, tail: [], earlierAvailable: false, revision: 11 },
    }, prev)).toBeUndefined()
    expect(withWatcherPhonePartsPutBack({
      conversationDelta: { dropHead: 1e20, keep: 0, tail: [], earlierAvailable: false, revision: 11 },
    }, prev)).toBeUndefined()
    expect(withWatcherPhonePartsPutBack({
      conversationDelta: { dropHead: 0, keep: 0, appendLastText: 'bad', tail: [], earlierAvailable: false, revision: 11 },
    }, prev)).toBeUndefined()
    expect(withWatcherPhonePartsPutBack({ kept: ['receiptGroupsDelta'] }, prev)).toBeUndefined()
    expect(withWatcherPhonePartsPutBack({
      kept: ['receiptGroups'],
      receiptGroupsDelta: { dropHead: 0, keep: 1, tail: [] },
    }, prev)).toBeUndefined()
    expect(withWatcherPhonePartsPutBack({
      receiptGroups: prev.receiptGroups,
      receiptGroupsDelta: { dropHead: 0, keep: 1, tail: [] },
    }, prev)).toBeUndefined()
    expect(withWatcherPhonePartsPutBack({
      receiptGroupsDelta: { dropHead: 30, keep: 20, tail: [] },
    }, prev)).toBeUndefined()
    expect(withWatcherPhonePartsPutBack({
      receiptGroupsDelta: { dropHead: 0, keep: 2, replaced: [{ index: 2, group: { requestId: 'bad', count: 0 } }], tail: [] },
    }, prev)).toBeUndefined()
  })

  it('deltas receiptGroups only when receiptDeltas is enabled and keeps legacy callers whole', () => {
    const prev = basePage()
    // Update one group mid-array (e.g. an older worker finishing with outcome='answered') and append one new group.
    const updatedGroups = prev.receiptGroups.slice()
    updatedGroups[5] = { requestId: 'req-5', count: 999 }
    updatedGroups.push({ requestId: 'req-40', count: 40 })
    const next = basePage({
      observedAt: '2026-11-22T12:00:02.000Z',
      receiptGroups: updatedGroups,
    })

    // Legacy phone without `watcher-phone-receipt-deltas` still gets `receiptGroups` whole.
    const legacyWire = withWatcherPhoneParts(next, prev)
    expect(legacyWire.receiptGroupsDelta).toBeUndefined()
    expect(legacyWire.receiptGroups).toEqual(updatedGroups)
    expect(withWatcherPhonePartsPutBack(legacyWire, prev)).toEqual(next)

    // Updated phone with `watcher-phone-receipt-deltas` gets a sparse delta.
    const deltaWire = withWatcherPhoneParts(next, prev, { receiptDeltas: true })
    expect(deltaWire.receiptGroups).toBeUndefined()
    expect(deltaWire.receiptGroupsDelta).toEqual({
      dropHead: 0,
      keep: 40,
      replaced: [{ index: 5, group: { requestId: 'req-5', count: 999 } }],
      tail: [{ requestId: 'req-40', count: 40 }],
    })
    expect(withWatcherPhonePartsPutBack(deltaWire, prev)).toEqual(next)
    expect(Buffer.byteLength(JSON.stringify(deltaWire))).toBeLessThan(Buffer.byteLength(JSON.stringify(legacyWire)) / 4)

    // Sliding the head as older receipts age out of the 200-message window sends dropHead + new tail only.
    const slidGroups = [...prev.receiptGroups.slice(2), { requestId: 'req-40', count: 40 }]
    const slidNext = basePage({ observedAt: '2026-11-22T12:00:03.000Z', receiptGroups: slidGroups })
    const slidWire = withWatcherPhoneParts(slidNext, prev, { receiptDeltas: true })
    expect(slidWire.receiptGroupsDelta).toEqual({
      dropHead: 2,
      keep: 38,
      tail: [{ requestId: 'req-40', count: 40 }],
    })
    expect(withWatcherPhonePartsPutBack(slidWire, prev)).toEqual(slidNext)

    // Completely replaced receipt history (e.g. New Watcher) falls back cleanly to whole `receiptGroups`.
    const freshNext = basePage({
      observedAt: '2026-11-22T12:00:04.000Z',
      receiptGroups: [{ requestId: 'brand-new', count: 1 }],
    })
    const freshWire = withWatcherPhoneParts(freshNext, prev, { receiptDeltas: true })
    expect(freshWire.receiptGroupsDelta).toBeUndefined()
    expect(freshWire.receiptGroups).toEqual(freshNext.receiptGroups)
    expect(withWatcherPhonePartsPutBack(freshWire, prev)).toEqual(freshNext)
  })
})
