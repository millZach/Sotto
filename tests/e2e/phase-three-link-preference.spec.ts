import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { requireOwnedE2EProfile } from '../../scripts/e2e-profile-policy.mjs'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import { closeSotto, launchSotto, type LaunchedSotto } from './support/sottoLaunch'

// Only the OS browser activation is recorded. Settings persistence, link routing,
// the thread's working copy and its embedded WebContentsView are production paths.
async function recordExternalLinks(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ shell }) => {
    const state = globalThis as unknown as { preferenceExternalLinks: string[] }
    state.preferenceExternalLinks = []
    shell.openExternal = async url => { state.preferenceExternalLinks.push(url) }
  })
}

async function openThreadWithLink(page: Page, url: string): Promise<void> {
  await page.evaluate(async target => {
    await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true, speak: false } })
    await window.sotto!.agents!.command({ type: 'connect' })
    await window.sottoE2E!.agentEvent!({ type: 'ready', threadId: 'workshop', text: `[Preference preview](${target})` })
  }, url)
  await page.getByRole('link', { name: 'Threads', exact: true }).click()
  await page.getByRole('button', { name: 'Workshop', exact: true }).first().click()
}

test('the thread link destination saves through Settings and controls ordinary clicks after restart', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'sotto-e2e-link-preference-'))
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, onboardingComplete: true }))
  const server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html')
    response.end('<!doctype html><title>Preference preview</title><h1>Saved destination</h1>')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No local preview port')
  const url = `http://127.0.0.1:${address.port}/`
  let launched: LaunchedSotto | null = null
  try {
    launched = await launchSotto('success', profile)
    await recordExternalLinks(launched.app)
    await openThreadWithLink(launched.page, url)
    await launched.page.getByRole('link', { name: 'Preference preview', exact: true }).click()
    await expect.poll(() => launched!.app.evaluate(() => (globalThis as unknown as { preferenceExternalLinks: string[] }).preferenceExternalLinks)).toEqual([url])
    const listing = await launched.page.evaluate(() => window.sotto!.browser!.list({ threadId: 'workshop' }))
    expect(listing.ok && listing.value.pages).toEqual([])

    await launched.page.getByRole('link', { name: 'Settings', exact: true }).click()
    const links = launched.page.getByRole('radiogroup', { name: 'Web links in threads', exact: true })
    await links.getByRole('radio', { name: 'Sotto browser', exact: true }).click()
    await expect.poll(() => launched!.page.evaluate(async () => (await window.sotto!.getSettings()).webLinkDestination)).toBe('embedded')
    await closeSotto(launched)
    launched = null
    expect(JSON.parse(await readFile(join(profile, 'settings.json'), 'utf8')).webLinkDestination).toBe('embedded')

    launched = await launchSotto('success', profile)
    await recordExternalLinks(launched.app)
    expect(await launched.page.evaluate(async () => (await window.sotto!.getSettings()).webLinkDestination)).toBe('embedded')
    await openThreadWithLink(launched.page, url)
    await launched.page.getByRole('link', { name: 'Preference preview', exact: true }).click()
    const tools = launched.page.getByRole('complementary', { name: 'Tools', exact: true })
    await expect(tools.getByRole('tab', { name: 'Browser', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect.poll(async () => {
      const result = await launched!.page.evaluate(() => window.sotto!.browser!.list({ threadId: 'workshop' }))
      return result.ok ? result.value.pages.map(page => ({ url: page.url, status: page.status })) : result.error.code
    }).toEqual([{ url, status: 'ready' }])
    await expect.poll(() => launched!.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'))!.contentView.children.length)).toBe(1)
    expect(await launched.app.evaluate(() => (globalThis as unknown as { preferenceExternalLinks: string[] }).preferenceExternalLinks)).toEqual([])
  } finally {
    if (launched) await closeSotto(launched)
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(requireOwnedE2EProfile(profile), { recursive: true, force: true })
  }
})
