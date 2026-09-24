import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Checkpoint } from '../../../../src/shared/checkpoints'
import type { GitChange, GitChangesBridge, GitReview, GitReviewFile } from '../../../../src/shared/gitChanges'
import type { GitRef } from '../../../../src/shared/gitRefs'
import type { ToolsResult } from '../../../../src/shared/tools'
import { ToolsPanel } from '../../../../src/renderer/src/tools/ToolsPanel'
import { ChangesStore, parseUnifiedDiff } from '../../../../src/renderer/src/tools/changesStore'
import { baseChoices } from '../../../../src/renderer/src/tools/ChangesBasePicker'
import { inWorkingCopy } from '../../../../src/renderer/src/tools/ChangesSurface'
import { changesChord } from '../../../../src/renderer/src/tools/changesShortcut'
import { ToolsPanelStore } from '../../../../src/renderer/src/tools/toolsPanelStore'
import { useOptionalApp, type AppContextValue } from '../../../../src/renderer/src/state/AppContext'
import { DEFAULT_SETTINGS } from '../../../../src/shared/settings'
import { threadsStateFixture } from '../liveAgentState'
import { TOKEN_A, fakeFilesBridge, text } from './fakeFilesBridge'

// Outside the app provider the diff settings are their defaults; a test that needs another says so.
vi.mock('../../../../src/renderer/src/state/AppContext', async importOriginal => ({
  ...await importOriginal<typeof import('../../../../src/renderer/src/state/AppContext')>(),
  useOptionalApp: vi.fn(() => null),
}))

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.mocked(useOptionalApp).mockReturnValue(null) })

const PATCH = 'diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -3,3 +3,3 @@ export\n keep\n-export const ready = false\n+export const ready = true\n tail\n'
const workspace = { threadId: 'visual-gate', projectId: 'workshop', workingDirectory: 'D:\\work\\workshop', workspaceId: TOKEN_A }
const reviewFile = (path: string, status: GitReviewFile['status'], content: GitReviewFile['content'], additions: number | null = 1, deletions: number | null = 1): GitReviewFile => ({ path, status, additions, deletions, content })
const WORKING: GitReviewFile[] = [
  reviewFile('docs/new.md', 'untracked', { kind: 'text', patch: 'diff --git a/docs/new.md b/docs/new.md\nnew file mode 100644\n--- /dev/null\n+++ b/docs/new.md\n@@ -0,0 +1 @@\n+# New\n' }, 1, 0),
  reviewFile('logo.png', 'modified', { kind: 'binary', message: 'Binary file: no text diff.' }, null, null),
  reviewFile('src/app.ts', 'modified', { kind: 'text', patch: PATCH }),
]
const checkpoint = (id: string, status: Checkpoint['status'], reason?: string): Checkpoint => ({ id, threadId: 'visual-gate', createdAt: '2026-09-23T10:00:00.000Z', status, files: [{ path: 'src/app.ts', change: 'modified' }], supported: true, ...(reason ? { reason } : {}) })
const TURN_ONE = '11111111-1111-4111-8111-111111111111', TURN_TWO = '22222222-2222-4222-8222-222222222222'

