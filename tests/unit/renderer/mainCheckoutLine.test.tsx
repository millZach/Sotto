import React from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { MainCheckoutBridge, MainCheckoutChanges, ProjectMainCheckout } from '../../../src/shared/mainCheckout'
import { MainCheckoutLine } from '../../../src/renderer/src/agents/MainCheckoutLine'
import { blockWords, showLabel } from '../../../src/renderer/src/agents/mainCheckoutLine.logic'

afterEach(cleanup)

const blocked: ProjectMainCheckout = { projectId: 'sotto', branch: 'main', behind: 1320, blocked: { reason: 'changes' }, dependencies: null }

function bridge(changes: MainCheckoutChanges = { items: [{ kind: 'modified', text: 'src/main/index.ts' }, { kind: 'deleted', text: 'docs/old.md' }], more: 3 }) {
  const command = vi.fn(async () => ({ projects: [] }))
  const read: MainCheckoutBridge = { read: vi.fn(async () => ({ projects: [] })), changes: vi.fn(async () => changes), command, onChanged: () => () => undefined }
  return { bridge: read, command }
}

describe('Keep main up to date on the project row (ADR-0142)', () => {
  it('says how far behind main is and why, and lists what is in the way on Show changes', async () => {
    const user = userEvent.setup()
    const { bridge: main, command } = bridge()
    render(<MainCheckoutLine line={blocked} title="Sotto" bridge={main} />)
    expect(screen.getByText('main is 1,320 behind')).toBeTruthy()
    expect(screen.getByText(/local changes block the update/u)).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Show changes in Sotto' }))
    await waitFor(() => expect(screen.getByText('src/main/index.ts')).toBeTruthy())
    expect(screen.getByText('and 3 more')).toBeTruthy()
    expect(main.changes).toHaveBeenCalledWith('sotto')
    await user.click(screen.getByRole('button', { name: 'Open the Sotto folder' }))
    expect(command).toHaveBeenCalledWith({ type: 'open-folder', projectId: 'sotto' })
    // Escape closes the list and hands the focus back to its press.
    await user.keyboard('{Escape}')
    expect(screen.queryByText('src/main/index.ts')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Show changes in Sotto' }))
  })

  it('says dependencies changed after an update until dismissed', async () => {
    const user = userEvent.setup()
    const { bridge: main, command } = bridge()
    render(<MainCheckoutLine line={{ ...blocked, behind: 0, blocked: null, dependencies: ['package-lock.json'] }} title="Sotto" bridge={main} />)
    expect(screen.getByText('Updated main')).toBeTruthy()
    expect(screen.getByText(/dependencies changed, run install/u)).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'What changed in Sotto' }))
    expect(screen.getByText('package-lock.json')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Dismiss dependencies changed in Sotto' }))
    expect(command).toHaveBeenCalledWith({ type: 'dismiss-dependencies', projectId: 'sotto' })
  })

  it('says nothing without the bridge, which stable never has', () => {
    const { container } = render(<MainCheckoutLine line={blocked} title="Sotto" bridge={undefined} />)
    expect(container.textContent).toBe('')
  })

  it('names each block in plain words, with a press only where there is something to list', () => {
    const line = (block: ProjectMainCheckout['blocked']): ProjectMainCheckout => ({ ...blocked, blocked: block })
    expect(blockWords(line({ reason: 'untracked' }))).toBe('untracked files are in the way')
    expect(blockWords(line({ reason: 'in-progress', operation: 'rebase' }))).toBe('a rebase is in progress')
    expect(blockWords(line({ reason: 'branch', checkedOut: 'fix/tray-icon' }))).toBe('fix/tray-icon is checked out')
    expect(blockWords(line({ reason: 'branch', checkedOut: null }))).toBe('no branch is checked out')
    expect(blockWords(line({ reason: 'diverged', ahead: 1 }))).toBe('a local commit blocks the update')
    expect(blockWords(line({ reason: 'diverged', ahead: 2 }))).toBe('2 local commits block the update')
    expect(showLabel(line({ reason: 'branch', checkedOut: 'fix/tray-icon' }))).toBeNull()
    expect(showLabel(line({ reason: 'diverged', ahead: 2 }))).toBe('Show commits')
    expect(showLabel(line({ reason: 'untracked' }))).toBe('Show changes')
  })
})
