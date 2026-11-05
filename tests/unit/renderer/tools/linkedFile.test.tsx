import React from 'react'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { LinkedFilePanel } from '../../../../src/renderer/src/tools/LinkedFilePanel'
import { BesideLinkedFile } from '../../../../src/renderer/src/watcher/WatcherBeside'
import { focusLinkOpener, linkedFileThread, rememberLinkOpener } from '../../../../src/renderer/src/tools/linkedFile'
import { ToolsPanelStore } from '../../../../src/renderer/src/tools/toolsPanelStore'
import { threadLinkRouter } from '../../../../src/renderer/src/tools/webLinks'
import type { AgentHostSnapshot, AgentThread } from '../../../../src/shared/agents'
import type { FilesBridge } from '../../../../src/shared/files'

vi.mock('../../../../src/renderer/src/state/owlFeature', async importOriginal => ({
  ...await importOriginal<typeof import('../../../../src/renderer/src/state/owlFeature')>(),
  useOwlFeature: () => true,
}))

const file = { threadId: 'thread', path: 'docs/plan.md:12', revision: 1 }
const ready = { ok: true as const, value: { name: 'plan.md', size: 24, text: '# The plan\n\n![a](https://example.com/a.png)' } }
const bridge = (overrides: Partial<FilesBridge> = {}): FilesBridge => ({
  list: vi.fn(), preview: vi.fn(), copyPath: vi.fn(), revealLink: vi.fn(async () => ({ ok: true as const, value: {} })), previewLink: vi.fn(async () => ready), ...overrides,
})

beforeEach(() => { (window as { sotto?: unknown }).sotto = { platform: 'win32' } })
afterEach(() => { cleanup(); delete (window as { sotto?: unknown }).sotto })

describe('the linked file panel', () => {
  it('draws the file through the safe renderer, read only, and takes focus for the keyboard', async () => {
    const files = bridge()
    render(<LinkedFilePanel file={file} bridge={files} onClose={() => undefined} />)
    expect(await screen.findByRole('heading', { name: 'The plan' })).toBeInTheDocument()
    expect(files.previewLink).toHaveBeenCalledWith({ threadId: 'thread', path: 'docs/plan.md:12' })
    // The window's name for it drops the link's location, and a picture in the file stays unloaded.
    expect(screen.getByRole('region', { name: 'Preview of plan.md' })).toBeInTheDocument()
    expect(screen.getByText('24 B · Read only')).toBeInTheDocument()
    expect(document.querySelector('img')).toBeNull()
    expect(document.activeElement).toHaveAttribute('aria-label', 'plan.md contents')
  })

  it('shows its Markdown as source, and reads it again on a press', async () => {
    const user = userEvent.setup()
    const files = bridge()
    render(<LinkedFilePanel file={file} bridge={files} onClose={() => undefined} />)
    await screen.findByRole('heading', { name: 'The plan' })
    await user.click(screen.getByRole('button', { name: 'Source' }))
    expect(screen.getByLabelText('plan.md contents', { selector: 'pre' })).toHaveTextContent('# The plan')
    await user.click(screen.getByRole('button', { name: 'Read plan.md again' }))
    await waitFor(() => expect(files.previewLink).toHaveBeenCalledTimes(2))
  })

  it('offers the folder on this computer and says where a paired host\'s file is, with no folder to offer', async () => {
    const files = bridge()
    const { unmount } = render(<LinkedFilePanel file={file} bridge={files} onClose={() => undefined} />)
    const reveal = await screen.findByRole('button', { name: 'Show in File Explorer: plan.md' })
    await userEvent.click(reveal)
    expect(files.revealLink).toHaveBeenCalledWith({ threadId: 'thread', path: 'docs/plan.md:12' })
    unmount()
    render(<LinkedFilePanel file={file} host="forge" bridge={bridge()} onClose={() => undefined} />)
    expect(await screen.findByText('24 B · Read only · on forge')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Show in File Explorer/u })).toBeNull()
  })

  it('says what main said when it would not read the file, and offers to try again', async () => {
    const user = userEvent.setup()
    const files = bridge({ previewLink: vi.fn(async () => ({ ok: false as const, error: { code: 'path-unavailable' as const, message: 'This file is not on the computer this thread runs on, or it has moved. Nothing was opened.' } })) })
    render(<LinkedFilePanel file={file} bridge={files} onClose={() => undefined} />)
    expect(await screen.findByText('This file is not on the computer this thread runs on, or it has moved. Nothing was opened.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Read again' }))
    await waitFor(() => expect(files.previewLink).toHaveBeenCalledTimes(2))
  })

  it('closes on Escape, on its close and on Back, and names the thread waiting behind it', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<LinkedFilePanel file={file} backTo="Visual gate flake" bridge={bridge()} onClose={onClose} />)
    await screen.findByRole('heading', { name: 'The plan' })
    await user.keyboard('{Escape}')
    await user.click(screen.getByRole('button', { name: 'Close preview' }))
    await user.click(screen.getByRole('button', { name: 'Back to Visual gate flake' }))
    expect(onClose).toHaveBeenCalledTimes(3)
  })

  it('keeps a slower answer from replacing the file pressed after it', async () => {
    let first: (value: typeof ready) => void = () => undefined
    const later = { ok: true as const, value: { name: 'later.md', size: 9, text: '# Later' } }
    const previewLink = vi.fn().mockImplementationOnce(() => new Promise(resolve => { first = resolve })).mockImplementation(async () => later)
    const { rerender } = render(<LinkedFilePanel file={file} bridge={bridge({ previewLink })} onClose={() => undefined} />)
    rerender(<LinkedFilePanel file={{ threadId: 'thread', path: 'later.md', revision: 2 }} bridge={bridge({ previewLink })} onClose={() => undefined} />)
    expect(await screen.findByRole('heading', { name: 'Later' })).toBeInTheDocument()
    await act(async () => { first(ready); await Promise.resolve() })
    expect(screen.queryByRole('heading', { name: 'The plan' })).toBeNull()
  })
})

