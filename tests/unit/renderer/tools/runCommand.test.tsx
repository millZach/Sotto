import { terminalBridgeFixture, terminalSession, fakeTerminalViews } from '../../../fixtures/renderer/terminalBridge'
import React from 'react'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TERMINAL_LIMIT_MESSAGE, type TerminalBridge } from '../../../../src/shared/terminal'
import type { ToolsResult } from '../../../../src/shared/tools'
import { MessageContent } from '../../../../src/renderer/src/agents/MessageContent'
import { drawerHeight, PaneTerminalDrawer } from '../../../../src/renderer/src/tools/PaneTerminalDrawer'
import { PaneTerminalChromeStore } from '../../../../src/renderer/src/tools/paneTerminalStore'
import { RunCommandContext, runInDrawer, type RunCommand } from '../../../../src/renderer/src/tools/runCommand'
import { middleCut } from '../../../../src/renderer/src/tools/TerminalSurface'
import { TerminalStore } from '../../../../src/renderer/src/tools/terminalStore'

const workspace = { threadId: 'thread-a', projectId: 'workshop', workingDirectory: '/work/workshop', workspaceId: 'a'.repeat(64) }
const ID = '11111111-1111-4111-8111-111111111111'
const ok = <T,>(value: T): ToolsResult<T> => ({ ok: true, value })
const thread = { id: 'thread-a', nativeSessionStarted: true as const, workingDirectory: '/work/workshop', worktree: { status: 'ready' as const, mode: 'shared' as const, branch: 'main', path: '/work/workshop', repositoryRoot: '/work', dirty: false } }

function setup(create: TerminalBridge['create']) {
  const terminal = terminalBridgeFixture({ workspace, commands: { create } })
  const chromeStore = new PaneTerminalChromeStore(null)
  const store = new TerminalStore('drawer')
  const { factory } = fakeTerminalViews({ fit: { cols: 80, rows: 24 } })
  render(<div className="thread-pane" id="thread-pane-thread-a">
    <PaneTerminalDrawer threadId="thread-a" thread={thread} project={{ path: '/work/workshop' }} bridge={terminal.bridge} viewFactory={factory} store={store} chromeStore={chromeStore} />
  </div>)
  return { terminal, chromeStore, store }
}

afterEach(() => { cleanup() })
beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} }) })
afterEach(() => { vi.unstubAllGlobals() })

describe('running a reply\'s command in the drawer (ADR-0136)', () => {
  it('opens a closed drawer on one new shell that main starts with the command, and no second empty shell', async () => {
    const created = terminalSession(ID, workspace, { place: 'drawer', title: 'npm run typecheck' })
    const held = Promise.withResolvers<void>()
    const create = vi.fn<TerminalBridge['create']>(async () => { await held.promise; terminal.setSessions([created]); return ok({ session: created, output: '', sequence: 0 }) })
    const { terminal, chromeStore, store } = setup(create)
    let started: Promise<boolean> | undefined
    act(() => { started = runInDrawer('thread-a', 'npm run typecheck', terminal.bridge, store, chromeStore) })
    // The drawer opens and lists its (still empty) shells while main is starting this one; it waits rather than autoStart.
    await waitFor(() => expect(chromeStore.get('thread-a').open).toBe(true))
    await waitFor(() => expect(terminal.bridge.list).toHaveBeenCalledTimes(2))
    expect(await screen.findByRole('status')).toHaveTextContent('Starting terminal…')
    expect(create).toHaveBeenCalledOnce()
    held.resolve()
    await act(async () => { expect(await started).toBe(true) })
    await waitFor(() => expect(screen.getByRole('tab', { name: 'npm run typecheck' })).toHaveAttribute('aria-selected', 'true'))
    expect(create).toHaveBeenCalledOnce()
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread-a', workspaceId: workspace.workspaceId, place: 'drawer', run: 'npm run typecheck' }))
    // Nothing in the window types the command: main wrote it as the shell spawned.
    expect(terminal.bridge.write).not.toHaveBeenCalled()
  })

  it('says in the drawer why a shell could not start, and starts no plain shell in its place', async () => {
    const create = vi.fn<TerminalBridge['create']>(async () => ({ ok: false, error: { code: 'busy', message: TERMINAL_LIMIT_MESSAGE } }))
    const { terminal, chromeStore, store } = setup(create)
    let started: Promise<boolean> | undefined
    act(() => { started = runInDrawer('thread-a', 'git status', terminal.bridge, store, chromeStore) })
    await act(async () => { expect(await started).toBe(false) })
    expect(await screen.findByRole('alert')).toHaveTextContent(`The command did not run. ${TERMINAL_LIMIT_MESSAGE}`)
    expect(screen.getByRole('button', { name: 'Start terminal' })).toBeInTheDocument()
    expect(create).toHaveBeenCalledOnce()
    // Hidden and opened again, the drawer has forgotten the failure and starts a shell as usual.
    act(() => chromeStore.setOpen('thread-a', false))
    act(() => chromeStore.setOpen('thread-a', true))
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2))
    expect(create.mock.calls[1]![0]).not.toHaveProperty('run')
  })

  it('runs both of two quick presses, each in its own new shell', async () => {
    const commands: string[] = []
    const create = vi.fn<TerminalBridge['create']>(async request => {
      const created = terminalSession(commands.length === 0 ? ID : '22222222-2222-4222-8222-222222222222', workspace, { place: 'drawer', title: request.run! })
      commands.push(request.run!)
      terminal.setSessions([...terminal.sessions(), created])
      return ok({ session: created, output: '', sequence: 0 })
    })
    const { terminal, chromeStore, store } = setup(create)
    // The first press's listing is still out when the second comes; serving them in order shows the second superseding it.
    const listed = Promise.withResolvers<void>()
    const list = vi.mocked(terminal.bridge.list)
    const plain = list.getMockImplementation()!
    list.mockImplementationOnce(async request => { await listed.promise; return plain(request) })
    let both: Promise<boolean[]> | undefined
    act(() => { both = Promise.all([runInDrawer('thread-a', 'git status', terminal.bridge, store, chromeStore), runInDrawer('thread-a', 'git log', terminal.bridge, store, chromeStore)]) })
    listed.resolve()
    await act(async () => { expect(await both).toEqual([true, true]) })
    expect(commands).toEqual(['git status', 'git log'])
    await waitFor(() => expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual(['git status', 'git log']))
  })

  it('says so when the thread\'s terminals cannot be listed, rather than going quietly back to idle', async () => {
    const create = vi.fn<TerminalBridge['create']>()
    const { terminal, chromeStore, store } = setup(create)
    vi.mocked(terminal.bridge.list).mockResolvedValue({ ok: false, error: { code: 'workspace-unavailable', message: 'gone' } })
    let started: Promise<boolean> | undefined
    act(() => { started = runInDrawer('thread-a', 'git status', terminal.bridge, store, chromeStore) })
    await act(async () => { expect(await started).toBe(false) })
    expect(create).not.toHaveBeenCalled()
    expect(await screen.findByRole('alert')).toHaveTextContent('The command did not run.')
  })

  it('sizes a Run\'s shell by the same drawer height the drawer itself opens at', () => {
    expect(drawerHeight(900, null)).toEqual({ height: 300, min: 120, max: 580 })
    expect(drawerHeight(900, 800).height).toBe(580)
    // A short pane leaves the conversation its room first; the drawer keeps only its minimum.
    expect(drawerHeight(400, null).height).toBe(120)
    expect(drawerHeight(0, 250)).toEqual({ height: 250, min: 120, max: 250 })
    expect(drawerHeight(900, null, true).min).toBe(184)
  })

  it('cuts a long tab name in the middle and keeps the whole of it for screen readers', () => {
    expect(middleCut('zsh')).toBe('zsh')
    expect(middleCut('sudo ~/Developer/mac-security-agent/mac/install.sh')).toBe('sudo ~/Deve…stall.sh')
  })
})

