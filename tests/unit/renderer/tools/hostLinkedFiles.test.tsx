import React from 'react'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FileDownloadLine } from '../../../../src/renderer/src/tools/FileDownload'
import { FileDownloadsStore } from '../../../../src/renderer/src/tools/fileDownloads'
import { FilesBrowserStore, visibleRows } from '../../../../src/renderer/src/tools/filesBrowser'
import { hostThreadFiles } from '../../../../src/renderer/src/tools/hostThreadTools'
import { LinkedFilePanel } from '../../../../src/renderer/src/tools/LinkedFilePanel'
import { ToolsPanelStore } from '../../../../src/renderer/src/tools/toolsPanelStore'
import { threadLinkRouter } from '../../../../src/renderer/src/tools/webLinks'
import type { FileDownload, FileDownloadProgress, FileListRequest, FilesBridge, FilesResult } from '../../../../src/shared/files'

const owl = vi.hoisted(() => ({ on: true }))
vi.mock('../../../../src/renderer/src/state/owlFeature', async importOriginal => ({
  ...await importOriginal<typeof import('../../../../src/renderer/src/state/owlFeature')>(),
  useOwlFeature: () => owl.on,
}))

const workspace = { threadId: 'host:thread', projectId: 'host:project', workingDirectory: '/home/zach/Projects/reports', workspaceId: 'a'.repeat(64) }
const TREE: Record<string, { name: string; kind: 'file' | 'directory' }[]> = {
  '': [{ name: 'out', kind: 'directory' }, { name: 'notes.md', kind: 'file' }],
  out: [{ name: 'figures', kind: 'directory' }, { name: 'q3-report.pdf', kind: 'file' }],
  'out/figures': [{ name: 'revenue.png', kind: 'file' }],
}
/** A paired host's Files: a small tree, a download the test finishes by hand, and the progress it sends. */
function hostBridge(overrides: Partial<FilesBridge> = {}) {
  let progress: ((event: FileDownloadProgress) => void) | undefined
  let finish: (result: FilesResult<FileDownload>) => void = () => undefined
  const bridge = {
    list: vi.fn(async ({ path }: FileListRequest) => ({ ok: true as const, value: { workspace, path, truncated: false, entries: (TREE[path] ?? []).map(entry => ({ ...entry, path: path ? `${path}/${entry.name}` : entry.name })) } })),
    preview: vi.fn(async () => ({ ok: false as const, error: { code: 'binary' as const, message: '' } })),
    copyPath: vi.fn(),
    linkedFile: vi.fn(),
    download: vi.fn(() => new Promise<FilesResult<FileDownload>>(resolve => { finish = resolve })),
    stopDownload: vi.fn(async () => ({ ok: true as const, value: { stopped: true } })),
    showDownload: vi.fn(async () => ({ ok: true as const, value: {} })),
    openDownload: vi.fn(async () => ({ ok: true as const, value: { did: 'opened' as const } })),
    onDownloadProgress: vi.fn((listener: (event: FileDownloadProgress) => void) => { progress = listener; return () => undefined }),
    ...overrides,
  } satisfies FilesBridge
  return { bridge, progress: (event: FileDownloadProgress) => act(() => progress?.(event)), finish: (result: FilesResult<FileDownload>) => act(async () => { finish(result); await Promise.resolve() }) }
}
const saved = { ok: true as const, value: { downloadId: 'b'.repeat(32), name: 'q3-report (1).pdf', size: 100 } }

beforeEach(() => { (window as { sotto?: unknown }).sotto = { platform: 'win32' } })
afterEach(() => { cleanup(); delete (window as { sotto?: unknown }).sotto })

