import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitChangesBridge, GitReviewFile } from '../../../../src/shared/gitChanges'
import { ReviewCommentStore } from '../../../../src/renderer/src/agents/reviewComments'
import { ChangesSurface } from '../../../../src/renderer/src/tools/ChangesSurface'
import { ChangesStore } from '../../../../src/renderer/src/tools/changesStore'
import { TOKEN_A } from './fakeFilesBridge'

const THREAD = 'visual-gate'
const PATCH = 'diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -3,4 +3,4 @@ export\n keep\n-export const ready = false\n+export const ready = true\n tail\n end\n'
const workspace = { threadId: THREAD, projectId: 'workshop', workingDirectory: 'D:\\work\\workshop', workspaceId: TOKEN_A }
const file = (patch: string, path = 'src/app.ts'): GitReviewFile => ({ path, status: 'modified', additions: 1, deletions: 1, content: { kind: 'text', patch } })
const OTHER = 'diff --git a/src/other.ts b/src/other.ts\n--- a/src/other.ts\n+++ b/src/other.ts\n@@ -1,2 +1,2 @@\n-before\n+after\n same\n'

function fakeGit(initial: GitReviewFile[] = [file(PATCH)]) {
  let files = initial
  let revision = 'r1'
  const listeners = new Set<(event: { threadId: string; workspaceId: string; revision: string }) => void>()
  const bridge = {
    list: vi.fn(async () => ({ ok: true as const, value: { workspace, branch: 'main', revision, files: files.map(item => ({ path: item.path, status: item.status })), truncated: false } })),
    review: vi.fn(async () => ({ ok: true as const, value: { workspace, revision, scope: { kind: 'working' as const }, files, truncated: false } })),
    copyPath: vi.fn(), reveal: vi.fn(),
    watch: vi.fn(async () => ({ ok: true as const, value: undefined })),
    onChanged: vi.fn(listener => { listeners.add(listener); return () => { listeners.delete(listener) } }),
  } as unknown as GitChangesBridge
  return {
    bridge,
    change(patch: string | null, extra: GitReviewFile[] = files.slice(1)) {
      files = [...patch === null ? [] : [file(patch)], ...extra]; revision = `${revision}+`
      for (const listener of [...listeners]) listener({ threadId: THREAD, workspaceId: TOKEN_A, revision })
    },
  }
}

function setup(git = fakeGit()) {
  const store = new ChangesStore()
  const comments = new ReviewCommentStore()
  store.activate(git.bridge, THREAD)
  const view = render(<ChangesSurface threadId={THREAD} store={store} bridge={git.bridge} onStatus={vi.fn()} comments={comments} />)
  return { git, store, comments, view }
}

const grid = () => screen.getByRole('grid', { name: 'Lines of src/app.ts' })
const row = (line: string) => grid().querySelector<HTMLElement>(`[data-position]${line}`)!

beforeEach(() => { Element.prototype.scrollIntoView = function scrollIntoView() { /* jsdom has no layout */ } })
afterEach(() => { cleanup(); delete (Element.prototype as Partial<Element>).scrollIntoView })