function reply(text: string, run: RunCommand | undefined, commands = true) {
  return render(<RunCommandContext.Provider value={run}><MessageContent text={text} commands={commands} /></RunCommandContext.Provider>)
}

describe('Run on a reply\'s commands (ADR-0136)', () => {
  it('offers Run above each inline command, runs exactly its text and then offers Run again', async () => {
    let finish: (started: boolean) => void = () => {}
    const run = vi.fn<RunCommand>(() => new Promise(resolve => { finish = resolve }))
    reply('Run `brew install --cask osquery santa`, then open `System Settings › Privacy & Security`. Keep `santa`.', run)
    const buttons = screen.getAllByRole('button', { name: /^Run in terminal: / })
    expect(buttons).toHaveLength(1)
    expect(buttons[0]).toHaveAccessibleName('Run in terminal: brew install --cask osquery santa')
    await userEvent.click(buttons[0]!)
    expect(run).toHaveBeenCalledWith('brew install --cask osquery santa')
    expect(screen.getByRole('button', { name: 'Starting…: brew install --cask osquery santa' })).toHaveTextContent('Starting…')
    await act(async () => { finish(true) })
    expect(screen.getByRole('button', { name: 'Run again: brew install --cask osquery santa' })).toBeInTheDocument()
  })

  it('goes back to Run in terminal when the shell could not start', async () => {
    const run = vi.fn<RunCommand>(async () => false)
    reply('Try `git status`.', run)
    await userEvent.click(screen.getByRole('button', { name: 'Run in terminal: git status' }))
    expect(await screen.findByRole('button', { name: 'Run in terminal: git status' })).toBeInTheDocument()
  })

  it('offers Run beside Copy on a shell block, sending its lines verbatim', async () => {
    const run = vi.fn<RunCommand>(async () => true)
    reply('```zsh\nsantactl status\nosqueryi --version\n```\n\n```ts\nconst a = 1\n```', run)
    const blocks = document.querySelectorAll('.rich-code')
    expect(within(blocks[1] as HTMLElement).queryByRole('button', { name: /Run/u })).toBeNull()
    await userEvent.click(within(blocks[0] as HTMLElement).getByRole('button', { name: 'Run in terminal' }))
    expect(run).toHaveBeenCalledWith('santactl status\nosqueryi --version')
    expect(await within(blocks[0] as HTMLElement).findByRole('button', { name: 'Run again in terminal' })).toHaveTextContent('Run again')
  })

  it('offers nothing without a runner, outside a reply, or while a block is still being written', () => {
    const run = vi.fn<RunCommand>(async () => true)
    reply('Run `git status`.\n\n```bash\nls\n```', undefined)
    expect(screen.queryByRole('button', { name: /Run/u })).toBeNull()
    expect(document.querySelector('code')?.closest('.run-command')).toBeNull()
    cleanup()
    reply('Run `git status`.', run, false)
    expect(screen.queryByRole('button', { name: /Run/u })).toBeNull()
    cleanup()
    reply('See [`git status`](https://git-scm.com/docs/git-status).', run)
    expect(screen.queryByRole('button', { name: /Run/u })).toBeNull()
    cleanup()
    render(<RunCommandContext.Provider value={run}><MessageContent text={'Here:\n\n```bash\nrm -rf build'} streaming commands /></RunCommandContext.Provider>)
    expect(screen.queryByRole('button', { name: /Run/u })).toBeNull()
  })
})