describe('a press on a link to a file on a paired host (ADR-0120, November 12 amendment)', () => {
  const place = (inside: string | null, kind: 'file' | 'directory' = 'file') => ({ ok: true as const, value: { is: 'place' as const, name: 'x', kind, size: 3, inside: inside === null ? null : { workspace, path: inside } } })
  const routed = (answer: unknown, route?: Parameters<typeof threadLinkRouter>[6]) => {
    const host = hostBridge({ linkedFile: vi.fn(async () => answer) as never })
    ;(window as { sotto?: unknown }).sotto = { platform: 'win32', files: host.bridge }
    const store = new ToolsPanelStore()
    return { ...host, store, router: threadLinkRouter('host:thread', 'Reports', undefined, store, true, undefined, route, true) }
  }

  it('opens Tools on Files with the file selected in the tree, its folders open, when it is in the thread\'s folder', async () => {
    const { router, store, bridge } = routed(place('out/q3-report.pdf'))
    expect(router.fileOnHost?.('/home/zach/Projects/reports/out/q3-report.pdf')).toBe(true)
    // A linked file shown alone before it gives way to the tree.
    store.showLinkedFile('host:thread', '/home/zach/exports/sales.csv')
    await expect(router.showHostFile?.('/home/zach/Projects/reports/out/q3-report.pdf')).resolves.toEqual({ ok: true })
    expect(bridge.linkedFile).toHaveBeenCalledWith({ threadId: 'host:thread', path: '/home/zach/Projects/reports/out/q3-report.pdf', want: 'place' })
    expect(store.getSnapshot()).toMatchObject({ open: true, surface: 'files' })
    expect(store.linkedFile('host:thread')).toBeNull()
    await waitFor(() => expect(store.files.thread('host:thread')?.preview?.status).toBe('error'))
    const files = store.files.thread('host:thread')!
    expect(files.selectedPath).toBe('out/q3-report.pdf')
    expect(visibleRows(files).filter(row => row.kind === 'entry').map(row => row.entry!.path)).toEqual(['out', 'out/figures', 'out/q3-report.pdf', 'notes.md'])
    expect(bridge.download).not.toHaveBeenCalled()
  })

  it('opens a folder in the tree and takes its focus there, and downloads no folder', async () => {
    const { router, store, bridge } = routed(place('out/figures', 'directory'))
    await expect(router.showHostFile?.('out/figures', true)).resolves.toEqual({ ok: true, message: 'A folder is not downloaded. It is open in Files, where each file can be.' })
    await waitFor(() => expect(visibleRows(store.files.thread('host:thread')!).some(row => row.entry?.path === 'out/figures/revenue.png')).toBe(true))
    expect(store.files.thread('host:thread')).toMatchObject({ focusedPath: 'out/figures', selectedPath: null })
    expect(bridge.download).not.toHaveBeenCalled()
  })

  it('shows a file outside the thread\'s folder alone, and a folder there not at all', async () => {
    const outside = routed(place(null))
    await expect(outside.router.showHostFile?.('/home/zach/exports/sales.csv')).resolves.toEqual({ ok: true })
    expect(outside.store.getSnapshot()).toMatchObject({ open: true, surface: 'files' })
    expect(outside.store.linkedFile('host:thread')).toMatchObject({ threadId: 'host:thread', path: '/home/zach/exports/sales.csv' })
    expect(outside.bridge.list).not.toHaveBeenCalled()
    const folder = routed(place(null, 'directory'))
    await expect(folder.router.showHostFile?.('/home/zach/exports')).resolves.toEqual({ ok: false, message: 'This folder is on another computer, outside what Files shows here. Nothing was opened. Copy its path from the link’s menu instead.' })
    expect(folder.store.getSnapshot().open).toBe(false)
  })

  it('downloads from the link\'s menu under the name the panel that shows the file knows it by', async () => {
    const inTree = routed(place('out/q3-report.pdf'))
    await inTree.router.showHostFile?.('/home/zach/Projects/reports/out/q3-report.pdf', true)
    expect(inTree.bridge.download).toHaveBeenCalledWith({ threadId: 'host:thread', path: 'out/q3-report.pdf' })
    const alone = routed(place(null))
    await alone.router.showHostFile?.('/home/zach/exports/sales.csv', true)
    expect(alone.bridge.download).toHaveBeenCalledWith({ threadId: 'host:thread', path: '/home/zach/exports/sales.csv' })
  })

  it('shows a worker\'s file alone in Watcher\'s room, read on the worker\'s own machine', async () => {
    const open = vi.fn()
    const route = { open, readerOf: () => 'host:worker', onPairedHost: (threadId: string) => threadId === 'host:worker' }
    const host = hostBridge({ linkedFile: vi.fn(async () => place('out/q3-report.pdf')) as never })
    ;(window as { sotto?: unknown }).sotto = { platform: 'win32', files: host.bridge }
    const store = new ToolsPanelStore()
    // Watcher runs on this computer; the file its reply names is in a worker's folder on a paired host.
    const router = threadLinkRouter('watcher', 'Watcher', undefined, store, true, undefined, route, false)
    expect(router.fileOnHost?.('/home/zach/Projects/reports/out/q3-report.pdf')).toBe(true)
    await expect(router.showHostFile?.('/home/zach/Projects/reports/out/q3-report.pdf')).resolves.toEqual({ ok: true })
    expect(host.bridge.linkedFile).toHaveBeenCalledWith({ threadId: 'host:worker', path: '/home/zach/Projects/reports/out/q3-report.pdf', want: 'place' })
    expect(open).toHaveBeenCalledWith('host:worker', '/home/zach/Projects/reports/out/q3-report.pdf')
    expect(store.getSnapshot().open).toBe(false)
  })

  it('opens a file on this computer in its own app, and says when main showed a program instead', async () => {
    const openLink = vi.fn(async () => ({ ok: true as const, value: { did: 'shown' as const } }))
    ;(window as { sotto?: unknown }).sotto = { platform: 'win32', files: { openLink } }
    const router = threadLinkRouter('thread', 'Reports', undefined, new ToolsPanelStore())
    expect(router.fileOnHost?.('D:/Reports/setup.exe')).toBe(false)
    await expect(router.openInApp?.('D:/Reports/setup.exe')).resolves.toEqual({ ok: true, shown: true })
    expect(openLink).toHaveBeenCalledWith({ threadId: 'thread', path: 'D:/Reports/setup.exe' })
  })
})