describe('the linked file beside Watcher', () => {
  it('shows Loading, not the file from before, while the same path loads from another thread', async () => {
    const previewLink = vi.fn().mockImplementationOnce(async () => ready).mockImplementation(() => new Promise(() => undefined))
    ;(window as { sotto?: unknown }).sotto = { platform: 'win32', files: bridge({ previewLink }) }
    const beside = (threadId: string): React.ReactElement => <BesideLinkedFile file={{ threadId, path: 'README.md', revision: 1 }} host={undefined} waiting={undefined} onFocus={() => undefined} />
    const { rerender } = render(beside('watcher'))
    expect(await screen.findByRole('heading', { name: 'The plan' })).toBeInTheDocument()
    rerender(beside('worker'))
    await waitFor(() => expect(previewLink).toHaveBeenLastCalledWith({ threadId: 'worker', path: 'README.md' }))
    expect(screen.queryByRole('heading', { name: 'The plan' })).toBeNull()
    expect(screen.getByText('Loading…')).toBeInTheDocument()
  })
})

describe('where a press opens the file', () => {
  it('opens Tools on Files, pinning it when it looks at another thread, and a second press reads again', () => {
    const store = new ToolsPanelStore()
    store.pin('other')
    threadLinkRouter('thread', 'Thread', undefined, store).openFile!('plan.md')
    expect(store.getSnapshot()).toMatchObject({ open: true, surface: 'files', pinnedThreadId: 'thread' })
    const shown = store.linkedFile('thread')!
    expect(shown).toMatchObject({ threadId: 'thread', path: 'plan.md' })
    threadLinkRouter('thread', 'Thread', undefined, store).openFile!('plan.md')
    expect(store.linkedFile('thread')!.revision).toBeGreaterThan(shown.revision)
    store.closeLinkedFile('thread')
    expect(store.linkedFile('thread')).toBeNull()
  })

  it('pins an unpinned panel only for a press in a pane it is not following', () => {
    const followed = new ToolsPanelStore()
    threadLinkRouter('thread', 'Thread', undefined, followed, true).openFile!('plan.md')
    expect(followed.getSnapshot().pinnedThreadId).toBeNull()
    const other = new ToolsPanelStore()
    threadLinkRouter('thread', 'Thread', undefined, other, false).openFile!('plan.md')
    expect(other.getSnapshot().pinnedThreadId).toBe('thread')
  })

  it('takes the press where a room says, leaving Tools alone', () => {
    const store = new ToolsPanelStore()
    const route = { open: vi.fn(), readerOf: vi.fn(() => 'worker') }
    threadLinkRouter('thread', 'Thread', undefined, store, true, undefined, route).openFile!('plan.md')
    expect(route.open).toHaveBeenCalledWith('thread', 'plan.md')
    expect(store.getSnapshot().open).toBe(false)
  })

  it('asks the machine that holds the file to show it in its folder, when a room knows which that is', async () => {
    const revealLink = vi.fn(async () => ({ ok: true as const, value: {} }))
    ;(window as { sotto?: unknown }).sotto = { platform: 'win32', files: { revealLink } }
    const route = { open: vi.fn(), readerOf: vi.fn(() => 'worker') }
    await threadLinkRouter('watcher', 'Watcher', undefined, new ToolsPanelStore(), true, undefined, route).revealFile!('/home/me/project/plan.md')
    expect(revealLink).toHaveBeenCalledWith({ threadId: 'worker', path: '/home/me/project/plan.md' })
  })

  it('returns focus to the link, or to the fallback when the link is gone', () => {
    const link = document.body.appendChild(document.createElement('button'))
    rememberLinkOpener(link)
    focusLinkOpener()
    expect(document.activeElement).toBe(link)
    rememberLinkOpener(link)
    link.remove()
    const fallback = vi.fn()
    focusLinkOpener(fallback)
    expect(fallback).toHaveBeenCalledOnce()
  })
})