function fakeGit(options: { files?: GitReviewFile[]; listError?: 'not-repository'; truncated?: boolean; checkpoints?: Checkpoint[] } = {}) {
  let reviewFiles = options.files ?? WORKING
  let revision = 'r1'
  const listed = (): GitChange[] => reviewFiles.map(file => ({ path: file.path, status: file.status }))
  const listeners = new Set<(event: { threadId: string; workspaceId: string; revision: string }) => void>()
  const bridge: GitChangesBridge = {
    list: vi.fn(async (): Promise<ToolsResult<never>> => options.listError
      ? { ok: false, error: { code: options.listError, message: 'no repo' } }
      : { ok: true, value: { workspace, branch: 'feature/changes', revision, files: listed(), truncated: options.truncated ?? false } as never }),
    review: vi.fn(async ({ scope }): Promise<ToolsResult<GitReview>> => scope.kind === 'working'
      ? { ok: true, value: { workspace, revision, scope: { kind: 'working' }, files: reviewFiles, truncated: false } }
      : { ok: true, value: { workspace, revision, scope: { kind: 'branch', base: scope.base ?? 'origin/main', automatic: scope.base === null, head: 'feature/changes' }, files: [reviewFile('src/trail.ts', 'added', { kind: 'text', patch: 'diff --git a/src/trail.ts b/src/trail.ts\n--- /dev/null\n+++ b/src/trail.ts\n@@ -0,0 +1 @@\n+trail\n' }, 1, 0)], truncated: false } }),
    copyPath: vi.fn(async ({ path }) => ({ ok: true as const, value: { workspace, path, absolutePath: `D:/work/workshop/${path}` } })),
    reveal: vi.fn(async ({ path }) => ({ ok: true as const, value: { workspace, path, absolutePath: `D:/work/workshop/${path}` } })),
    watch: vi.fn(async () => ({ ok: true as const, value: undefined })),
    onChanged: vi.fn(listener => { listeners.add(listener); return () => { listeners.delete(listener) } }),
    checkpoints: vi.fn(async () => ({ ok: true as const, value: { supported: true, checkpoints: options.checkpoints ?? [] } })),
    inspectCheckpoint: vi.fn(async ({ checkpointId }) => ({ ok: true as const, value: {
      checkpoint: (options.checkpoints ?? []).find(item => item.id === checkpointId)!,
      patches: [{ path: 'src/app.ts', before: 'one\ntwo\nthree\n', after: checkpointId === TURN_TWO ? 'one\n  two\nTHREE\n' : 'one\ndeux\nthree\n', binary: false }],
    } })),
  }
  return {
    bridge, listeners,
    change(next: GitReviewFile[], nextRevision: string) {
      reviewFiles = next; revision = nextRevision
      for (const listener of [...listeners]) listener({ threadId: 'visual-gate', workspaceId: TOKEN_A, revision: nextRevision })
    },
  }
}

function setup(git = fakeGit(), state = threadsStateFixture()) {
  const store = new ToolsPanelStore()
  store.setOpen(true)
  store.setSurface('changes')
  const files = fakeFilesBridge({ 'visual-gate': { root: 'D:\\work\\workshop', token: TOKEN_A, tree: { src: { kind: 'directory' }, 'src/app.ts': { kind: 'file', content: text('export const ready = true') }, 'a.txt': { kind: 'file', content: text('a') } } } })
  render(<ToolsPanel focusedThreadId="visual-gate" state={state} files={files} gitChanges={git.bridge} store={store} />)
  return { store, git, files }
}

const panel = () => screen.getByRole('complementary', { name: 'Tools' })
const block = (path: string) => panel().querySelector<HTMLElement>(`.changes-file[data-file-path="${path}"]`)!

