import React from 'react'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GitChange, GitChangesBridge, GitChangeListing, GitCommitDraft, GitFileDiff } from '../../../../src/shared/gitChanges'
import type { ToolsResult } from '../../../../src/shared/tools'
import { ToolsPanel } from '../../../../src/renderer/src/tools/ToolsPanel'
import { ChangesStore, parseUnifiedDiff } from '../../../../src/renderer/src/tools/changesStore'
import { ToolsPanelStore } from '../../../../src/renderer/src/tools/toolsPanelStore'
import { threadsStateFixture } from '../liveAgentState'
import { TOKEN_A, fakeFilesBridge, text } from './fakeFilesBridge'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

const PATCH = 'diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -3,3 +3,3 @@ export\n keep\n-export const ready = false\n+export const ready = true\n tail\n'
const workspace = { threadId: 'visual-gate', projectId: 'workshop', workingDirectory: 'D:\\work\\workshop', workspaceId: TOKEN_A }

function fakeGit(options: { files?: GitChange[]; diffs?: Record<string, GitFileDiff['content']>; listError?: 'not-repository'; truncated?: boolean } = {}) {
  let files: GitChange[] = options.files ?? [
    { path: 'src/app.ts', status: 'modified', staged: false, unstaged: true },
    { path: 'docs/new.md', status: 'untracked', staged: false, unstaged: true },
    { path: 'logo.png', status: 'modified', staged: true, unstaged: false },
  ]
  let revision = 'r1'
  const diffs = options.diffs ?? { 'src/app.ts': { kind: 'text', patch: PATCH }, 'docs/new.md': { kind: 'text', patch: '@@ -0,0 +1 @@\n+# New\n' }, 'logo.png': { kind: 'binary', message: 'Binary files differ' } }
  const listeners = new Set<(event: { threadId: string; workspaceId: string; revision: string }) => void>()
  const held: { resolve: (() => void) | null } = { resolve: null }
  const bridge: GitChangesBridge = {
    list: vi.fn(async (): Promise<ToolsResult<never>> => options.listError
      ? { ok: false, error: { code: options.listError, message: 'no repo' } }
      : { ok: true, value: { workspace, branch: 'feature/changes', revision, files, truncated: options.truncated ?? false } as never }),
    diff: vi.fn(async ({ path }): Promise<ToolsResult<GitFileDiff>> => {
      if (path === 'docs/new.md' && held.resolve === null && diffHold.on) await new Promise<void>(resolve => { held.resolve = resolve })
      return { ok: true, value: { workspace, path, revision, content: diffs[path] ?? { kind: 'unavailable', message: 'gone' } } }
    }),
    copyPath: vi.fn(async ({ path }) => ({ ok: true as const, value: { workspace, path, absolutePath: `D:/work/workshop/${path}` } })),
    reveal: vi.fn(async ({ path }) => ({ ok: true as const, value: { workspace, path, absolutePath: `D:/work/workshop/${path}` } })),
    watch: vi.fn(async () => ({ ok: true as const, value: undefined })),
    onChanged: vi.fn(listener => { listeners.add(listener); return () => { listeners.delete(listener) } }),
  }
  const diffHold = { on: false }
  return {
    bridge, held, diffHold, listeners,
    change(next: GitChange[], nextRevision: string, patches: Record<string, GitFileDiff['content']> = {}) {
      files = next; revision = nextRevision; Object.assign(diffs, patches)
      for (const listener of [...listeners]) listener({ threadId: 'visual-gate', workspaceId: TOKEN_A, revision: nextRevision })
    },
  }
}

function setup(git = fakeGit()) {
  const store = new ToolsPanelStore()
  store.setOpen(true)
  store.setSurface('changes')
  const files = fakeFilesBridge({ 'visual-gate': { root: 'D:\\work\\workshop', token: TOKEN_A, tree: { 'a.txt': { kind: 'file', content: text('a') } } } })
  render(<ToolsPanel focusedThreadId="visual-gate" state={threadsStateFixture()} files={files} gitChanges={git.bridge} store={store} />)
  return { store, git }
}

const panel = () => screen.getByRole('complementary', { name: 'Tools' })

