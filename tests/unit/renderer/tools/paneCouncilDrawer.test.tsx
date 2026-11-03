import { terminalBridgeFixture, terminalSession, fakeTerminalViews } from '../../../fixtures/renderer/terminalBridge'
import React from 'react'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalSession } from '../../../../src/shared/terminal'
import type { ToolsResult } from '../../../../src/shared/tools'
import { drawerHeight, PaneTerminalDrawer } from '../../../../src/renderer/src/tools/PaneTerminalDrawer'
import { PaneCouncilToggle, PaneTerminalToggle } from '../../../../src/renderer/src/tools/PaneTerminalToggle'
import { PaneTerminalChromeStore } from '../../../../src/renderer/src/tools/paneTerminalStore'
import { TerminalStore } from '../../../../src/renderer/src/tools/terminalStore'
import { clearCouncilDraft, openCouncilDraft, readCouncilDraft } from '../../../../src/renderer/src/features/council/councilDraft'

// The Council's own page is tested in councilChamber.test.tsx; here it only has to say which thread it stands for.
vi.mock('../../../../src/renderer/src/features/council/CouncilView', () => ({
  CouncilView: ({ thread }: { readonly thread?: string }) => <p>The Council of {thread}</p>,
  CouncilLayoutMenu: () => null,
}))
vi.mock('../../../../src/renderer/src/features/council/useCouncils', () => ({ useCouncilEnabled: () => true }))

const workspace = { threadId: 'thread-a', projectId: 'workshop', workingDirectory: 'D:\\work\\workshop', workspaceId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }
const ID_1 = '11111111-1111-4111-8111-111111111111'
const session = (patch: Partial<TerminalSession> = {}): TerminalSession => terminalSession(ID_1, workspace, { place: 'drawer', ...patch })
const ok = <T,>(value: T): ToolsResult<T> => ({ ok: true, value })
const thread = { id: 'thread-a', nativeSessionStarted: true as const, workingDirectory: 'D:\\work\\workshop',
  worktree: { status: 'ready' as const, mode: 'shared' as const, branch: 'main', path: 'D:\\work\\workshop', repositoryRoot: 'D:\\work\\workshop' } }

function setup() {
  const terminal = terminalBridgeFixture({ workspace, commands: {
    create: vi.fn(async () => { const created = session(); terminal.setSessions([created]); return ok({ session: created, output: '', sequence: 1 }) }),
  } })
  const chromeStore = new PaneTerminalChromeStore(null)
  render(<div className="thread-pane" data-thread-id="thread-a">
    <PaneCouncilToggle threadId="thread-a" store={chromeStore} />
    <PaneTerminalToggle threadId="thread-a" store={chromeStore} />
    <PaneTerminalDrawer threadId="thread-a" thread={thread} project={{ path: 'D:\\work\\workshop' }} bridge={terminal.bridge}
      viewFactory={fakeTerminalViews({ fit: { cols: 80, rows: 24 }, className: '' }).factory} store={new TerminalStore('drawer')} chromeStore={chromeStore} />
  </div>)
  return { chromeStore, terminal, council: screen.getByRole('button', { name: 'Council' }), shells: screen.getByRole('button', { name: 'Terminal drawer' }) }
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  // A pane 1000 pixels tall, as the drawer measures it.
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('thread-pane') ? 1000 : 0 })
})
afterEach(() => { cleanup(); clearCouncilDraft(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('the Council in a pane’s drawer (ADR-0177)', () => {
  it('opens on its own tab at half the pane from the header’s Council button, and starts no shell for it', async () => {
    const { council, shells, terminal } = setup()
    await userEvent.click(council)
    expect(council).toHaveAttribute('aria-pressed', 'true')
    expect(council).toHaveAttribute('title', 'Hide Council')
    expect(shells).toHaveAttribute('aria-pressed', 'false')
    expect(await screen.findByRole('tab', { name: 'Council', selected: true })).toBeInTheDocument()
    expect(screen.getByRole('tabpanel')).toHaveTextContent('The Council of thread-a')
    expect(screen.getByRole('separator', { name: 'Resize Council' })).toHaveAttribute('aria-valuenow', '500')
    await act(async () => { await Promise.resolve() })
    expect(terminal.bridge.create).not.toHaveBeenCalled()
    await userEvent.click(council)
    expect(screen.queryByRole('tab', { name: 'Council' })).toBeNull()
  })

  it('shares one bar with the shells: the Terminal drawer button or a shell’s tab shows them, the Council tab brings it back', async () => {
    const { council, shells, terminal, chromeStore } = setup()
    await userEvent.click(council)
    await userEvent.click(shells)
    // The shell starts only once the shells are shown, a third of the pane tall, and the Council keeps its own height.
    await waitFor(() => expect(terminal.bridge.create).toHaveBeenCalledTimes(1))
    expect(shells).toHaveAttribute('aria-pressed', 'true')
    expect(council).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('separator', { name: 'Resize terminal' })).toHaveAttribute('aria-valuenow', '333')
    await userEvent.click(screen.getByRole('tab', { name: 'Council' }))
    expect(screen.getByRole('tab', { name: 'Council', selected: true })).toBeInTheDocument()
    expect(chromeStore.get('thread-a')).toMatchObject({ open: true, view: 'council' })
    await userEvent.click(await screen.findByRole('tab', { name: /PowerShell/ }))
    expect(chromeStore.get('thread-a')).toMatchObject({ open: true, view: 'terminal' })
    expect(terminal.bridge.create).toHaveBeenCalledTimes(1)
  })

  it('keeps each view’s height, half the pane for the Council and a third for the shells until dragged', () => {
    expect(drawerHeight(1000, null, false, 'council').height).toBe(500)
    expect(drawerHeight(1000, null).height).toBe(333)
    // The conversation keeps its room, as it does beside the shells.
    expect(drawerHeight(560, null, false, 'council')).toMatchObject({ height: 240, max: 240 })
    const store = new PaneTerminalChromeStore(null)
    store.setHeight('thread-a', 610, 'council')
    expect(store.get('thread-a')).toMatchObject({ height: null, councilHeight: 610 })
  })

  it('opens the drawer on the Council of the thread a reply was put to it from, with the reply waiting there', () => {
    const store = new PaneTerminalChromeStore(null)
    openCouncilDraft({ originThread: 'thread-a', question: '> A reply' }, store)
    expect(store.get('thread-a')).toMatchObject({ open: true, view: 'council' })
    expect(readCouncilDraft()).toEqual({ originThread: 'thread-a', question: '> A reply' })
  })
})