describe('Changes as T3’s diff', () => {
  it('shows the working tree as file blocks with counts, and offers no staging or commit of its own', async () => {
    const git = fakeGit()
    setup(git)
    await within(panel()).findByText('export const ready = true')
    expect(git.bridge.review).toHaveBeenCalledWith({ threadId: 'visual-gate', workspaceId: TOKEN_A, scope: { kind: 'working' }, ignoreWhitespace: false })
    expect(within(panel()).getByRole('combobox', { name: 'Diff scope' })).toHaveValue('working')
    // Header counts are the sum of every file's; a binary file counts nothing.
    expect(panel().querySelector('.changes-summary .changes-counts--chrome')).toHaveTextContent('+2 −1')
    // The same totals wait at the head of the view bar, which CSS shows in a panel too narrow for them on the chrome.
    expect(panel().querySelector('.changes-bar .changes-counts--bar')).toHaveTextContent('+2 −1')
    expect([...panel().querySelectorAll('.changes-file')].map(item => item.getAttribute('data-file-path'))).toEqual(['docs/new.md', 'logo.png', 'src/app.ts'])
    expect(within(block('src/app.ts')).getByRole('img', { name: 'Modified' })).toHaveTextContent('M')
    expect(within(block('logo.png')).getByText('Binary file: no text diff.')).toBeInTheDocument()
    // Staging left the UI (ADR-0027): the commit dialog's file list is the choice.
    for (const name of ['Stage file', 'Unstage file', 'Commit', 'Git actions']) expect(within(panel()).queryByRole('button', { name, exact: true })).toBeNull()
    expect(within(panel()).queryByRole('option', { name: /Staged/u })).toBeNull()
    expect(within(panel()).getByRole('button', { name: 'Checkpoints', exact: true }).closest('.tools-chrome')).toHaveClass('changes-summary')
  })

  it('gives each row its file and line numbers as data for a later selection', async () => {
    setup()
    await within(panel()).findByText('export const ready = true')
    const rows = [...block('src/app.ts').querySelectorAll('.changes-line[data-kind="context"], .changes-line[data-kind="add"], .changes-line[data-kind="remove"]')]
    expect(rows.map(row => [row.getAttribute('data-path'), row.getAttribute('data-old-line'), row.getAttribute('data-new-line'), row.getAttribute('data-kind')])).toEqual([
      ['src/app.ts', '3', '3', 'context'], ['src/app.ts', '4', null, 'remove'], ['src/app.ts', null, '4', 'add'], ['src/app.ts', '5', '5', 'context'],
    ])
  })

  it('collapses one file or all of them, copies a path, and opens a file in Files from its name', async () => {
    const user = userEvent.setup()
    const { git, store, files } = setup()
    await within(panel()).findByText('export const ready = true')
    await user.click(within(block('src/app.ts')).getByRole('button', { name: 'Collapse src/app.ts' }))
    expect(within(panel()).queryByText('export const ready = true')).toBeNull()
    expect(within(block('src/app.ts')).getByRole('button', { name: 'Expand src/app.ts' })).toHaveAttribute('aria-expanded', 'false')
    await user.click(within(panel()).getByRole('button', { name: 'Collapse all files' }))
    expect(panel().querySelectorAll('.changes-file[data-collapsed]')).toHaveLength(3)
    await user.click(within(panel()).getByRole('button', { name: 'Expand all files' }))
    expect(panel().querySelectorAll('.changes-file[data-collapsed]')).toHaveLength(0)
    await user.click(within(block('src/app.ts')).getByRole('button', { name: 'Copy path: src/app.ts' }))
    expect(git.bridge.copyPath).toHaveBeenCalledWith({ threadId: 'visual-gate', workspaceId: TOKEN_A, path: 'src/app.ts' })
    await user.click(within(block('src/app.ts')).getByRole('button', { name: 'Open src/app.ts' }))
    expect(store.getSnapshot().surface).toBe('files')
    await waitFor(() => expect(files.preview).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'visual-gate', path: 'src/app.ts' })))
    expect(await within(panel()).findByText('export const ready = true')).toBeInTheDocument()
  })

  it('draws stacked or split, wraps or not, hides whitespace through Git, and shows a file tree', async () => {
    const user = userEvent.setup()
    const patch = 'diff --git a/src/old.ts b/src/app.ts\nold mode 100644\nnew mode 100755\nsimilarity index 75%\nrename from src/old.ts\nrename to src/app.ts\nindex abc123..def456 100755\n--- a/src/old.ts\n+++ b/src/app.ts\n@@ -10,4 +20,5 @@\n keep\n-old one\n-old two\n+new one\n+new two\n+new three\n tail\n@@ -30 +40 @@\n-old end\n\\ No newline at end of file\n+new end\n'
    const git = fakeGit({ files: [{ ...reviewFile('src/app.ts', 'renamed', { kind: 'text', patch }, 4, 3), originalPath: 'src/old.ts' }] })
    setup(git)
    const file = await waitFor(() => { const found = block('src/app.ts'); expect(found).not.toBeNull(); return found })
    await within(file).findByText('new three')
    expect(within(file).getByText('src/old.ts').closest('.changes-note')).toHaveTextContent('Renamed from src/old.ts')
    // The head names the file and the rename; the rows keep only the mode change Git reported.
    expect([...file.querySelectorAll('.changes-line[data-kind="meta"]')].map(row => row.textContent)).toEqual(['old mode 100644', 'new mode 100755'])
    const split = within(panel()).getByRole('button', { name: 'Split diff view' })
    expect(within(panel()).getByRole('button', { name: 'Stacked diff view' })).toHaveAttribute('aria-pressed', 'true')
    await user.click(split)
    expect(split).toHaveAttribute('aria-pressed', 'true')
    expect(file.querySelector('.changes-split__head')).toHaveTextContent('HEADWorking tree')
    const rows = [...file.querySelectorAll('.changes-split__row')].map(row => [...row.children].map(cell => [
      cell.querySelector('.changes-line__number')!.textContent, cell.querySelector('.changes-line__text')!.textContent?.trim(),
    ]))
    expect(rows).toEqual([
      [['10', 'keep'], ['20', 'keep']],
      [['11', 'Removed: old one'], ['21', 'Added: new one']],
      [['12', 'Removed: old two'], ['22', 'Added: new two']],
      [['', ''], ['23', 'Added: new three']],
      [['13', 'tail'], ['24', 'tail']],
      [['30', 'Removed: old end'], ['', '']],
      [['', ''], ['40', 'Added: new end']],
    ])
    const note = [...file.querySelector('.changes-diff__rows')!.children].findIndex(row => row.getAttribute('data-kind') === 'note')
    expect(file.querySelector('.changes-diff__rows')!.children[note - 1]).toHaveTextContent('old end')
    await user.click(within(panel()).getByRole('button', { name: 'Stacked diff view' }))
    expect(file.querySelector('.changes-split__row')).toBeNull()

    const files = panel().querySelector('.changes-files')!
    expect(files).toHaveAttribute('data-wrap')
    await user.click(within(panel()).getByRole('button', { name: 'Disable line wrapping' }))
    expect(files).not.toHaveAttribute('data-wrap')
    expect(within(panel()).getByRole('button', { name: 'Enable line wrapping' })).toBeInTheDocument()

    await user.click(within(panel()).getByRole('button', { name: 'Hide whitespace changes' }))
    await waitFor(() => expect(git.bridge.review).toHaveBeenLastCalledWith(expect.objectContaining({ ignoreWhitespace: true })))
    expect(await within(panel()).findByRole('button', { name: 'Show whitespace changes' })).toBeInTheDocument()

    await user.click(within(panel()).getByRole('button', { name: 'Show file tree' }))
    const tree = within(panel()).getByRole('listbox', { name: 'Files in this comparison' })
    expect(within(tree).getByRole('option', { name: 'app.ts, Renamed, in src/' })).toBeInTheDocument()
  })

  it('compares the branch against the automatic base or one picked from Branch and Remote', async () => {
    const user = userEvent.setup()
    const git = fakeGit()
    const refs: GitRef[] = [
      { name: 'main', current: false, isDefault: true, worktreePath: null },
      { name: 'origin/main', remote: 'origin', current: false, isDefault: true, worktreePath: null },
      { name: 'origin/feature/far', remote: 'origin', current: false, isDefault: false, worktreePath: null },
    ]
    const read = vi.fn(async () => ({ refs, isRepository: true, hasRemote: true, nextCursor: null, total: refs.length }))
    Object.assign(window, { sotto: { agents: { gitRefs: read } } })
    try {
      setup(git)
      await within(panel()).findByText('export const ready = true')
      await user.selectOptions(within(panel()).getByRole('combobox', { name: 'Diff scope' }), 'branch')
      await within(panel()).findByText('trail')
      expect(git.bridge.review).toHaveBeenLastCalledWith(expect.objectContaining({ scope: { kind: 'branch', base: null } }))
      const trigger = within(panel()).getByRole('button', { name: 'Change the base. Comparing feature/changes with origin/main, chosen automatically' })
      await user.click(trigger)
      const dialog = within(panel()).getByRole('dialog', { name: 'Base to compare with' })
      expect(read).toHaveBeenCalledWith({ threadId: 'visual-gate', includeMatchingRemoteRefs: true, limit: 200 })
      expect(within(dialog).getByRole('searchbox', { name: 'Search refs' })).toHaveFocus()
      expect(await within(dialog).findByRole('button', { name: 'main' })).toBeInTheDocument()
      expect(within(dialog).getByRole('button', { name: 'Automatic' })).toHaveAttribute('aria-current', 'true')
      expect(within(dialog).getByRole('switch', { name: 'Use remote version of main' })).toHaveAttribute('aria-checked', 'false')
      expect(within(within(dialog).getByRole('button', { name: 'feature/far' }).closest('li')!).getByRole('img', { name: 'Remote only' })).toBeInTheDocument()
      await user.click(within(dialog).getByRole('switch', { name: 'Use remote version of main' }))
      await waitFor(() => expect(git.bridge.review).toHaveBeenLastCalledWith(expect.objectContaining({ scope: { kind: 'branch', base: 'origin/main' } })))
      await user.click(within(dialog).getByRole('button', { name: 'feature/far' }))
      await waitFor(() => expect(git.bridge.review).toHaveBeenLastCalledWith(expect.objectContaining({ scope: { kind: 'branch', base: 'origin/feature/far' } })))
      expect(within(panel()).queryByRole('dialog')).toBeNull()
      expect(within(panel()).getByRole('button', { name: /^Change the base\. Comparing feature\/changes with origin\/feature\/far$/u })).toHaveFocus()
      await user.click(within(panel()).getByRole('button', { name: /^Change the base/u }))
      await user.keyboard('{Escape}')
      expect(within(panel()).queryByRole('dialog')).toBeNull()
      expect(panel()).toBeInTheDocument()
    } finally { Object.assign(window, { sotto: undefined }) }
  })

  it('reads Latest turn and Turn N from checkpoints, and says when a turn’s checkpoint is unavailable', async () => {
    const user = userEvent.setup()
    const git = fakeGit({ checkpoints: [checkpoint(TURN_TWO, 'ready'), checkpoint(TURN_ONE, 'ready')] })
    setup(git)
    await within(panel()).findByText('export const ready = true')
    const scope = within(panel()).getByRole('combobox', { name: 'Diff scope' })
    expect(within(scope).getAllByRole('option').map(option => option.textContent)).toEqual(['Working tree', 'Branch changes', 'Latest turn', 'Turn 2', 'Turn 1'])
    await user.selectOptions(scope, 'latest')
    expect(await within(panel()).findByText('THREE')).toBeInTheDocument()
    expect(git.bridge.inspectCheckpoint).toHaveBeenLastCalledWith({ threadId: 'visual-gate', workspaceId: TOKEN_A, checkpointId: TURN_TWO })
    expect(block('src/app.ts').querySelector('.changes-counts')).toHaveTextContent('+2 −2')
    await user.click(within(panel()).getByRole('button', { name: 'Hide whitespace changes' }))
    await waitFor(() => expect(block('src/app.ts').querySelector('.changes-counts')).toHaveTextContent('+1 −1'))
    await user.click(within(panel()).getByRole('button', { name: 'Show whitespace changes' }))
    await user.selectOptions(scope, `turn:${TURN_ONE}`)
    expect(await within(panel()).findByText('deux')).toBeInTheDocument()
    expect(git.bridge.review).not.toHaveBeenCalledWith(expect.objectContaining({ scope: expect.objectContaining({ kind: 'turn' }) }))
    cleanup()

    setup(fakeGit({ checkpoints: [checkpoint(TURN_ONE, 'unavailable', 'This turn changed Git history or staging. Review and restore it with Git.')] }))
    await within(panel()).findByText('export const ready = true')
    await user.selectOptions(within(panel()).getByRole('combobox', { name: 'Diff scope' }), 'latest')
    expect(await within(panel()).findByText('Turn 1’s checkpoint is unavailable, so its changes cannot be shown. This turn changed Git history or staging. Review and restore it with Git.')).toBeInTheDocument()
    cleanup()

    setup(fakeGit())
    await within(panel()).findByText('export const ready = true')
    await user.selectOptions(within(panel()).getByRole('combobox', { name: 'Diff scope' }), 'latest')
    expect(await within(panel()).findByText('No completed turns yet.')).toBeInTheDocument()
  })

  it('refreshes on a new revision without dropping what is shown, and explains a folder outside Git', async () => {
    const { git, store } = setup()
    await within(panel()).findByText('export const ready = true')
    act(() => git.change([reviewFile('src/app.ts', 'modified', { kind: 'text', patch: 'diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+refreshed\n' })], 'r2'))
    // While the refreshed comparison loads, the reader keeps the lines already on screen.
    expect(within(panel()).getByText('export const ready = true')).toBeInTheDocument()
    expect(await within(panel()).findByText('refreshed')).toBeInTheDocument()
    expect(panel().querySelectorAll('.changes-file')).toHaveLength(1)
    await userEvent.click(within(panel()).getByRole('button', { name: 'Refresh diff' }))
    expect(git.bridge.review).toHaveBeenCalledTimes(3)

    act(() => store.setSurface('files'))
    expect(git.bridge.watch).toHaveBeenLastCalledWith({ threadId: 'visual-gate', workspaceId: TOKEN_A, enabled: false })
    expect(git.listeners.size).toBe(0)
    cleanup()

    setup(fakeGit({ listError: 'not-repository' }))
    expect(await within(panel()).findByText('This working folder is not a Git repository.')).toBeInTheDocument()
    expect(within(panel()).queryByRole('button', { name: 'Try again' })).toBeNull()
  })

  it('says the working copy matches HEAD, and a cut-off list is at least its count in the Changes description', async () => {
    setup(fakeGit({ files: [] }))
    expect(await within(panel()).findByText('The working copy matches HEAD.')).toBeInTheDocument()
    cleanup()
    setup(fakeGit({ truncated: true }))
    await within(panel()).findByText('export const ready = true')
    expect(within(panel()).getByRole('tab', { name: 'Changes', exact: true })).toHaveAccessibleDescription('3+ changed files')
  })

  it('lets the working copy’s dirty mark, not the last count, light the Changes dot once another surface is open', async () => {
    const withWorktree = (dirty: boolean) => {
      const state = threadsStateFixture()
      const thread = state.host.threads.find(item => item.id === 'visual-gate')!
      Object.assign(thread, { worktree: { mode: 'shared', status: 'ready', path: 'D:\\work\\workshop', repositoryRoot: 'D:\\work\\workshop', branch: 'feature/changes', dirty } })
      return state
    }
    const git = fakeGit({ files: [] })
    const store = new ToolsPanelStore()
    store.setOpen(true)
    store.setSurface('changes')
    const files = fakeFilesBridge({ 'visual-gate': { root: 'D:\\work\\workshop', token: TOKEN_A, tree: { 'a.txt': { kind: 'file', content: text('a') } } } })
    const view = render(<ToolsPanel focusedThreadId="visual-gate" state={withWorktree(false)} files={files} gitChanges={git.bridge} store={store} />)
    await within(panel()).findByText('The working copy matches HEAD.')
    const tab = within(panel()).getByRole('tab', { name: 'Changes', exact: true })
    expect(tab).not.toHaveAttribute('aria-description')
    act(() => store.setSurface('files'))
    expect(tab.querySelector('.tools-rail__live')).toBeNull()
    // An agent edits a file while Changes is closed, and main's read after the turn marks the working copy dirty.
    view.rerender(<ToolsPanel focusedThreadId="visual-gate" state={withWorktree(true)} files={files} gitChanges={git.bridge} store={store} />)
    expect(tab).toHaveAccessibleDescription('Has uncommitted changes')
    expect(tab.querySelector('.tools-rail__live')).not.toBeNull()
  })
})

