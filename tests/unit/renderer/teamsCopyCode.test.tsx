import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TeamsPage } from '../../../src/renderer/src/watcher/TeamsPage'
import type { TeamsBridge, TeamsState } from '../../../src/shared/teams'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const CODE = 'sotto-team:laptop-russh2j5.tail5728ca.ts.net:8445:ABCD2345'
const state: TeamsState = {
  unsaved: false, ownName: 'Zach', listening: true, code: { text: CODE, expiresAt: new Date(Date.now() + 30 * 60_000).toISOString() },
  links: [], messages: [], projects: [], problem: null, serveEnableUrl: null, desks: {}, deskReads: [], setup: null,
}
const bridge: TeamsBridge = {
  get: async () => state,
  command: async () => ({ status: 'ok' }),
  ownDesk: async () => { throw new Error('not used') },
  subscribe: () => () => undefined,
}

// The built window denies the browser clipboard (only the microphone is allowed), so navigator.clipboard refuses there and
// a press that used it copied nothing and never said Copied (Zach's report, November 11, 2026). Main does the copy.
it('Copy code puts the code on the clipboard through main and says Copied', async () => {
  const deliverOutput = vi.fn(async () => 'copied' as const)
  const writeText = vi.fn(async () => { throw new DOMException('Write permission denied.', 'NotAllowedError') })
  vi.stubGlobal('sotto', { ...window.sotto, deliverOutput })
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
  render(<TeamsPage bridge={bridge} state={state} />)

  fireEvent.click(screen.getByRole('button', { name: 'Copy code' }))

  await waitFor(() => expect(deliverOutput).toHaveBeenCalledWith({ text: CODE, autoPaste: false, pasteDelayMs: 50 }))
  expect(writeText).not.toHaveBeenCalled()
  expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument()
})

it('Copy code does not say Copied when main could not copy', async () => {
  const deliverOutput = vi.fn(async () => 'clipboard-unavailable' as const)
  vi.stubGlobal('sotto', { ...window.sotto, deliverOutput })
  render(<TeamsPage bridge={bridge} state={state} />)

  fireEvent.click(screen.getByRole('button', { name: 'Copy code' }))

  await waitFor(() => expect(deliverOutput).toHaveBeenCalled())
  expect(screen.getByRole('button', { name: 'Copy code' })).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Copied' })).toBeNull()
})