describe('review comments in Changes', () => {
  it('picks a line with a click and more with Shift, writes a comment under them and marks it until deleted', async () => {
    const user = userEvent.setup()
    const { comments } = setup()
    await screen.findByText('export const ready = true')
    await user.click(row('[data-new-line="4"]'))
    expect(row('[data-new-line="4"]')).toHaveAttribute('aria-selected', 'true')
    await user.click(row('[data-new-line="5"]'))
    // A plain click moves the pick; Shift extends it from where it started.
    expect(row('[data-new-line="4"]')).toHaveAttribute('aria-selected', 'false')
    await user.click(row('[data-old-line="4"]'))
    await user.keyboard('{Shift>}')
    await user.click(row('[data-new-line="5"][data-kind="context"]'))
    await user.keyboard('{/Shift}')
    expect([...grid().querySelectorAll('[aria-selected="true"]')].map(item => item.getAttribute('data-kind'))).toEqual(['remove', 'add', 'context'])

    await user.click(screen.getByRole('button', { name: 'Comment on app.ts L4 to L5' }))
    const draft = screen.getByRole('textbox', { name: 'Comment on app.ts L4 to L5' })
    expect(draft).toHaveFocus()
    expect(draft).toHaveAttribute('placeholder', 'Add a comment…')
    expect(screen.getByRole('button', { name: 'Comment' })).toBeDisabled()
    await user.type(draft, 'Say why it is ready now.')
    await user.click(screen.getByRole('button', { name: 'Comment' }))

    expect(comments.list(THREAD)).toEqual([expect.objectContaining({ path: 'src/app.ts', text: 'Say why it is ready now.', lines: [
      { kind: 'remove', text: 'export const ready = false', oldLine: 4, newLine: null },
      { kind: 'add', text: 'export const ready = true', oldLine: null, newLine: 4 },
      { kind: 'context', text: 'tail', oldLine: 5, newLine: 5 },
    ] })])
    expect(screen.queryByRole('textbox', { name: /Comment on/u })).toBeNull()
    expect(screen.getByText('Say why it is ready now.').closest('.changes-comment--marker')).not.toBeNull()
    expect(row('[data-kind="remove"]')).toHaveAttribute('data-noted')
    await user.click(screen.getByRole('button', { name: 'Delete comment on app.ts L4 to L5' }))
    expect(comments.list(THREAD)).toEqual([])
    expect(screen.queryByText('Say why it is ready now.')).toBeNull()
  })

  it('opens a draft straight from a line number, and Escape drops it without adding anything', async () => {
    const user = userEvent.setup()
    const { comments } = setup()
    await screen.findByText('export const ready = true')
    await user.click(row('[data-new-line="6"]').querySelectorAll('.changes-line__number')[1]!)
    const draft = screen.getByRole('textbox', { name: 'Comment on app.ts L6' })
    await user.type(draft, 'Why keep this?{Escape}')
    expect(screen.queryByRole('textbox', { name: 'Comment on app.ts L6' })).toBeNull()
    expect(comments.list(THREAD)).toEqual([])
    // Only removed lines are named by the old file's numbers.
    await user.click(row('[data-kind="remove"]').querySelector('.changes-line__number')!)
    expect(screen.getByRole('textbox', { name: 'Comment on app.ts L4 (before)' })).toHaveFocus()
  })

  it('walks, picks and comments from the keyboard alone, one tab stop per file', async () => {
    const user = userEvent.setup()
    const { comments } = setup()
    await screen.findByText('export const ready = true')
    const tabbable = grid().querySelectorAll('[data-position][tabindex="0"]')
    expect(tabbable).toHaveLength(1)
    ;(tabbable[0] as HTMLElement).focus()
    expect(row('[data-new-line="3"]')).toHaveFocus()
    expect(row('[data-new-line="3"]')).toHaveAccessibleName('Line 3: keep')
    await user.keyboard('{ArrowDown}')
    expect(row('[data-kind="remove"]')).toHaveFocus()
    await user.keyboard('{Shift>}{ArrowDown}{/Shift}')
    expect(row('[data-kind="add"]')).toHaveFocus()
    expect(grid().querySelectorAll('[aria-selected="true"]')).toHaveLength(2)
    // Enter opens the draft on what is picked; Escape there returns to the line with the pick kept.
    await user.keyboard('{Enter}')
    expect(screen.getByRole('textbox', { name: 'Comment on app.ts L4' })).toHaveFocus()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(row('[data-kind="add"]')).toHaveFocus())
    expect(grid().querySelectorAll('[aria-selected="true"]')).toHaveLength(2)
    await user.keyboard('{Enter}')
    await user.keyboard('Flip it back{Control>}{Enter}{/Control}')
    expect(comments.list(THREAD).map(comment => comment.text)).toEqual(['Flip it back'])
    await waitFor(() => expect(row('[data-kind="add"]')).toHaveFocus())
    // Space picks one line, Escape lets go of it, End jumps to the last.
    await user.keyboard('{End} ')
    expect(row('[data-new-line="6"]')).toHaveAttribute('aria-selected', 'true')
    const escape = fireEvent.keyDown(row('[data-new-line="6"]'), { key: 'Escape' })
    expect(escape).toBe(false)
    expect(grid().querySelectorAll('[aria-selected="true"]')).toHaveLength(0)
    // With nothing picked, Escape is left for the panel.
    expect(fireEvent.keyDown(row('[data-new-line="6"]'), { key: 'Escape' })).toBe(true)
  })

  it('keeps a comment on the diff when its lines change, at the file’s end and saying so, and back under them when they return', async () => {
    const user = userEvent.setup()
    const { comments, git } = setup()
    await screen.findByText('export const ready = true')
    await user.click(row('[data-kind="add"]'))
    await user.click(screen.getByRole('button', { name: 'Comment on app.ts L4' }))
    await user.type(screen.getByRole('textbox', { name: 'Comment on app.ts L4' }), 'Check this')
    await user.click(screen.getByRole('button', { name: 'Comment' }))
    expect(screen.getByText('Check this')).toBeInTheDocument()
    git.change(PATCH.replace('+export const ready = true', '+export const ready = maybe'))
    await screen.findByText('export const ready = maybe')
    const moved = screen.getByText('Check this').closest('.changes-comment--marker')!
    expect(moved).toHaveTextContent('These lines have changed since. The comment still sends them as they were.')
    // It sits after the file's last line, which is where the reader finds the rest of the file's comments.
    expect(moved.previousElementSibling).toHaveAttribute('data-new-line', '6')
    expect(comments.list(THREAD)).toHaveLength(1)
    git.change(PATCH)
    await waitFor(() => expect(screen.getByText('Check this').closest('.changes-comment--marker')!.previousElementSibling).toHaveAttribute('data-kind', 'add'))
    expect(screen.queryByText(/These lines have changed since/u)).toBeNull()
  })

  it('lets go of picked lines on Escape from the Comment button, and leaves that Escape to nobody else', async () => {
    const user = userEvent.setup()
    setup()
    await screen.findByText('export const ready = true')
    await user.click(row('[data-kind="add"]'))
    const pill = screen.getByRole('button', { name: 'Comment on app.ts L4' })
    pill.focus()
    expect(fireEvent.keyDown(pill, { key: 'Escape' })).toBe(false)
    expect(grid().querySelectorAll('[aria-selected="true"]')).toHaveLength(0)
    await waitFor(() => expect(row('[data-kind="add"]')).toHaveFocus())
  })

  it('takes the user to a draft with words in it, and never pulls focus back to it on a later render', async () => {
    const user = userEvent.setup()
    const git = fakeGit([file(PATCH), file(OTHER, 'src/other.ts')])
    setup(git)
    await screen.findByText('export const ready = true')
    await user.click(row('[data-new-line="6"]').querySelectorAll('.changes-line__number')[1]!)
    await user.type(screen.getByRole('textbox', { name: 'Comment on app.ts L6' }), 'Keep writing')
    // Another file: a pick, then the picked line's own number, which re-renders nothing, while the worded draft is open.
    const other = screen.getByRole('grid', { name: 'Lines of src/other.ts' })
    await user.click(other.querySelector<HTMLElement>('[data-position][data-new-line="1"]')!)
    await user.click(other.querySelector<HTMLElement>('[data-position][data-new-line="1"]')!.querySelectorAll('.changes-line__number')[1]!)
    const draft = screen.getByRole('textbox', { name: 'Comment on app.ts L6' })
    await waitFor(() => expect(draft).toHaveFocus())
    expect(draft).toHaveValue('Keep writing')
    // The user leaves for somewhere else; a diff poll re-renders the draft's file; focus stays where the user put it.
    const elsewhere = screen.getByRole('button', { name: 'Refresh diff' })
    elsewhere.focus()
    git.change(PATCH.replace(' tail\n', ' tail!\n'))
    await screen.findByText('tail!')
    await new Promise(resolve => requestAnimationFrame(() => resolve(undefined)))
    expect(elsewhere).toHaveFocus()
  })

  it('marks a comment past the rows drawn as further down, not as changed', async () => {
    const user = userEvent.setup()
    // A new file of 3,100 lines: past the 3,000 rows Changes draws before Show all.
    const long = `diff --git a/src/app.ts b/src/app.ts\n--- /dev/null\n+++ b/src/app.ts\n@@ -0,0 +1,3100 @@\n${Array.from({ length: 3100 }, (_, index) => `+line ${index + 1}`).join('\n')}\n`
    const { comments } = setup(fakeGit([file(long)]))
    await screen.findByText('line 1')
    await user.click(screen.getByRole('button', { name: 'Show all' }))
    await user.click(row('[data-new-line="3050"]'))
    await user.click(screen.getByRole('button', { name: 'Comment on app.ts L3050' }))
    await user.type(screen.getByRole('textbox', { name: 'Comment on app.ts L3050' }), 'Far down')
    await user.click(screen.getByRole('button', { name: 'Comment' }))
    expect(screen.getByText('Far down').closest('.changes-comment--marker')!.previousElementSibling).toHaveAttribute('data-new-line', '3050')
    // Collapsing and expanding draws the first 3,000 rows again; the comment's line is still in the file.
    await user.click(screen.getByRole('button', { name: 'Collapse src/app.ts' }))
    await user.click(screen.getByRole('button', { name: 'Expand src/app.ts' }))
    const marker = (await screen.findByText('Far down')).closest('.changes-comment--marker')!
    expect(marker).toHaveTextContent('Its lines are further down. Show all to see them.')
    expect(marker).not.toHaveTextContent('changed since')
    expect(comments.list(THREAD)).toHaveLength(1)
  })

  it('keeps a comment in sight, with Delete comment, when its file leaves the comparison', async () => {
    const user = userEvent.setup()
    const git = fakeGit([file(PATCH), file(OTHER, 'src/other.ts')])
    const { comments } = setup(git)
    await screen.findByText('export const ready = true')
    await user.click(row('[data-kind="add"]'))
    await user.click(screen.getByRole('button', { name: 'Comment on app.ts L4' }))
    await user.type(screen.getByRole('textbox', { name: 'Comment on app.ts L4' }), 'Still wanted')
    await user.click(screen.getByRole('button', { name: 'Comment' }))
    // src/app.ts is committed; only the other file is left.
    git.change(null, [file(OTHER, 'src/other.ts')])
    const elsewhere = await screen.findByRole('region', { name: 'Comments on files not in this comparison' })
    expect(within(elsewhere).getByText('Still wanted')).toBeInTheDocument()
    expect(within(elsewhere).getByText('src/app.ts L4')).toBeInTheDocument()
    // Nothing left to compare: the list still shows under the empty comparison.
    git.change(null, [])
    await screen.findByText('The working copy matches HEAD.')
    const still = screen.getByRole('region', { name: 'Comments on files not in this comparison' })
    await user.click(within(still).getByRole('button', { name: 'Delete comment on src/app.ts L4' }))
    expect(comments.list(THREAD)).toEqual([])
    expect(screen.queryByRole('region', { name: 'Comments on files not in this comparison' })).toBeNull()
  })

  it('shows a new pick while a worded draft is open, its Comment waiting on that draft', async () => {
    const user = userEvent.setup()
    setup(fakeGit([file(PATCH), file(OTHER, 'src/other.ts')]))
    await screen.findByText('export const ready = true')
    await user.click(row('[data-new-line="6"]').querySelectorAll('.changes-line__number')[1]!)
    await user.type(screen.getByRole('textbox', { name: 'Comment on app.ts L6' }), 'Half written')
    // The draft's own pick shows no Comment: the draft is under it.
    expect(screen.queryByRole('button', { name: 'Comment on app.ts L6' })).toBeNull()
    const other = screen.getByRole('grid', { name: 'Lines of src/other.ts' })
    const line = other.querySelector<HTMLElement>('[data-position][data-new-line="1"]')!
    await user.click(line)
    expect(line).toHaveAttribute('aria-selected', 'true')
    const pill = within(other).getByRole('button', { name: 'Comment on other.ts L1' })
    // It stays reachable, says why it waits, and takes the user to the draft rather than replacing it.
    expect(pill).toHaveAttribute('aria-disabled', 'true')
    expect(pill).not.toBeDisabled()
    expect(pill).toHaveAccessibleDescription('Finish or cancel your comment on app.ts L6 first.')
    pill.focus()
    await user.keyboard('{Enter}')
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Comment on app.ts L6' })).toHaveFocus())
    // The draft keeps its words and its lines stay marked.
    expect(screen.getByRole('textbox', { name: 'Comment on app.ts L6' })).toHaveValue('Half written')
    expect(row('[data-new-line="6"]')).toHaveAttribute('aria-selected', 'true')
    // In the draft's own file a new pick shows too, beside the draft's lines.
    await user.click(row('[data-new-line="3"]'))
    expect(row('[data-new-line="3"]')).toHaveAttribute('aria-selected', 'true')
    expect(row('[data-new-line="6"]')).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('button', { name: 'Comment on app.ts L3' })).toHaveAttribute('aria-disabled', 'true')
  })

  it('keeps a worded draft reachable when its file leaves the comparison, so Comment is never stuck', async () => {
    const user = userEvent.setup()
    const git = fakeGit([file(PATCH), file(OTHER, 'src/other.ts')])
    const { comments } = setup(git)
    await screen.findByText('export const ready = true')
    await user.click(row('[data-new-line="6"]').querySelectorAll('.changes-line__number')[1]!)
    await user.type(screen.getByRole('textbox', { name: 'Comment on app.ts L6' }), 'Unfinished')
    // src/app.ts is committed away; the draft is listed after the files with its words.
    git.change(null, [file(OTHER, 'src/other.ts')])
    const draft = await screen.findByRole('textbox', { name: 'Comment on src/app.ts L6' })
    expect(draft).toHaveValue('Unfinished')
    expect(draft.closest('.changes-elsewhere')).not.toBeNull()
    // A line number in the other file takes the user to it rather than doing nothing.
    const other = screen.getByRole('grid', { name: 'Lines of src/other.ts' })
    await user.click(other.querySelector<HTMLElement>('[data-position][data-new-line="1"]')!.querySelectorAll('.changes-line__number')[1]!)
    await waitFor(() => expect(draft).toHaveFocus())
    // Cancel there lets the other file's Comment work again.
    await user.click(within(draft.closest('.changes-comment')! as HTMLElement).getByRole('button', { name: 'Cancel' }))
    expect(comments.draft(THREAD)).toBeNull()
    await user.click(other.querySelector<HTMLElement>('[data-position][data-new-line="1"]')!.querySelectorAll('.changes-line__number')[1]!)
    expect(screen.getByRole('textbox', { name: 'Comment on other.ts L1' })).toHaveFocus()
  })

  it('opens a collapsed file to take the user to its worded draft', async () => {
    const user = userEvent.setup()
    setup(fakeGit([file(PATCH), file(OTHER, 'src/other.ts')]))
    await screen.findByText('export const ready = true')
    await user.click(row('[data-new-line="6"]').querySelectorAll('.changes-line__number')[1]!)
    await user.type(screen.getByRole('textbox', { name: 'Comment on app.ts L6' }), 'Unfinished')
    await user.click(screen.getByRole('button', { name: 'Collapse src/app.ts' }))
    expect(screen.queryByRole('textbox', { name: 'Comment on app.ts L6' })).toBeNull()
    const other = screen.getByRole('grid', { name: 'Lines of src/other.ts' })
    const line = other.querySelector<HTMLElement>('[data-position][data-new-line="1"]')!
    line.focus()
    await user.keyboard('{Enter}')
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Comment on app.ts L6' })).toHaveFocus())
    expect(screen.getByRole('textbox', { name: 'Comment on app.ts L6' })).toHaveValue('Unfinished')
  })

  it('hands focus on when a comment is deleted from the list after the files, never to the page', async () => {
    const user = userEvent.setup()
    const git = fakeGit([file(PATCH), file(OTHER, 'src/other.ts')])
    const { comments } = setup(git)
    await screen.findByText('export const ready = true')
    comments.add(THREAD, { path: 'src/gone.ts', lines: [{ kind: 'add', text: 'a', oldLine: null, newLine: 1 }], text: 'First' })
    comments.add(THREAD, { path: 'src/gone.ts', lines: [{ kind: 'add', text: 'b', oldLine: null, newLine: 2 }], text: 'Second' })
    const list = await screen.findByRole('region', { name: 'Comments on files not in this comparison' })
    await user.click(within(list).getByRole('button', { name: 'Delete comment on src/gone.ts L1' }))
    expect(within(list).getByRole('button', { name: 'Delete comment on src/gone.ts L2' })).toHaveFocus()
    // The last one empties the list: focus goes to the last file's head.
    await user.click(within(list).getByRole('button', { name: 'Delete comment on src/gone.ts L2' }))
    expect(screen.queryByRole('region', { name: 'Comments on files not in this comparison' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Collapse src/other.ts' })).toHaveFocus()
    // With no files to compare, it goes to Refresh diff.
    git.change(null, [])
    await screen.findByText('The working copy matches HEAD.')
    comments.add(THREAD, { path: 'src/gone.ts', lines: [{ kind: 'add', text: 'c', oldLine: null, newLine: 3 }], text: 'Third' })
    await user.click(await screen.findByRole('button', { name: 'Delete comment on src/gone.ts L3' }))
    expect(screen.getByRole('button', { name: 'Refresh diff' })).toHaveFocus()
  })

  it('keeps a full message’s Comment reachable with its reason, and opens nothing', async () => {
    const user = userEvent.setup()
    const { comments } = setup()
    await screen.findByText('export const ready = true')
    for (let index = 0; index < 20; index++) comments.add(THREAD, { path: 'src/gone.ts', lines: [{ kind: 'add', text: 'x', oldLine: null, newLine: index + 1 }], text: 'Note' })
    await user.click(row('[data-kind="add"]'))
    const pill = screen.getByRole('button', { name: 'Comment on app.ts L4' })
    expect(pill).toHaveAttribute('aria-disabled', 'true')
    expect(pill).toHaveAccessibleDescription('A message carries at most 20 comments. Send it or delete one first.')
    await user.click(pill)
    expect(comments.draft(THREAD)).toBeNull()
  })

  it('picks split rows too, a pair quoting both of its lines', async () => {
    const user = userEvent.setup()
    const { store, comments } = setup()
    await screen.findByText('export const ready = true')
    store.setView({ layout: 'split' })
    await waitFor(() => expect(grid().querySelector('.changes-split__row')).not.toBeNull())
    const pair = grid().querySelector<HTMLElement>('.changes-split__row[data-old-line="4"]')!
    expect(pair).toHaveAccessibleName('Removed line 4: export const ready = false; Added line 4: export const ready = true')
    await user.click(pair)
    await user.click(within(grid()).getByRole('button', { name: 'Comment on app.ts L4' }))
    await user.type(screen.getByRole('textbox', { name: 'Comment on app.ts L4' }), 'Both sides')
    await user.click(screen.getByRole('button', { name: 'Comment' }))
    expect(comments.list(THREAD)[0]!.lines.map(line => line.kind)).toEqual(['remove', 'add'])
  })
})
