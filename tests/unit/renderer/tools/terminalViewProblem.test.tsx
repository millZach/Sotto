import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { requestAnswerStore } from '../../../../src/renderer/src/agents/requests/requestAnswers'
import { TerminalViewProblem } from '../../../../src/renderer/src/tools/TerminalViewProblem'

const drafts = vi.hoisted(() => ({ flushForReload: vi.fn(async () => true), canReload: vi.fn(() => true) }))
vi.mock('../../../../src/renderer/src/agents/AgentContext', () => ({ useOptionalAgents: () => ({ threadDrafts: drafts }) }))
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); drafts.flushForReload.mockResolvedValue(true); drafts.canReload.mockReturnValue(true) })

it('keeps the window open for an unsaved structured answer until saving succeeds', async () => {
  const reloadApp = vi.fn(async () => undefined)
  vi.stubGlobal('sotto', { reloadApp })
  const safe = vi.spyOn(requestAnswerStore, 'flushForReload').mockResolvedValue(false)
  render(<TerminalViewProblem />)
  fireEvent.click(screen.getByRole('button', { name: 'Reload window' }))
  expect(await screen.findByText(/Some drafts could not be saved/)).toBeInTheDocument()
  expect(reloadApp).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: 'Reload window' })).toBeEnabled()
  safe.mockResolvedValue(true)
  fireEvent.click(screen.getByRole('button', { name: 'Reload window' }))
  await waitFor(() => expect(reloadApp).toHaveBeenCalledOnce())
})

it('keeps a failed reload actionable and retries the main-window command', async () => {
  const reloadApp = vi.fn().mockRejectedValueOnce(new Error('Unavailable')).mockResolvedValue(undefined)
  vi.stubGlobal('sotto', { reloadApp })
  render(<TerminalViewProblem />)
  fireEvent.click(screen.getByRole('button', { name: 'Reload window' }))
  expect(await screen.findByText(/The window could not reload/)).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Reload window' })).toBeEnabled()
  fireEvent.click(screen.getByRole('button', { name: 'Reload window' }))
  await waitFor(() => expect(reloadApp).toHaveBeenCalledTimes(2))
})

it('saves again when a thread draft changes while an answer save is pending', async () => {
  const reloadApp = vi.fn(async () => undefined)
  vi.stubGlobal('sotto', { reloadApp })
  drafts.canReload.mockReturnValueOnce(false).mockReturnValue(true)
  const answers = vi.spyOn(requestAnswerStore, 'flushForReload').mockResolvedValue(true)
  render(<TerminalViewProblem />)
  fireEvent.click(screen.getByRole('button', { name: 'Reload window' }))
  await waitFor(() => expect(reloadApp).toHaveBeenCalledOnce())
  expect(answers).toHaveBeenCalledTimes(2)
})
