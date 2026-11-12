import React from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { PluginsSettings } from '../../../../../src/renderer/src/features/settings/PluginsSettings'
import type { GitHubSignIn, PluginAccount, PluginAccountResult, PluginsBridge, ShownPluginUse } from '../../../../../src/shared/plugins'
import { deferred } from '../../../../fixtures/deferred'

afterEach(cleanup)

const noUses = async (): Promise<ShownPluginUse[]> => []
/** The account methods of a bridge with no accounts, for tests of GitHub's row. */
const noAccounts = {
  accounts: async (): Promise<PluginAccount[]> => [],
  addAccount: async (): Promise<PluginAccountResult> => ({ ok: false, problem: 'store' }),
  replaceSecret: async (): Promise<PluginAccountResult> => ({ ok: false, problem: 'store' }),
  removeAccount: async (): Promise<PluginAccountResult> => ({ ok: false, problem: 'store' }),
}
const answering = (...answers: readonly GitHubSignIn[]): { bridge: PluginsBridge; asked: () => number } => {
  let asked = 0
  return { bridge: { gitHubSignIn: async () => answers[Math.min(asked++, answers.length - 1)]!, recentUse: noUses, ...noAccounts }, asked: () => asked }
}
const use = (id: number, extra: Partial<ShownPluginUse>): ShownPluginUse => ({ id: `11111111-1111-4111-8111-${String(id).padStart(12, '0')}`, at: '2026-11-12T08:00:00.000Z',
  threadId: `thread-${id}`, plugin: 'github', tool: 'plugin_read', kind: 'issues', outcome: 'done', threadTitle: 'Fix the preview build', ...extra })
const row = (): HTMLElement => screen.getByRole('button', { name: /^GitHub/u })

it('names who gh is signed in as on the folded row, and opens in place to say Sotto stores nothing', async () => {
  await act(async () => { render(<PluginsSettings bridge={answering({ state: 'signed-in', login: 'example-user' }).bridge} />) })
  expect(row()).toHaveAccessibleName('GitHub Signed in as example-user through gh')
  expect(row()).toHaveAttribute('aria-expanded', 'false')
  fireEvent.click(row())
  expect(row()).toHaveAttribute('aria-expanded', 'true')
  expect(document.getElementById(row().getAttribute('aria-controls')!)).toHaveTextContent('Signed in as example-user through gh on this computer.')
  expect(screen.getByText('GitHub uses the gh command’s own sign-in. Sotto stores nothing for it.')).toBeInTheDocument()
  // Find a setting lands on the row by its marker, whatever language the page is in.
  expect(document.querySelector('[data-setting="plugin-github"]')).toContainElement(row())
})

it('closes the open row on Escape from anywhere in it, and gives focus back to its header', async () => {
  await act(async () => { render(<PluginsSettings bridge={answering({ state: 'signed-in', login: 'example-user' }).bridge} />) })
  fireEvent.click(row())
  const again = screen.getByRole('button', { name: 'Check GitHub’s sign-in again' })
  again.focus()
  fireEvent.keyDown(again, { key: 'Escape' })
  expect(row()).toHaveAttribute('aria-expanded', 'false')
  expect(row()).toHaveFocus()
  // A folded row leaves Escape alone, for whatever holds the page.
  expect(fireEvent.keyDown(row(), { key: 'Escape' })).toBe(true)
})

it('shows the sign-in command when gh is signed out, and asks gh again on Check again', async () => {
  const gh = answering({ state: 'signed-out' }, { state: 'signed-in', login: 'example-user' })
  await act(async () => { render(<PluginsSettings bridge={gh.bridge} />) })
  expect(row()).toHaveAccessibleName('GitHub Not signed in')
  fireEvent.click(row())
  expect(screen.getByText('gh auth login')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Copy the gh sign-in command' })).toBeInTheDocument()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Check GitHub’s sign-in again' })) })
  expect(gh.asked()).toBe(2)
  expect(row()).toHaveAccessibleName('GitHub Signed in as example-user through gh')
})