describe('whose machine reads a link in Watcher\'s reply', () => {
  const thread = (id: string, workingDirectory?: string, projectId = 'none'): AgentThread => ({ id, workingDirectory, projectId }) as unknown as AgentThread
  const host = { threads: [thread('watcher', 'C:\\Users\\me\\watcher'), thread('forge', '/home/me/project'), thread('deeper', '/home/me/project/.worktrees/a'), thread('none'), thread('shared', undefined, 'checkout')],
    projects: [{ id: 'checkout', path: '/srv/checkout' }] } as unknown as Pick<AgentHostSnapshot, 'threads' | 'projects'>

  it('reads a full path inside a thread\'s folder from that thread, the deepest folder first', () => {
    expect(linkedFileThread(host, 'watcher', '/home/me/project/docs/plan.md')).toBe('forge')
    expect(linkedFileThread(host, 'watcher', '/home/me/project/.worktrees/a/plan.md')).toBe('deeper')
    // Watcher's own folder does not hide a deeper one inside it, and wins a tie.
    expect(linkedFileThread({ ...host, threads: [thread('outer', '/srv/repo'), thread('inner', '/srv/repo/.worktrees/task')] }, 'outer', '/srv/repo/.worktrees/task/plan.md')).toBe('inner')
    expect(linkedFileThread({ ...host, threads: [thread('other', '/srv/repo'), thread('outer', '/srv/repo')] }, 'outer', '/srv/repo/plan.md')).toBe('outer')
    // A thread sharing its project's checkout holds what the project holds.
    expect(linkedFileThread(host, 'watcher', '/srv/checkout/plan.md')).toBe('shared')
  })
  it('keeps anything else with Watcher, whose own folder wins', () => {
    expect(linkedFileThread(host, 'watcher', 'c:/users/ME/watcher/plan.md')).toBe('watcher')
    expect(linkedFileThread(host, 'watcher', '~/.claude/plans/plan.md')).toBe('watcher')
    expect(linkedFileThread(host, 'watcher', 'docs/plan.md')).toBe('watcher')
    expect(linkedFileThread(host, 'watcher', '/etc/plan.md')).toBe('watcher')
    // A folder's name is not a prefix of a neighbour's.
    expect(linkedFileThread(host, 'watcher', '/home/me/project-two/plan.md')).toBe('watcher')
  })
})