describe('the Changes shortcut', () => {
  it('toggles Changes with Ctrl+D, leaves a terminal its own Ctrl+D, and gives way to a dictation hotkey on the same keys', async () => {
    const git = fakeGit()
    const store = new ToolsPanelStore()
    const files = fakeFilesBridge({ 'visual-gate': { root: 'D:\\work\\workshop', token: TOKEN_A, tree: {} } })
    render(<><div className="xterm"><textarea aria-label="Terminal input" /></div><ToolsPanel focusedThreadId="visual-gate" state={threadsStateFixture()} files={files} gitChanges={git.bridge} store={store} /></>)
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Terminal input' }), { key: 'd', ctrlKey: true })
    expect(store.getSnapshot().open).toBe(false)
    fireEvent.keyDown(window, { key: 'd', ctrlKey: true })
    expect(store.getSnapshot()).toMatchObject({ open: true, surface: 'changes' })
    await within(panel()).findByText('export const ready = true')
    act(() => store.setSurface('files'))
    fireEvent.keyDown(window, { key: 'd', ctrlKey: true })
    expect(store.getSnapshot()).toMatchObject({ open: true, surface: 'changes' })
    fireEvent.keyDown(window, { key: 'd', ctrlKey: true })
    expect(store.getSnapshot().open).toBe(false)

    expect(changesChord(undefined, 'win32')).toBe('mod+d')
    expect(changesChord('CommandOrControl+Shift+Space', 'win32')).toBe('mod+d')
    expect(changesChord('CommandOrControl+D', 'win32')).toBe('mod+shift+d')
    expect(changesChord('Command+D', 'darwin')).toBe('mod+shift+d')
    expect(changesChord('Control+D', 'darwin')).toBe('mod+d')
  })
})

