// #2229: a GO MERGE Watcher sent while the merge train held its turn says, under its receipt card, what it went past and
// Watcher's reason, in one line (Zach's pick A, November 5, 2026). A send without one says nothing more.
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import type { AgentMessage } from '../../../src/shared/agents'
import type { WatcherOperation } from '../../../src/shared/watcher'
import { overrideLine, WatcherAfterMessage, WatcherConversationContext, type WatcherConversation } from '../../../src/renderer/src/watcher/WatcherReceipts'

afterEach(cleanup)

const target = { hostId: '11111111-1111-4111-8111-111111111111', threadId: 'worker' }
const send = (id: string): WatcherOperation => ({ id, action: 'send', target, deliveryState: 'accepted' }) as unknown as WatcherOperation
const held = ['#1959 in “Model picker” has its required checks running.']
const reason = 'Zach asked for #2263 before the release.'

it('says what a GO MERGE went past and Watcher’s reason in one line, and nothing for any other send', () => {
  const early = send('11111111-0000-4000-8000-000000000001'), plain = send('11111111-0000-4000-8000-000000000002')
  const conversation = {
    receipts: new Map([['reply', [early, plain]]]), takeovers: new Map(),
    overrides: new Map([[early.id, { held, reason }]]),
    describe: () => ({ threadId: null, title: 'Required checks gate', providerId: undefined, provider: undefined, computer: undefined, project: undefined, remote: false, status: null, tone: '', ring: '' }),
    press: () => ({}),
  } as unknown as WatcherConversation
  render(<WatcherConversationContext.Provider value={conversation}><WatcherAfterMessage message={{ id: 'reply' } as AgentMessage} /></WatcherConversationContext.Provider>)
  const line = 'Merge turn given early. #1959 in “Model picker” has its required checks running. Watcher’s reason: Zach asked for #2263 before the release.'
  expect(screen.getAllByText(line)).toHaveLength(1)
  expect(document.querySelector(`[data-receipt-id="${early.id}"] [data-merge-turn="early"]`)?.textContent).toBe(line)
  expect(document.querySelector(`[data-receipt-id="${plain.id}"] [data-merge-turn]`)).toBeNull()
  expect(overrideLine(undefined)).toBeNull()
})