it('says when gh is not installed, and when it could not be asked, without calling either signed out', async () => {
  await act(async () => { render(<PluginsSettings bridge={answering({ state: 'not-installed' }).bridge} />) })
  expect(row()).toHaveAccessibleName('GitHub gh isn’t installed')
  fireEvent.click(row())
  expect(screen.getByText(/isn’t installed on this computer\. Install it from cli\.github\.com/u)).toBeInTheDocument()
  cleanup()
  const failing: PluginsBridge = { gitHubSignIn: async () => { throw new Error('spawn C:\\Users\\someone\\gh.exe EPERM') }, recentUse: noUses, ...noAccounts }
  await act(async () => { render(<PluginsSettings bridge={failing} />) })
  expect(row()).toHaveAccessibleName('GitHub Couldn’t check')
  fireEvent.click(row())
  expect(screen.getByText('Sotto couldn’t ask gh who is signed in. Nothing was changed. Press Check again.')).toBeInTheDocument()
  expect(document.body).not.toHaveTextContent('someone')
})

it('keeps focus on Check again while gh is asked, and takes no second press until it answers', async () => {
  const second = deferred<GitHubSignIn>()
  const gitHubSignIn = vi.fn<() => Promise<GitHubSignIn>>().mockResolvedValueOnce({ state: 'signed-out' }).mockReturnValueOnce(second.promise)
  await act(async () => { render(<PluginsSettings bridge={{ gitHubSignIn, recentUse: noUses, ...noAccounts }} />) })
  fireEvent.click(row())
  const again = screen.getByRole('button', { name: 'Check GitHub’s sign-in again' })
  again.focus()
  fireEvent.click(again)
  expect(again).toHaveAttribute('aria-disabled', 'true')
  expect(again).toHaveFocus()
  fireEvent.click(again)
  expect(gitHubSignIn).toHaveBeenCalledTimes(2)
  await act(async () => { second.resolve({ state: 'signed-in', login: 'example-user' }) })
  expect(again).toHaveAttribute('aria-disabled', 'false')
  expect(row()).toHaveAccessibleName('GitHub Signed in as example-user through gh')
})

it('shows a plugin’s newest uses: what was done and in which thread, and how a use ended', async () => {
  const uses = [
    use(1, {}),
    use(2, { kind: 'pull-requests', outcome: 'failed', threadTitle: 'Review the release' }),
    use(3, { kind: 'other', outcome: 'refused', threadTitle: null }),
  ]
  const bridge: PluginsBridge = { gitHubSignIn: async () => ({ state: 'signed-in', login: 'example-user' }), recentUse: async () => uses, ...noAccounts }
  await act(async () => { render(<PluginsSettings bridge={bridge} />) })
  expect(screen.getByText('A thread’s agent uses a plugin through Sotto’s tools and never holds its secret. So far the tools only read, and reading never asks you.')).toBeInTheDocument()
  fireEvent.click(row())
  const items = within(screen.getByRole('region', { name: 'Recent use' })).getAllByRole('listitem')
  expect(items.map(item => item.querySelector('span')!.textContent)).toEqual([
    'Read issues in “Fix the preview build”',
    'Read pull requests in “Review the release” It failed.',
    'Read from GitHub in a thread that is gone Sotto refused it.',
  ])
  expect(items[0]!.querySelector('time')).toHaveAttribute('datetime', '2026-11-12T08:00:00.000Z')
  expect(screen.getByText('Sotto records what was done and by which thread, never what was read.')).toBeInTheDocument()
})

it('says when no thread has used a plugin yet, shows only the newest five, and reads the uses again on Check again', async () => {
  let asked = 0
  const many = Array.from({ length: 7 }, (_, index) => use(index + 1, { threadTitle: `Thread ${index + 1}` }))
  const bridge: PluginsBridge = { gitHubSignIn: async () => ({ state: 'signed-in', login: 'example-user' }), recentUse: async () => asked++ === 0 ? [] : many, ...noAccounts }
  await act(async () => { render(<PluginsSettings bridge={bridge} />) })
  fireEvent.click(row())
  expect(screen.getByText('No thread has used GitHub yet.')).toBeInTheDocument()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Check GitHub’s sign-in again' })) })
  expect(within(screen.getByRole('region', { name: 'Recent use' })).getAllByRole('listitem')).toHaveLength(5)
})