describe('local Git action feedback', () => {
  it('keeps the editable commit message after rejection and refreshes only after a confirmed action', async () => {
    const user = userEvent.setup(), git = fakeGit()
    git.bridge.act = vi.fn(async () => ({ ok: false as const, error: { code: 'blocked' as const, message: 'Resolve the conflicting files first.' } }))
    git.bridge.branches = vi.fn(async () => ({ ok: true as const, value: { current: 'feature/changes', branches: ['feature/changes'] } }))
    setup(git)
    await user.click(await screen.findByRole('button', { name: 'Git actions', exact: true }))
    const message = screen.getByRole('textbox', { name: 'Commit message' })
    await user.type(message, 'Preserve this commit message')
    await user.click(screen.getByRole('button', { name: 'Commit staged changes (1)' }))
    expect(await screen.findByText('Resolve the conflicting files first.')).toBeInTheDocument()
    expect(message).toHaveValue('Preserve this commit message')
    expect(git.bridge.act).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'visual-gate', workspaceId: TOKEN_A, revision: 'r1', action: 'commit', message: 'Preserve this commit message' }))
  })

  it('puts the Git toggles on the line of chrome and the file’s staging in its head, with no bar between', async () => {
    const user = userEvent.setup(), git = fakeGit()
    git.bridge.act = vi.fn(async () => ({ ok: true as const, value: undefined as never }))
    git.bridge.checkpoints = vi.fn(async () => ({ ok: true as const, value: { supported: true, checkpoints: [] } as never }))
    setup(git)
    const toggle = await screen.findByRole('button', { name: 'Git actions', exact: true })
    expect(toggle.closest('.tools-chrome')).toHaveClass('changes-summary')
    expect(screen.getByRole('button', { name: 'Checkpoints', exact: true }).closest('.tools-chrome')).toHaveClass('changes-summary')
    expect(panel().querySelector('.git-actions')).toBeNull()
    await user.click(within(panel()).getByRole('option', { name: /^app\.ts/u }))
    const stage = await screen.findByRole('button', { name: 'Stage file', exact: true })
    expect(stage.closest('.files-preview__head')).not.toBeNull()
    await user.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(within(panel().querySelector('.git-actions') as HTMLElement).getByRole('textbox', { name: 'Commit message' })).toBeInTheDocument()
  })
})

describe('the drafted commit message', () => {
  const committed: GitChangeListing = { workspace, branch: 'feature/changes', revision: 'r2', files: [], truncated: false }

  it('shows a writing state, then the draft, and commits only the edited text when the button is pressed', async () => {
    const user = userEvent.setup(), git = fakeGit()
    let release!: (draft: GitCommitDraft) => void
    git.bridge.draftCommitMessage = vi.fn(() => new Promise<ToolsResult<GitCommitDraft>>(resolve => { release = draft => resolve({ ok: true, value: draft }) }))
    git.bridge.act = vi.fn(async () => ({ ok: true as const, value: committed }))
    setup(git)
    await user.click(await screen.findByRole('button', { name: 'Git actions', exact: true }))
    const message = screen.getByRole('textbox', { name: 'Commit message' })
    expect(await screen.findByText('Writing…')).toBeInTheDocument()
    expect(message).toHaveValue('')
    expect(git.bridge.draftCommitMessage).toHaveBeenCalledWith({ threadId: 'visual-gate', workspaceId: TOKEN_A, revision: 'r1' })
    // Writing never locks the form: only an empty message keeps Commit disabled.
    expect(screen.getByRole('button', { name: 'Commit staged changes (1)' })).toBeDisabled()

    await act(async () => { release({ message: 'Raise the dark palette contrast', truncated: false }) })
    await waitFor(() => expect(message).toHaveValue('Raise the dark palette contrast'))
    expect(screen.queryByText('Writing…')).toBeNull()
    // A draft on screen is not a commit.
    expect(git.bridge.act).not.toHaveBeenCalled()

    await user.clear(message)
    await user.type(message, 'Raise the dark palette contrast in both themes')
    await user.click(screen.getByRole('button', { name: 'Commit staged changes (1)' }))
    expect(git.bridge.act).toHaveBeenCalledWith(expect.objectContaining({ action: 'commit', message: 'Raise the dark palette contrast in both themes' }))
  })

  it('opens empty with nothing written, and regenerates over the field on request', async () => {
    const user = userEvent.setup(), git = fakeGit()
    git.bridge.draftCommitMessage = vi.fn(async () => ({ ok: true as const, value: { message: null, truncated: false } }))
    git.bridge.act = vi.fn(async () => ({ ok: true as const, value: committed }))
    setup(git)
    await user.click(await screen.findByRole('button', { name: 'Git actions', exact: true }))
    const message = screen.getByRole('textbox', { name: 'Commit message' })
    await waitFor(() => expect(git.bridge.draftCommitMessage).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.queryByText('Writing…')).toBeNull())
    expect(message).toHaveValue('')
    expect(screen.queryByText(/could not|unavailable|failed/iu)).toBeNull()

    await user.type(message, 'Something I typed')
    git.bridge.draftCommitMessage = vi.fn(async () => ({ ok: true as const, value: { message: 'Add the drafted commit message', truncated: true } }))
    await user.click(screen.getByRole('button', { name: 'Regenerate' }))
    await waitFor(() => expect(message).toHaveValue('Add the drafted commit message'))
    expect(await screen.findByText(/too large to send whole/u)).toBeInTheDocument()
  })
})

