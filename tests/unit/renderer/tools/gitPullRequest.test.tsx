import React from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { GitPullRequest } from '../../../../src/renderer/src/tools/GitPullRequest'
import type { GitChangesBridge } from '../../../../src/shared/gitChanges'
import type { PrReview } from '../../../../src/shared/gitPullRequests'
const openLink = vi.hoisted(() => vi.fn(async () => ({ ok: true })))
vi.mock('../../../../src/renderer/src/tools/webLinks', () => ({ threadLinkRouter: (threadId: string) => ({ open: (url: string) => openLink(threadId, url) }) }))
afterEach(() => { cleanup(); vi.clearAllMocks() })
const review: PrReview = { workspace: { threadId: 'a', projectId: 'p', workspaceId: 'w', workingDirectory: '/owned' }, branch: 'feature', head: 'abc123', revision: 'review-token', remotes: ['origin'], remote: 'origin', remoteUrl: 'https://github.com/example/owned.git', repository: 'https://github.com/example/owned', base: 'main', title: 'Reviewed title', body: '', pullRequest: null, error: null }
it('reviews editable fields before publishing and routes the resulting PR link with its owning thread', async () => {
  const actPullRequest = vi.fn(async () => ({ ok: true, value: { message: 'Created.', pullRequest: { number: 17, title: 'Edited title', url: 'https://github.com/example/owned/pull/17', state: 'OPEN', head: 'feature', base: 'main', draft: false, review: 'APPROVED', checks: [] } } }))
  const bridge = { reviewPullRequest: vi.fn(async () => ({ ok: true, value: review })), actPullRequest } as unknown as GitChangesBridge
  render(<GitPullRequest threadId="a" workspaceId="w" bridge={bridge} />)
  await screen.findByDisplayValue('Reviewed title'); expect(actPullRequest).not.toHaveBeenCalled()
  fireEvent.change(screen.getByLabelText('PR title'), { target: { value: 'Edited title' } }); fireEvent.change(screen.getByLabelText('PR body'), { target: { value: 'Reviewed\nbody' } })
  fireEvent.click(screen.getByRole('button', { name: 'Create pull request' }))
  await screen.findByRole('region', { name: 'Pull request status' })
  expect(actPullRequest).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'a', workspaceId: 'w', revision: 'review-token', title: 'Edited title', body: 'Reviewed\nbody', base: 'main', action: 'create' }))
  fireEvent.click(screen.getByRole('button', { name: /#17/ })); await waitFor(() => expect(openLink).toHaveBeenCalledWith('a', 'https://github.com/example/owned/pull/17'))
})
it('shows a writing state, fills the form with the draft, regenerates it, and creates only what the fields hold', async () => {
  let resolveFirst!: (value: unknown) => void
  const draftPullRequestText = vi.fn()
    .mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve }))
    .mockResolvedValue({ ok: true, value: { title: 'Second drafted title', body: '## What changed\n\n- Draft 2.' } })
  const actPullRequest = vi.fn(async () => ({ ok: true, value: { message: 'Created.', pullRequest: null } }))
  const bridge = { reviewPullRequest: vi.fn(async () => ({ ok: true, value: review })), draftPullRequestText, actPullRequest } as unknown as GitChangesBridge
  render(<GitPullRequest threadId="a" workspaceId="w" bridge={bridge} />)
  await screen.findByText('Writing…')
  // Writing never locks the form: the reviewed title can be created as it is, and a typed body outlives the draft.
  expect(screen.getByRole('button', { name: 'Create pull request' })).toBeEnabled()
  fireEvent.change(screen.getByLabelText('PR body'), { target: { value: 'Body I typed while it wrote' } })
  resolveFirst({ ok: true, value: { title: 'Drafted title', body: '## What changed\n\n- Draft 1.' } })
  await screen.findByDisplayValue('Drafted title')
  expect(screen.getByLabelText('PR body')).toHaveValue('Body I typed while it wrote')
  expect(draftPullRequestText).toHaveBeenCalledWith({ threadId: 'a', workspaceId: 'w', remote: 'origin', base: 'main' })
  expect(actPullRequest).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }))
  await screen.findByDisplayValue('Second drafted title')
  expect(screen.getByLabelText('PR body')).toHaveValue('## What changed\n\n- Draft 2.')
  fireEvent.change(screen.getByLabelText('PR title'), { target: { value: 'Title I typed' } })
  fireEvent.change(screen.getByLabelText('PR body'), { target: { value: '' } })
  fireEvent.click(screen.getByRole('button', { name: 'Create pull request' }))
  await waitFor(() => expect(actPullRequest).toHaveBeenCalledWith(expect.objectContaining({ action: 'create', title: 'Title I typed', body: '', base: 'main' })))
  expect(draftPullRequestText).toHaveBeenCalledTimes(2)
})
it('leaves the reviewed fields alone and shows no error when nothing is written', async () => {
  const draftPullRequestText = vi.fn(async () => ({ ok: true, value: { title: null, body: null } }))
  const bridge = { reviewPullRequest: vi.fn(async () => ({ ok: true, value: review })), draftPullRequestText, actPullRequest: vi.fn() } as unknown as GitChangesBridge
  render(<GitPullRequest threadId="a" workspaceId="w" bridge={bridge} />)
  await waitFor(() => expect(draftPullRequestText).toHaveBeenCalled())
  await waitFor(() => expect(screen.queryByText('Writing…')).toBeNull())
  expect(screen.getByLabelText('PR title')).toHaveValue('Reviewed title')
  expect(screen.getByLabelText('PR body')).toHaveValue('')
  expect(screen.queryByRole('status')).toBeNull()
})
it('discards a late response after switching working copies', async () => {
  let resolveFirst!: (value: unknown) => void
  const bridge = { reviewPullRequest: vi.fn().mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve })).mockResolvedValue({ ok: true, value: { ...review, workspace: { ...review.workspace, threadId: 'b' }, branch: 'second', title: 'Second branch' } }) } as unknown as GitChangesBridge
  const view = render(<GitPullRequest threadId="a" workspaceId="w" bridge={bridge} />)
  view.rerender(<GitPullRequest threadId="b" workspaceId="w2" bridge={bridge} />)
  await screen.findByDisplayValue('Second branch')
  resolveFirst({ ok: true, value: review }); await waitFor(() => expect(screen.queryByDisplayValue('Reviewed title')).toBeNull())
  expect(screen.getByDisplayValue('Second branch')).toBeInTheDocument()
})