it('leaves Recent use out when the record could not be read, rather than saying nothing was used', async () => {
  const bridge: PluginsBridge = { gitHubSignIn: async () => ({ state: 'signed-in', login: 'example-user' }), recentUse: async () => { throw new Error('EACCES') }, ...noAccounts }
  await act(async () => { render(<PluginsSettings bridge={bridge} />) })
  fireEvent.click(row())
  expect(screen.queryByRole('region', { name: 'Recent use' })).toBeNull()
  expect(screen.queryByText('No thread has used GitHub yet.')).toBeNull()
})

/** A made-up account and a made-up token: nothing here is a real credential. */
const work: PluginAccount = { id: '22222222-2222-4222-8222-000000000001', plugin: 'vercel', name: 'Work', savedAt: '2026-11-12T08:00:00.000Z', signedInAs: 'example-user' }
const TOKEN = 'made-up-vercel-token'
const vercelRow = (): HTMLElement => screen.getByRole('button', { name: /^Vercel/u })
function vercelBridge(start: readonly PluginAccount[], overrides: Partial<PluginsBridge> = {}): PluginsBridge {
  return { gitHubSignIn: async () => ({ state: 'signed-in', login: 'example-user' }), recentUse: noUses, ...noAccounts, accounts: async () => [...start], ...overrides }
}

it('adds a Vercel account from its row: the token goes to main once and is not left in the page', async () => {
  const addAccount = vi.fn(async (): Promise<PluginAccountResult> => ({ ok: true, accounts: [work] }))
  await act(async () => { render(<PluginsSettings bridge={vercelBridge([], { addAccount })} />) })
  expect(vercelRow()).toHaveAccessibleName('Vercel Not added')
  fireEvent.click(vercelRow())
  fireEvent.click(screen.getByRole('button', { name: 'Add a Vercel account' }))
  const form = screen.getByRole('form', { name: 'Add a Vercel account' })
  expect(within(form).getByLabelText('Name')).toHaveFocus()
  const submit = within(form).getByRole('button', { name: 'Add account' })
  expect(submit).toHaveAttribute('aria-disabled', 'true')
  fireEvent.change(within(form).getByLabelText('Name'), { target: { value: ' Work ' } })
  const token = within(form).getByLabelText('Token')
  expect(token).toHaveAttribute('type', 'password')
  fireEvent.change(token, { target: { value: TOKEN } })
  await act(async () => { fireEvent.click(submit) })
  expect(addAccount).toHaveBeenCalledWith({ plugin: 'vercel', name: 'Work', secret: TOKEN })
  expect(screen.queryByRole('form', { name: 'Add a Vercel account' })).toBeNull()
  expect(vercelRow()).toHaveAccessibleName('Vercel Work')
  const card = screen.getByRole('region', { name: 'Vercel account Work' })
  expect(card).toHaveTextContent(/Signed in to Vercel as example-user\. Token saved November 1[12]\./u)
  expect(document.body.innerHTML).not.toContain(TOKEN)
})

