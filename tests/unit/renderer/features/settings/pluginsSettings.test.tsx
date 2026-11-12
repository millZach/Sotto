import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { PluginsSettings } from '../../../../../src/renderer/src/features/settings/PluginsSettings'
import type { GitHubSignIn, PluginsBridge } from '../../../../../src/shared/plugins'
import { deferred } from '../../../../fixtures/deferred'

afterEach(cleanup)

const answering = (...answers: readonly GitHubSignIn[]): { bridge: PluginsBridge; asked: () => number } => {
  let asked = 0
  return { bridge: { gitHubSignIn: async () => answers[Math.min(asked++, answers.length - 1)]! }, asked: () => asked }
}
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
  const failing: PluginsBridge = { gitHubSignIn: async () => { throw new Error('spawn C:\\Users\\someone\\gh.exe EPERM') } }
  await act(async () => { render(<PluginsSettings bridge={failing} />) })
  expect(row()).toHaveAccessibleName('GitHub Couldn’t check')
  fireEvent.click(row())
  expect(screen.getByText('Sotto couldn’t ask gh who is signed in. Nothing was changed. Press Check again.')).toBeInTheDocument()
  expect(document.body).not.toHaveTextContent('someone')
})

it('keeps focus on Check again while gh is asked, and takes no second press until it answers', async () => {
  const second = deferred<GitHubSignIn>()
  const gitHubSignIn = vi.fn<() => Promise<GitHubSignIn>>().mockResolvedValueOnce({ state: 'signed-out' }).mockReturnValueOnce(second.promise)
  await act(async () => { render(<PluginsSettings bridge={{ gitHubSignIn }} />) })
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
