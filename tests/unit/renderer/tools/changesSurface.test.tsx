import React from 'react'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GitChange, GitChangesBridge, GitFileDiff } from '../../../../src/shared/gitChanges'
import type { ToolsResult } from '../../../../src/shared/tools'
import { ToolsPanel } from '../../../../src/renderer/src/tools/ToolsPanel'
import { parseUnifiedDiff } from '../../../../src/renderer/src/tools/changesStore'
import { ToolsPanelStore } from '../../../../src/renderer/src/tools/toolsPanelStore'
import { threadsStateFixture } from '../liveAgentState'
import { TOKEN_A, fakeFilesBridge, text } from './fakeFilesBridge'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

const PATCH = 'diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -3,3 +3,3 @@ export\n keep\n-export const ready = false\n+export const ready = true\n tail\n'
const workspace = { threadId: 'visual-gate', projectId: 'workshop', workingDirectory: 'D:\\work\\workshop', workspaceId: TOKEN_A }

function fakeGit(options: { files?: GitChange[]; diffs?: Record<string, GitFileDiff['content']>; listError?: 'not-repository' } = {}) {
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
      : { ok: true, value: { workspace, branch: 'feature/changes', revision, files, truncated: false } as never }),
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
  it('lists the working copy, opens a readable diff from the keyboard and returns focus when it closes', async () => {
    const { git } = setup()
    const list = await within(panel()).findByRole('listbox', { name: 'Changed files' })
    expect(within(panel()).getByText(/3 changed files/u)).toHaveTextContent('3 changed files on feature/changes')
    expect(within(list).getAllByRole('option').map(option => option.getAttribute('aria-label'))).toEqual(['app.ts, Modified, in src/', 'new.md, Untracked, in docs/', 'logo.png, Modified'])
    await waitFor(() => expect(git.bridge.watch).toHaveBeenCalledWith({ threadId: 'visual-gate', workspaceId: TOKEN_A, enabled: true }))

    within(list).getAllByRole('option')[0]!.focus()
    await userEvent.keyboard('{ArrowDown}{ArrowUp}{Enter}')
    const diff = await within(panel()).findByRole('region', { name: 'Changes in src/app.ts' })
    await waitFor(() => expect(diff.querySelectorAll('.changes-line')).toHaveLength(8))
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
    expect(within(panel()).getAllByRole('option')).toHaveLength(1)

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
})
