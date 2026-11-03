import React from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PopupApp } from '../../../../src/renderer/src/popup/PopupApp'
import { readPopupMemory, writePopupMemory } from '../../../../src/renderer/src/popup/popupLogic'
import type { PopupBridge } from '../../../../src/shared/popup'
import type { AgentThreadDetail } from '../../../../src/shared/agents'
import { DEFAULT_SETTINGS } from '../../../../src/shared/settings'
import { threadsStateFixture } from '../../../fixtures/agentState'
import { deferred } from '../../../fixtures/deferred'

beforeEach(() => {
  window.localStorage.clear()
  vi.stubGlobal('ResizeObserver', class { observe(): void {} disconnect(): void {} })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.localStorage.clear() })

function bridgeFixture(patch: Partial<PopupBridge> = {}): PopupBridge {
  const state = threadsStateFixture({ threads: [{ id: 'thread', title: 'Work' }] })
  return {
    platform: 'darwin', getSettings: async () => DEFAULT_SETTINGS,
    onSettingsChanged: () => () => undefined,
    shell: async () => state, threadDetail: async () => ({ threadId: 'thread', revision: 0, messages: [] }),
    onThreadDetail: () => () => undefined, onThread: () => () => undefined,
    command: async () => ({ ...state, host: { ...state.host, models: { revision: 0, omitted: true }, clientHosts: [] } }), openExternalLink: async () => ({ ok: true }),
    hide: async () => undefined, fit: async () => undefined, open: async () => undefined, onShown: () => () => undefined,
    ...patch,
  }
}

it('reports a failed shell read using the existing popup notice', async () => {
  render(<PopupApp bridge={bridgeFixture({ shell: async () => { throw new Error('ENOENT /private/threads.json') } })} />)
  expect(await screen.findByRole('alert')).toHaveTextContent('Sotto could not read the threads. Reopen the popup and try again.')
  expect(document.body).not.toHaveTextContent('/private/')
})

it('reports a rejected thread history without replacing it with a raw failure', async () => {
  writePopupMemory(window.localStorage, { target: 'thread', threadId: 'thread', projectId: null })
  render(<PopupApp bridge={bridgeFixture({ threadDetail: async () => {
    throw new Error('ENOENT /private/messages.json')
  } })} />)
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not load this thread’s messages. Open it in Sotto or reopen the popup to try again.')
  expect(document.body).not.toHaveTextContent('/private/')
})

it('keeps the Watcher choice when its room read fails, rather than saying it stopped', async () => {
  writePopupMemory(window.localStorage, { target: 'watcher', threadId: null, projectId: null })
  render(<PopupApp bridge={bridgeFixture({ watcher: async () => { throw new Error('room unavailable') } })} />)
  expect(await screen.findByRole('alert')).toHaveTextContent('Sotto could not read the threads. Reopen the popup and try again.')
  expect(readPopupMemory(window.localStorage).target).toBe('watcher')
  expect(document.body).not.toHaveTextContent('Watcher isn’t running')
})

it('forgets a removed thread without reporting a read failure', async () => {
  const state = threadsStateFixture({ threads: [] })
  writePopupMemory(window.localStorage, { target: 'thread', threadId: 'removed', projectId: null })
  await act(async () => { render(<PopupApp bridge={bridgeFixture({ shell: async () => state, threadDetail: async () => null })} />) })
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.getByRole('textbox')).toHaveAccessibleName(/^Message New thread/u)
})

it('ignores a failed read after the user starts a new thread', async () => {
  const pending = deferred<AgentThreadDetail | null>()
  writePopupMemory(window.localStorage, { target: 'thread', threadId: 'thread', projectId: null })
  render(<PopupApp bridge={bridgeFixture({ threadDetail: () => pending.promise })} />)
  await userEvent.click(screen.getByRole('button', { name: 'New thread' }))
  await act(async () => { pending.reject(new Error('old read')) })
  expect(screen.queryByRole('alert')).toBeNull()
})

it('clears a history read notice when reopening successfully reads it', async () => {
  let show!: () => void
  let fail = true
  writePopupMemory(window.localStorage, { target: 'thread', threadId: 'thread', projectId: null })
  render(<PopupApp bridge={bridgeFixture({
    onShown: listener => { show = listener; return () => undefined },
    threadDetail: async () => {
      if (fail) throw new Error('history unavailable')
      return { threadId: 'thread', revision: 0, messages: [] }
    },
  })} />)
  await screen.findByRole('alert')
  fail = false
  await act(async () => { show() })
  expect(screen.queryByRole('alert')).toBeNull()
})