describe('unified diff rows', () => {
  it('numbers old and new lines from each hunk and keeps headers in order', () => {
    const rows = parseUnifiedDiff(PATCH)
    expect(rows.map(row => row.kind)).toEqual(['meta', 'meta', 'meta', 'hunk', 'context', 'remove', 'add', 'context'])
    expect(rows.slice(4).map(row => [row.oldLine, row.newLine, row.text])).toEqual([[3, 3, 'keep'], [4, null, 'export const ready = false'], [null, 4, 'export const ready = true'], [5, 5, 'tail']])
    expect(parseUnifiedDiff('@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b')).toEqual([
      { kind: 'hunk', text: '@@ -1 +1 @@', oldLine: null, newLine: null }, { kind: 'remove', text: 'a', oldLine: 1, newLine: null },
      { kind: 'note', text: 'No newline at end of file', oldLine: null, newLine: null }, { kind: 'add', text: 'b', oldLine: null, newLine: 1 },
    ])
  })
})

describe('Changes surface', () => {
  it('aligns unequal edits in split view without losing context, hunk numbers or no-newline notes', async () => {
    const patch = 'diff --git a/src/old.ts b/src/app.ts\nold mode 100644\nnew mode 100755\nsimilarity index 75%\nrename from src/old.ts\nrename to src/app.ts\nindex abc123..def456 100755\n--- a/src/old.ts\n+++ b/src/app.ts\n@@ -10,4 +20,5 @@\n keep\n-old one\n-old two\n+new one\n+new two\n+new three\n tail\n@@ -30 +40 @@\n-old end\n\\ No newline at end of file\n+new end\n'
    setup(fakeGit({ diffs: { 'src/app.ts': { kind: 'text', patch } } }))
    await userEvent.click(await within(panel()).findByRole('option', { name: /^app\.ts/u }))
    const diff = await within(panel()).findByRole('region', { name: 'Changes in src/app.ts' })
    await within(diff).findByText('new three')
    const visibleMetadata = () => [...diff.querySelectorAll('.changes-line[data-kind="meta"]')].map(row => row.textContent)
    const usefulMetadata = ['old mode 100644', 'new mode 100755', 'similarity index 75%', 'rename from src/old.ts', 'rename to src/app.ts']
    expect(visibleMetadata()).toEqual(usefulMetadata)
    const toggle = within(diff).getByRole('button', { name: 'Split view' })
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    await userEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    expect(within(diff).getByText('Before')).toBeInTheDocument()
    expect(within(diff).getByText('Working copy')).toBeInTheDocument()
    expect(visibleMetadata()).toEqual(usefulMetadata)
    const rows = [...diff.querySelectorAll('.changes-split__row')].map(row => [...row.children].map(cell => [
      cell.querySelector('.changes-line__number')!.textContent,
      cell.querySelector('.changes-line__text')!.textContent?.trim(),
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
    const blocks = [...diff.querySelector('.changes-diff__rows')!.children]
    expect(blocks.filter(row => row.getAttribute('data-kind') === 'hunk').map(row => row.textContent)).toEqual(['@@ -10,4 +20,5 @@', '@@ -30 +40 @@'])
    const note = blocks.findIndex(row => row.getAttribute('data-kind') === 'note')
    expect(blocks[note - 1]).toHaveTextContent('old end')
    expect(blocks[note]).toHaveTextContent('No newline at end of file')
    expect(blocks[note + 1]).toHaveTextContent('new end')
    await userEvent.click(toggle)
    expect(diff.querySelector('.changes-split__row')).toBeNull()
    expect(diff.querySelectorAll('.changes-line[data-kind="remove"]')).toHaveLength(3)
    expect(diff.querySelectorAll('.changes-line[data-kind="add"]')).toHaveLength(4)
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

  it('lists the working copy, opens a readable diff from the keyboard and returns focus when it closes', async () => {
    const { git } = setup()
    const list = await within(panel()).findByRole('listbox', { name: 'Changed files' })
    expect(within(panel()).getByText(/3 changed files/u).closest('.changes-summary')).toHaveTextContent('3 changed files on feature/changes')
    expect(within(list).getAllByRole('option').map(option => option.getAttribute('aria-label'))).toEqual(['app.ts, Modified, in src/', 'new.md, Untracked, in docs/', 'logo.png, Modified'])
    await waitFor(() => expect(git.bridge.watch).toHaveBeenCalledWith({ threadId: 'visual-gate', workspaceId: TOKEN_A, enabled: true }))

    within(list).getAllByRole('option')[0]!.focus()
    await userEvent.keyboard('{ArrowDown}{ArrowUp}{Enter}')
    const diff = await within(panel()).findByRole('region', { name: 'Changes in src/app.ts' })
    await waitFor(() => expect(diff.querySelectorAll('.changes-line')).toHaveLength(5))
    expect([...diff.querySelectorAll('.changes-line[data-kind="remove"], .changes-line[data-kind="add"]')].map(row => row.querySelector('.changes-line__text')!.textContent))
      .toEqual(['Removed: export const ready = false', 'Added: export const ready = true'])
    expect(git.bridge.diff).toHaveBeenCalledWith({ threadId: 'visual-gate', workspaceId: TOKEN_A, path: 'src/app.ts' })

    await userEvent.click(within(diff).getByRole('button', { name: 'Close diff' }))
    expect(within(panel()).queryByRole('region', { name: /Changes in/u })).toBeNull()
    expect(within(list).getAllByRole('option')[0]).toHaveFocus()
  })

  it('refreshes on a new revision without dropping the open diff, and ignores a late diff for a file no longer selected', async () => {
    const { git } = setup()
    const list = await within(panel()).findByRole('listbox', { name: 'Changed files' })
    await userEvent.click(within(list).getByRole('option', { name: /^app\.ts/u }))
    const diff = await within(panel()).findByRole('region', { name: 'Changes in src/app.ts' })
    await within(diff).findByText('export const ready = true')

    act(() => git.change([{ path: 'src/app.ts', status: 'modified', staged: false, unstaged: true }], 'r2', { 'src/app.ts': { kind: 'text', patch: '@@ -1 +1 @@\n-old\n+refreshed\n' } }))
    // While the refreshed diff loads, the reader keeps the lines already on screen.
    expect(within(panel()).getByRole('region', { name: 'Changes in src/app.ts' })).toBeInTheDocument()
    expect(await within(panel()).findByText('refreshed')).toBeInTheDocument()
    expect(within(list).getAllByRole('option')).toHaveLength(1)

    act(() => git.change([{ path: 'src/app.ts', status: 'modified', staged: false, unstaged: true }, { path: 'docs/new.md', status: 'untracked', staged: false, unstaged: true }], 'r3'))
    const newer = await within(panel()).findByRole('option', { name: /^new\.md/u })
    git.diffHold.on = true
    await userEvent.click(newer)
    await userEvent.click(within(panel()).getByRole('option', { name: /^app\.ts/u }))
    await within(panel()).findByText('refreshed')
    await act(async () => { git.held.resolve?.() })
    expect(within(panel()).getByRole('region', { name: 'Changes in src/app.ts' })).toBeInTheDocument()
    expect(within(panel()).queryByText('# New')).toBeNull()
  })

  it('explains a binary file and a folder outside Git, and stops watching when the surface is hidden', async () => {
    const { store, git } = setup()
    const list = await within(panel()).findByRole('listbox', { name: 'Changed files' })
    await userEvent.click(within(list).getByRole('option', { name: /^logo\.png/u }))
    expect(await within(panel()).findByText('Binary file: no text diff.')).toBeInTheDocument()
    await userEvent.click(within(panel()).getByRole('button', { name: 'Show in File Explorer' }))
    expect(git.bridge.reveal).toHaveBeenCalledWith({ threadId: 'visual-gate', workspaceId: TOKEN_A, path: 'logo.png' })

    act(() => store.setSurface('files'))
    expect(git.bridge.watch).toHaveBeenLastCalledWith({ threadId: 'visual-gate', workspaceId: TOKEN_A, enabled: false })
    expect(git.listeners.size).toBe(0)
    cleanup()

    setup(fakeGit({ listError: 'not-repository' }))
    expect(await within(panel()).findByText('This working folder is not a Git repository.')).toBeInTheDocument()
    expect(within(panel()).queryByRole('button', { name: 'Try again' })).toBeNull()
  })

  it('says a cut-off list is at least its count in the Changes description', async () => {
    setup(fakeGit({ truncated: true }))
    await within(panel()).findByText('3+ changed files')
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
    await within(panel()).findByText('No changes')
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