describe('what Open can open', () => {
  it('offers a file only while the working copy has it', () => {
    const thread = (scope: 'working' | 'branch', working: GitChange[]) => ({ threadId: 't', workspace: null, scope: scope === 'working' ? { kind: 'working' as const } : { kind: 'branch' as const, base: null },
      list: { status: 'ready' as const, branch: 'b', revision: 'r', files: working, truncated: false }, review: null, turns: [], collapsed: new Map(), refreshing: false })
    const text = { kind: 'text' as const, patch: '' }
    expect(inWorkingCopy(reviewFile('a.ts', 'deleted', text), thread('working', [{ path: 'a.ts', status: 'deleted' }]))).toBe(false)
    expect(inWorkingCopy(reviewFile('a.ts', 'modified', text), thread('working', [{ path: 'a.ts', status: 'modified' }]))).toBe(true)
    // Deleted by the branch or a turn: gone unless it has come back since.
    expect(inWorkingCopy(reviewFile('a.ts', 'deleted', text), thread('branch', []))).toBe(false)
    expect(inWorkingCopy(reviewFile('a.ts', 'deleted', text), thread('branch', [{ path: 'a.ts', status: 'untracked' }]))).toBe(true)
    // Added by the branch or a turn, then deleted in the working copy.
    expect(inWorkingCopy(reviewFile('a.ts', 'added', text), thread('branch', [{ path: 'a.ts', status: 'deleted' }]))).toBe(false)
    expect(inWorkingCopy(reviewFile('a.ts', 'added', text), thread('branch', []))).toBe(true)
  })
})