it('says what happened when Vercel refuses a token, that nothing was saved, and what to do', async () => {
  const addAccount = vi.fn(async (): Promise<PluginAccountResult> => ({ ok: false, problem: 'refused' }))
  await act(async () => { render(<PluginsSettings bridge={vercelBridge([], { addAccount })} />) })
  fireEvent.click(vercelRow())
  fireEvent.click(screen.getByRole('button', { name: 'Add a Vercel account' }))
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Work' } })
  fireEvent.change(screen.getByLabelText('Token'), { target: { value: TOKEN } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Add account' })) })
  expect(screen.getByRole('alert')).toHaveTextContent('Vercel did not accept this token. Nothing was saved. Make a new token at vercel.com/account/tokens and paste it here.')
  // The form stays, so the name need not be typed again.
  expect(screen.getByLabelText('Name')).toHaveValue('Work')
  // Escape cancels the form without closing the row, and focus goes back to the button that opened it.
  fireEvent.keyDown(screen.getByLabelText('Name'), { key: 'Escape' })
  expect(screen.queryByRole('form', { name: 'Add a Vercel account' })).toBeNull()
  expect(vercelRow()).toHaveAttribute('aria-expanded', 'true')
})

it('replaces an account’s token only on its own form, and keeps the saved one when the new one is refused', async () => {
  let answer: PluginAccountResult = { ok: false, problem: 'refused' }
  const replaceSecret = vi.fn(async (): Promise<PluginAccountResult> => answer)
  await act(async () => { render(<PluginsSettings bridge={vercelBridge([work], { replaceSecret })} />) })
  fireEvent.click(vercelRow())
  fireEvent.click(screen.getByRole('button', { name: 'Replace the token for Work' }))
  fireEvent.change(screen.getByLabelText('New token'), { target: { value: TOKEN } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save token' })) })
  expect(replaceSecret).toHaveBeenCalledWith({ id: work.id, secret: TOKEN })
  expect(screen.getByRole('alert')).toHaveTextContent('Vercel did not accept this token. The token already saved was kept. Make a new token at vercel.com/account/tokens and paste it here.')
  expect(screen.getByLabelText('New token')).toHaveValue('')
  answer = { ok: true, accounts: [{ ...work, savedAt: '2026-11-13T08:00:00.000Z' }] }
  fireEvent.change(screen.getByLabelText('New token'), { target: { value: TOKEN } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save token' })) })
  expect(screen.queryByLabelText('New token')).toBeNull()
  expect(screen.queryByRole('alert')).toBeNull()
  expect(document.body.innerHTML).not.toContain(TOKEN)
})

it('asks before removing an account, saying what is deleted and that nothing changes at Vercel', async () => {
  const removeAccount = vi.fn(async (): Promise<PluginAccountResult> => ({ ok: true, accounts: [] }))
  await act(async () => { render(<PluginsSettings bridge={vercelBridge([work], { removeAccount })} />) })
  fireEvent.click(vercelRow())
  fireEvent.click(screen.getByRole('button', { name: 'Remove the Vercel account Work' }))
  const asking = screen.getByRole('group', { name: 'Remove the Vercel account Work' })
  expect(asking).toHaveTextContent('Remove Work? Its token is deleted from this computer, and threads lose the account at once. Nothing changes at Vercel.')
  expect(removeAccount).not.toHaveBeenCalled()
  // Keep it leaves the account as it was.
  fireEvent.click(within(asking).getByRole('button', { name: 'Keep it' }))
  expect(screen.getByRole('region', { name: 'Vercel account Work' })).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Remove the Vercel account Work' }))
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Remove account' })) })
  expect(removeAccount).toHaveBeenCalledWith({ id: work.id })
  expect(screen.queryByRole('region', { name: 'Vercel account Work' })).toBeNull()
  expect(vercelRow()).toHaveAccessibleName('Vercel Not added')
})

it('lists each account’s own recent use, and names several accounts on the folded row', async () => {
  const personal: PluginAccount = { ...work, id: '22222222-2222-4222-8222-000000000002', name: 'Personal', signedInAs: null }
  const uses = [use(1, { plugin: 'vercel', accountId: work.id, kind: 'deployments' }), use(2, { plugin: 'vercel', accountId: personal.id, kind: 'logs', threadTitle: 'Fix the preview build' })]
  await act(async () => { render(<PluginsSettings bridge={vercelBridge([work, personal], { recentUse: async () => uses })} />) })
  expect(vercelRow()).toHaveAccessibleName('Vercel 2 accounts: Work, Personal')
  fireEvent.click(vercelRow())
  expect(within(screen.getByRole('region', { name: 'Vercel account Work' })).getAllByRole('listitem').map(item => item.querySelector('span')!.textContent)).toEqual(['Read deployments in “Fix the preview build”'])
  expect(within(screen.getByRole('region', { name: 'Vercel account Personal' })).getAllByRole('listitem').map(item => item.querySelector('span')!.textContent)).toEqual(['Read a build log in “Fix the preview build”'])
  expect(screen.getByRole('button', { name: 'Add another Vercel account' })).toBeInTheDocument()
})
