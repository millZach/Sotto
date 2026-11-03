// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'

import { PopupFeed } from '../../../../src/main/popup/popupFeed'
import type { AgentState, AgentThread, AgentThreadDetailUpdate } from '../../../../src/shared/agents'

const thread = (id: string, status: AgentThread['status'] = 'idle'): AgentThread => ({ id, status } as AgentThread)
const state = (threads: readonly AgentThread[]): AgentState => ({ host: { threads } } as unknown as AgentState)

describe('what main sends the popup (ADR-0181)', () => {
  it('sends nothing while the popup observes nothing', () => {
    const sendThread = vi.fn(), sendDetail = vi.fn()
    const feed = new PopupFeed(sendThread, sendDetail)
    feed.published(state([thread('a')]))
    feed.detail({ threadId: 'a', revision: 1, messages: [] })
    expect(sendThread).not.toHaveBeenCalled()
    expect(sendDetail).not.toHaveBeenCalled()
  })

  it('sends an observed thread\'s record when it is not the one last sent, and its history, and no other thread\'s', () => {
    const sendThread = vi.fn(), sendDetail = vi.fn()
    const feed = new PopupFeed(sendThread, sendDetail)
    feed.observe(['b'])
    const a = thread('a'), b = thread('b')
    feed.published(state([a, b]))
    feed.published(state([a, b]))
    const running = thread('b', 'running')
    feed.published(state([a, running]))
    expect(sendThread.mock.calls.map(([sent]) => sent)).toEqual([b, running])
    const update: AgentThreadDetailUpdate = { threadId: 'b', revision: 2, messages: [] }
    feed.detail(update)
    feed.detail({ threadId: 'a', revision: 1, messages: [] })
    expect(sendDetail.mock.calls).toEqual([[update]])
  })

  it('sends a record again after the popup stopped observing and came back', () => {
    const sendThread = vi.fn()
    const feed = new PopupFeed(sendThread, vi.fn())
    const b = thread('b')
    feed.observe(['b']); feed.published(state([b]))
    feed.observe([]); feed.observe(['b']); feed.published(state([b]))
    expect(sendThread).toHaveBeenCalledTimes(2)
  })
})