describe('diff rows and base choices', () => {
  it('numbers old and new lines from each hunk and keeps headers in order', () => {
    const rows = parseUnifiedDiff(PATCH)
    expect(rows.map(row => row.kind)).toEqual(['meta', 'meta', 'meta', 'hunk', 'context', 'remove', 'add', 'context'])
    expect(rows.slice(4).map(row => [row.oldLine, row.newLine, row.text])).toEqual([[3, 3, 'keep'], [4, null, 'export const ready = false'], [null, 4, 'export const ready = true'], [5, 5, 'tail']])
    expect(parseUnifiedDiff('@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b')).toEqual([
      { kind: 'hunk', text: '@@ -1 +1 @@', oldLine: null, newLine: null }, { kind: 'remove', text: 'a', oldLine: 1, newLine: null },
      { kind: 'note', text: 'No newline at end of file', oldLine: null, newLine: null }, { kind: 'add', text: 'b', oldLine: null, newLine: 1 },
    ])
  })

  it('joins a local branch and its origin copy into one row; another remote’s refs stand alone', () => {
    const ref = (name: string, remote?: string): GitRef => ({ name, ...(remote ? { remote } : {}), current: false, isDefault: false, worktreePath: null })
    expect(baseChoices([ref('main'), ref('dev'), ref('origin/main', 'origin'), ref('origin/HEAD', 'origin'), ref('origin/only', 'origin'), ref('fork/main', 'fork')])).toEqual([
      { id: 'main', label: 'main', local: 'main', remote: 'origin/main' },
      { id: 'dev', label: 'dev', local: 'dev', remote: null },
      { id: 'only', label: 'only', local: null, remote: 'origin/only' },
      { id: 'fork/main', label: 'fork/main', local: null, remote: 'fork/main' },
    ])
  })

  it('keeps watching the active working copy when an earlier activation finishes late', async () => {
    const git = fakeGit()
    const store = new ChangesStore()
    let finishFirst!: () => void
    vi.mocked(git.bridge.list).mockImplementation(async ({ threadId }) => {
      if (threadId === 'first') await new Promise<void>(resolve => { finishFirst = resolve })
      return { ok: true, value: { workspace: { ...workspace, threadId, workspaceId: threadId }, branch: 'main', revision: 'r1', files: [], truncated: false } }
    })
    store.activate(git.bridge, 'first')
    store.deactivate(git.bridge)
    store.activate(git.bridge, 'second')
    await waitFor(() => expect(git.bridge.watch).toHaveBeenCalledWith({ threadId: 'second', workspaceId: 'second', enabled: true }))
    finishFirst()
    await waitFor(() => expect(store.thread('first')?.list.status).toBe('ready'))
    expect(git.bridge.watch).toHaveBeenCalledTimes(1)
    expect(git.listeners.size).toBe(1)
    store.deactivate(git.bridge)
    expect(git.bridge.watch).toHaveBeenLastCalledWith({ threadId: 'second', workspaceId: 'second', enabled: false })
  })

  it('moves the active watch to a replaced working copy without waiting for the panel to reopen', async () => {
    const git = fakeGit()
    const store = new ChangesStore()
    store.activate(git.bridge, 'visual-gate')
    await waitFor(() => expect(git.bridge.watch).toHaveBeenCalledTimes(1))
    vi.mocked(git.bridge.list).mockResolvedValue({ ok: true, value: { workspace: { ...workspace, workspaceId: 'replacement' }, branch: 'main', revision: 'r2', files: [], truncated: false } })
    await store.refresh(git.bridge, 'visual-gate')
    expect(git.bridge.watch).toHaveBeenNthCalledWith(2, { threadId: 'visual-gate', workspaceId: TOKEN_A, enabled: false })
    expect(git.bridge.watch).toHaveBeenLastCalledWith({ threadId: 'visual-gate', workspaceId: 'replacement', enabled: true })
    store.deactivate(git.bridge)
  })
})