describe('a file on a paired host shown alone, with Download', () => {
  const file = { threadId: 'host:alone', path: '/home/zach/exports/sales.csv:4', revision: 1 }

  it('previews any file as Files does, says its whole path, and saves it to this computer from its head', async () => {
    const user = userEvent.setup()
    const host = hostBridge({ linkedFile: vi.fn(async () => ({ ok: true as const, value: { is: 'preview' as const, name: 'sales.csv', size: 18, content: { kind: 'text' as const, text: 'month,revenue' } } })) })
    render(<LinkedFilePanel file={file} host="forge" bridge={host.bridge} onClose={() => undefined} />)
    expect(await screen.findByText('month,revenue')).toBeInTheDocument()
    expect(host.bridge.linkedFile).toHaveBeenCalledWith({ threadId: 'host:alone', path: '/home/zach/exports/sales.csv:4', want: 'preview' })
    expect(screen.getByText('18 B · Read only · on forge')).toBeInTheDocument()
    expect(screen.getByText('/home/zach/exports/sales.csv')).toHaveClass('linked-file__path')
    // Nothing of a download shows until it is asked for.
    expect(screen.queryByText(/Downloading/u)).toBeNull()
    const download = screen.getByRole('button', { name: 'Download sales.csv to this computer' })
    await user.click(download)
    expect(host.bridge.download).toHaveBeenCalledWith({ threadId: 'host:alone', path: '/home/zach/exports/sales.csv:4' })
    expect(screen.getByText('Downloading from forge… 0%')).toBeInTheDocument()
    // A second press starts no second download.
    await user.click(download)
    expect(host.bridge.download).toHaveBeenCalledOnce()
    host.progress({ threadId: 'host:alone', path: '/home/zach/exports/sales.csv:4', received: 36, size: 100 })
    expect(screen.getByText('Downloading from forge… 36%')).toBeInTheDocument()
    await host.finish(saved)
    expect(screen.getByText('Saved q3-report (1).pdf to Downloads on this computer.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Show in File Explorer' }))
    expect(host.bridge.showDownload).toHaveBeenCalledWith({ downloadId: 'b'.repeat(32) })
    await user.click(screen.getByRole('button', { name: 'Open' }))
    expect(host.bridge.openDownload).toHaveBeenCalledWith({ downloadId: 'b'.repeat(32) })
  })

  it('says a file has no preview without calling it a failure, and still offers Download', async () => {
    const host = hostBridge({ linkedFile: vi.fn(async () => ({ ok: false as const, error: { code: 'binary' as const, message: 'English from the host' } })) })
    render(<LinkedFilePanel file={{ ...file, threadId: 'host:binary', path: '/home/zach/exports/report.pdf' }} host="forge" bridge={host.bridge} onClose={() => undefined} />)
    expect(await screen.findByText('No preview for this file.')).toBeInTheDocument()
    expect(screen.getByText('Text, Markdown and PNG, JPEG, GIF or WebP images preview here. Download it to open it on this computer.')).toBeInTheDocument()
    expect(screen.queryByText('English from the host')).toBeNull()
    expect(screen.getByRole('button', { name: 'Download report.pdf to this computer' })).toBeInTheDocument()
  })

  it('offers Download on a Markdown file on a host too, and on no file on this computer', async () => {
    const markdown = vi.fn(async () => ({ ok: true as const, value: { name: 'plan.md', size: 6, text: '# Plan' } }))
    const host = hostBridge({ previewLink: markdown })
    const { unmount } = render(<LinkedFilePanel file={{ threadId: 'host:md', path: 'docs/plan.md', revision: 1 }} host="forge" bridge={host.bridge} onClose={() => undefined} />)
    expect(await screen.findByRole('heading', { name: 'Plan' })).toBeInTheDocument()
    expect(host.bridge.linkedFile).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Download plan.md to this computer' })).toBeInTheDocument()
    expect(document.querySelector('.linked-file__path')).toBeNull()
    unmount()
    const local = render(<LinkedFilePanel file={{ threadId: 'local', path: 'docs/plan.md', revision: 1 }} bridge={host.bridge} onClose={() => undefined} />)
    await screen.findByRole('heading', { name: 'Plan' })
    expect(screen.queryByRole('button', { name: /Download/u })).toBeNull()
    local.unmount()
    // Stable has the bridge too, and main would refuse the press, so the control is not drawn there at all.
    owl.on = false
    try {
      render(<LinkedFilePanel file={{ threadId: 'host:md', path: 'docs/plan.md', revision: 1 }} host="forge" bridge={host.bridge} onClose={() => undefined} />)
      await screen.findByRole('heading', { name: 'Plan' })
      expect(screen.queryByRole('button', { name: /Download/u })).toBeNull()
    } finally { owl.on = true }
  })
})

