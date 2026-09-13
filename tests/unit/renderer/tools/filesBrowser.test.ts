import { describe, expect, it, vi } from 'vitest'
import type { FilesBridge, FilesResult, FilePreview } from '../../../../src/shared/files'
import { FilesBrowserStore, sortEntries, visibleRows } from '../../../../src/renderer/src/tools/filesBrowser'
import { TOKEN_A, TOKEN_B, fakeFilesBridge, text, type FakeFolders } from './fakeFilesBridge'

const settle = () => new Promise(resolve => setTimeout(resolve, 0))

function workshop(token = TOKEN_A): FakeFolders[string] {
  return { root: 'D:/work/workshop', token, tree: {
    src: { kind: 'directory' as const }, 'src/app.ts': { kind: 'file' as const, content: text('export {}') },
    'README.md': { kind: 'file' as const, content: text('# Workshop') }, 'b.txt': { kind: 'file' as const, content: text('b') },
  } }
}

describe('Files browsing model', () => {
  it('lists the root without a token and sends the returned workspace ID with every later request', async () => {
    const folders: FakeFolders = { t1: workshop() }
    const bridge = fakeFilesBridge(folders)
    const store = new FilesBrowserStore()
    store.activate(bridge, 't1')
    await settle()
    expect(bridge.list).toHaveBeenCalledWith({ threadId: 't1', path: '' })
    store.toggleDirectory(bridge, 't1', 'src')
    await settle()
    expect(bridge.list).toHaveBeenLastCalledWith({ threadId: 't1', path: 'src', workspaceId: TOKEN_A })
    store.openFile(bridge, 't1', 'src/app.ts')
    await settle()
    expect(bridge.preview).toHaveBeenCalledWith({ threadId: 't1', path: 'src/app.ts', workspaceId: TOKEN_A })
    const files = store.thread('t1')!
    expect(files.workspace?.workingDirectory).toBe('D:/work/workshop')
    expect(files.preview).toMatchObject({ status: 'ready', path: 'src/app.ts' })
    expect(visibleRows(files).map(row => row.entry?.path ?? row.kind)).toEqual(['src', 'src/app.ts', 'b.txt', 'README.md'])
  })

  it('clears the tree, selection and preview when the working folder changes, and never retries the stale path', async () => {
    const folders: FakeFolders = { t1: workshop() }
    const bridge = fakeFilesBridge(folders)
    const store = new FilesBrowserStore()
    store.activate(bridge, 't1')
    await settle()
    store.toggleDirectory(bridge, 't1', 'src')
    store.openFile(bridge, 't1', 'README.md')
    await settle()
    folders.t1 = { ...workshop(TOKEN_B), root: 'D:/work/worktree-2', tree: { 'other.md': { kind: 'file', content: text('new') } } }
    vi.mocked(bridge.preview).mockClear()
    vi.mocked(bridge.list).mockClear()
    store.openFile(bridge, 't1', 'src/app.ts')
    await settle()
    await settle()
    const files = store.thread('t1')!
    expect(bridge.preview).toHaveBeenCalledTimes(1)
    expect(bridge.list).toHaveBeenCalledWith({ threadId: 't1', path: '' })
    expect(vi.mocked(bridge.list).mock.calls.some(([request]) => request.path !== '')).toBe(false)
    expect(files).toMatchObject({ selectedPath: null, preview: null, workspaceChanged: true })
    expect(files.expanded.size).toBe(0)
    expect(files.workspace).toMatchObject({ workingDirectory: 'D:/work/worktree-2', workspaceId: TOKEN_B })
    expect(visibleRows(files).map(row => row.entry?.path)).toEqual(['other.md'])
  })

  it('detects a replaced folder when a retained thread is shown again', async () => {
    const folders: FakeFolders = { t1: workshop() }
    const bridge = fakeFilesBridge(folders)
    const store = new FilesBrowserStore()
    store.activate(bridge, 't1')
    await settle()
    store.openFile(bridge, 't1', 'README.md')
    await settle()
    folders.t1 = workshop(TOKEN_B)
    store.activate(bridge, 't1')
    await settle()
    expect(store.thread('t1')).toMatchObject({ selectedPath: null, workspaceChanged: true, workspace: { workspaceId: TOKEN_B } })
    expect(bridge.preview).toHaveBeenCalledTimes(1)
  })

  it('keeps each thread’s open folders and selection while another thread is shown', async () => {
    const bridge = fakeFilesBridge({ t1: workshop(), t2: { ...workshop(TOKEN_B), root: 'D:/work/docs' } })
    const store = new FilesBrowserStore()
    store.activate(bridge, 't1')
    await settle()
    store.toggleDirectory(bridge, 't1', 'src')
    store.openFile(bridge, 't1', 'src/app.ts')
    store.setScroll('t1', 'tree', 120)
    await settle()
    store.activate(bridge, 't2')
    await settle()
    store.activate(bridge, 't1')
    const retained = store.thread('t1')!
    expect(retained.expanded.has('src')).toBe(true)
    expect(retained.selectedPath).toBe('src/app.ts')
    expect(retained.preview?.status).toBe('ready')
    expect(store.scrollOf('t1').tree).toBe(120)
    expect(store.thread('t2')!.expanded.size).toBe(0)
    await settle()
    expect(store.thread('t1')!.preview?.status).toBe('ready')
  })

  it('drops a late reply from before the folder changed', async () => {
    let releaseOld!: (value: FilesResult<FilePreview>) => void
    const base = fakeFilesBridge({ t1: workshop() })
    const bridge: FilesBridge = { ...base, preview: vi.fn(() => new Promise<FilesResult<FilePreview>>(done => { releaseOld = done })) }
    const store = new FilesBrowserStore()
    store.activate(bridge, 't1')
    await settle()
    store.openFile(bridge, 't1', 'README.md')
    // The folder is replaced (reset through a changed listing) before the preview answers.
    vi.mocked(base.list).mockImplementationOnce(async request => ({ ok: true, value: { workspace: { threadId: 't1', projectId: 'workshop', workingDirectory: 'D:/new', workspaceId: TOKEN_B }, path: request.path, entries: [], truncated: false } }))
    await store.refresh(bridge, 't1')
    releaseOld({ ok: true, value: { workspace: { threadId: 't1', projectId: 'workshop', workingDirectory: 'D:/work/workshop', workspaceId: TOKEN_A }, path: 'README.md', name: 'README.md', size: 3, content: text('old') } })
    await settle()
    expect(store.thread('t1')).toMatchObject({ preview: null, selectedPath: null, workspace: { workingDirectory: 'D:/new' } })
  })

  it('explains missing, unreadable, empty and truncated folders as rows', async () => {
    const bridge = fakeFilesBridge({ t1: { root: 'D:/w', token: TOKEN_A, tree: {
      gone: { kind: 'fail', error: 'path-unavailable' }, empty: { kind: 'directory' }, many: { kind: 'directory' }, 'many/a.txt': { kind: 'file', content: text('a') },
      locked: { kind: 'fail', error: 'unavailable' }, 'link': { kind: 'unavailable' },
    } } })
    const store = new FilesBrowserStore()
    store.activate(bridge, 't1')
    await settle()
    for (const path of ['gone', 'empty', 'many', 'locked']) store.toggleDirectory(bridge, 't1', path)
    await settle()
    const rows = visibleRows(store.thread('t1')!)
    expect(rows.map(row => row.kind === 'entry' ? row.entry!.path : `${row.parent}:${row.kind}${row.error ? `:${row.error.code}` : ''}`)).toEqual([
      'empty', 'empty:empty', 'gone', 'gone:error:path-unavailable', 'locked', 'locked:error:unavailable', 'many', 'many/a.txt', 'many:truncated', 'link',
    ])
  })

  it('reports a missing bridge as a root problem instead of throwing', async () => {
    const store = new FilesBrowserStore()
    store.activate(undefined, 't1')
    await settle()
    expect(store.thread('t1')!.listings.get('')).toMatchObject({ status: 'error', error: { code: 'unavailable' } })
    await expect(store.pathAction(undefined, 't1', 'copyPath', '')).resolves.toMatchObject({ ok: false })
  })

  it('leaves Git’s administrative .git entry out of the working copy tree, as a folder or a worktree file', async () => {
    const folders: FakeFolders = { t1: { root: 'D:/work/checkout', token: TOKEN_A, tree: {
      '.git': { kind: 'file', content: text('gitdir: D:/repo/.git/worktrees/t1') }, '.gitignore': { kind: 'file', content: text('out') },
      pkg: { kind: 'directory' }, 'pkg/.GIT': { kind: 'directory' }, 'pkg/index.ts': { kind: 'file', content: text('export {}') },
      only: { kind: 'directory' }, 'only/.git': { kind: 'directory' },
    } } }
    const bridge = fakeFilesBridge(folders)
    const store = new FilesBrowserStore()
    store.activate(bridge, 't1')
    await settle()
    store.toggleDirectory(bridge, 't1', 'pkg')
    store.toggleDirectory(bridge, 't1', 'only')
    await settle()
    const rows = visibleRows(store.thread('t1')!)
    expect(rows.map(row => row.entry?.path ?? `${row.parent}:${row.kind}`)).toEqual(['only', 'only:empty', 'pkg', 'pkg/index.ts', '.gitignore'])
    expect(rows.filter(row => row.depth === 0 && row.kind === 'entry').map(row => [row.position, row.setSize])).toEqual([[1, 3], [2, 3], [3, 3]])
  })

  it('sorts folders before files with natural name order', () => {
    expect(sortEntries([
      { name: 'file10.txt', path: 'file10.txt', kind: 'file' }, { name: 'zeta', path: 'zeta', kind: 'directory' },
      { name: 'file2.txt', path: 'file2.txt', kind: 'file' }, { name: 'Alpha', path: 'Alpha', kind: 'directory' },
    ]).map(entry => entry.name)).toEqual(['Alpha', 'zeta', 'file2.txt', 'file10.txt'])
  })
})