describe('a download\'s line', () => {
  const line = (host: ReturnType<typeof hostBridge>, store: FileDownloadsStore) => render(<FileDownloadLine bridge={host.bridge} host="forge" threadId="host:thread" path="out/q3-report.pdf" platform="darwin" store={store} />)

  it('stops on a press and says nothing was saved, whatever main answers afterwards', async () => {
    const user = userEvent.setup()
    const host = hostBridge(), store = new FileDownloadsStore()
    const { container } = line(host, store)
    expect(container).toBeEmptyDOMElement()
    await act(async () => { store.start(host.bridge, 'host:thread', 'out/q3-report.pdf') })
    // Progress for another file is not this one's.
    host.progress({ threadId: 'host:thread', path: 'out/other.pdf', received: 90, size: 100 })
    expect(screen.getByText('Downloading from forge… 0%')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Stop' }))
    expect(host.bridge.stopDownload).toHaveBeenCalledWith({ threadId: 'host:thread', path: 'out/q3-report.pdf' })
    await host.finish({ ok: false, error: { code: 'unavailable', message: 'Download stopped. Nothing was saved.' } })
    expect(screen.getByText('Download stopped. Nothing was saved.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(container).toBeEmptyDOMElement()
  })

  it('says the file was saved when main had saved it before the stop reached it', async () => {
    const user = userEvent.setup()
    const host = hostBridge(), store = new FileDownloadsStore()
    line(host, store)
    await act(async () => { store.start(host.bridge, 'host:thread', 'out/q3-report.pdf') })
    await user.click(screen.getByRole('button', { name: 'Stop' }))
    expect(screen.getByText('Download stopped. Nothing was saved.')).toBeInTheDocument()
    await host.finish(saved)
    expect(screen.getByText('Saved q3-report (1).pdf to Downloads on this computer.')).toBeInTheDocument()
  })

  it('says why nothing was saved in main\'s words, and what a saved program\'s Open did', async () => {
    const user = userEvent.setup()
    const host = hostBridge({ openDownload: vi.fn(async () => ({ ok: true as const, value: { did: 'shown' as const } })) }), store = new FileDownloadsStore()
    line(host, store)
    await act(async () => { store.start(host.bridge, 'host:thread', 'out/q3-report.pdf') })
    await host.finish({ ok: false, error: { code: 'path-unavailable', message: 'This file changed while it was being downloaded. Nothing was saved.' } })
    expect(screen.getByText('This file changed while it was being downloaded. Nothing was saved.')).toBeInTheDocument()
    await act(async () => { store.start(host.bridge, 'host:thread', 'out/q3-report.pdf') })
    await host.finish({ ok: true, value: { downloadId: 'c'.repeat(32), name: 'setup.exe', size: 9 } })
    expect(screen.getByRole('button', { name: 'Show in Finder' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Open' }))
    expect(await screen.findByText('setup.exe is a program or script, so it was shown in its folder. Nothing was run.')).toBeInTheDocument()
  })
})

describe('what Files may ask of a paired host', () => {
  it('passes a download and a linked file\'s reads through, and still no reveal', () => {
    const { bridge } = hostBridge({ reveal: vi.fn(), revealLink: vi.fn(), openLink: vi.fn() })
    expect(Object.keys(hostThreadFiles(bridge)).sort()).toEqual(['copyPath', 'download', 'linkedFile', 'list', 'onDownloadProgress', 'openDownload', 'preview', 'showDownload', 'stopDownload'])
    expect(Object.keys(hostThreadFiles({ list: vi.fn(), preview: vi.fn(), copyPath: vi.fn(), reveal: vi.fn() })).sort()).toEqual(['copyPath', 'list', 'preview'])
  })

  it('opens a folder and the folders above it in the tree', async () => {
    const { bridge } = hostBridge(), store = new FilesBrowserStore()
    store.showFolder(bridge, 'host:thread', 'out/figures')
    await waitFor(() => expect(visibleRows(store.thread('host:thread')!).filter(row => row.kind === 'entry').map(row => row.entry!.path)).toEqual(['out', 'out/figures', 'out/figures/revenue.png', 'out/q3-report.pdf', 'notes.md']))
    expect(store.thread('host:thread')?.focusedPath).toBe('out/figures')
  })
})
