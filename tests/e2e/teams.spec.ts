import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { expect, test, type Page } from '@playwright/test'

import { withSotto } from '../fixtures/designCaptureProfile'
import { evidenceDirectory } from '../fixtures/evidence'
import { pageBoundProblems } from './support/designCapture'
import { onReleaseTrack } from './support/releaseTrack'
import { captureWindow } from './support/sottoCapture'
import { openPage, openThreads } from './support/sottoLaunch'
import { resizeContentWindow } from './support/sottoWindow'
import { holdOwlSky } from './support/sottoOwl'
import { seedWatcherRoom } from './support/watcherRoom'

/**
 * The Teams tab and a teammate's message on the built app (ADR-0186, ADR-0187), on a seeded link: the tab is Owl's alone, it
 * works from the keyboard, and a row in Watcher's conversation says whose it is. Two real computers are in
 * `docs/verification/teams-link.md`.
 */
const evidence = evidenceDirectory('artifacts/teams-link')
const at = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()
const seed = {
  version: 1, ownName: 'Zach', leftOut: [], servePort: null, loopbackPort: null,
  deskReads: [{ id: 'read-1', linkId: 'link-1', teammate: 'Drake', at: at(1) }],
  links: [{ id: 'link-1', clientId: 'client-1', name: 'Drake', address: 'https://drake-pc.tail9.ts.net:8445/', createdAt: at(60), expiresAt: new Date(Date.now() + 29 * 86_400_000).toISOString(), lastUsedAt: at(5),
    wantedAgainAt: null, theyWantedAgainAt: null, day: new Date().toLocaleDateString('en-CA'), answersToday: 3, refusedToday: 0, recentAnswers: [] }],
  messages: [
    { id: 'row-1', linkId: 'link-1', teammate: 'Drake', direction: 'they-asked', ask: 'working-on', askWords: '', state: 'answered', answer: 'Open now: #2031, iPhone thread list, checks passed.', at: at(30), answeredAt: at(30), afterMessageId: 'teams-21' },
    { id: 'row-2', linkId: 'link-1', teammate: 'Drake', direction: 'we-asked', ask: 'merge-priority', askWords: '#2031 and #2036 are mine.', state: 'answered', answer: 'Open now: #2039, iPhone on the unfolded Duo, checks running. #2039 and #2031 are both iPhone work, so I would merge #2031 first and rebase #2039 after.', at: at(5), answeredAt: at(5), afterMessageId: 'teams-23' },
    { id: 'row-3', linkId: 'link-1', teammate: 'Drake', direction: 'we-asked', ask: 'working-on', askWords: '', state: 'failed', at: at(2), answeredAt: at(2), afterMessageId: 'teams-23' },
  ],
}
const files = { 'team-links.json': JSON.stringify(seed), 'e2e-tailscale.json': JSON.stringify({ state: 'running', dnsName: 'laptop-russh2j5.tail5728ca.ts.net', hostName: 'laptop-russh2j5', serve: 'free' }) }
const options = (appearance: 'dark' | 'light', motion: 'normal' | 'reduced' = 'reduced') => ({ onboardingComplete: true, appearance, scenario: 'design-threads', agents: 'design-threads', motion,
  ...appearance === 'dark' ? { darkTheme: 't3-code' } : { lightTheme: 't3-code' }, files } as const)

async function openRoom(page: Page): Promise<void> {
  await openThreads(page)
  await seedWatcherRoom(page, { watched: ['footer-links'], idPrefix: 'teams' })
  await page.getByRole('tablist', { name: 'Page' }).getByRole('tab', { name: 'Watcher', exact: true }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Watcher' })).toBeVisible()
  await expect(page.locator('#watcher-pane [data-message-id="teams-23"]')).toBeVisible()
}

test.describe('Teams', () => {
  test.describe.configure({ timeout: 5 * 60_000 })

  test('stable shows none of it', async () => {
    await onReleaseTrack('stable', () => withSotto(options('dark'), async ({ page }) => {
      await openRoom(page)
      await expect(page.getByRole('tab', { name: 'Teams', exact: true })).toHaveCount(0)
      await expect(page.locator('.teammate-message')).toHaveCount(0)
      expect(await page.evaluate(() => window.sotto?.teams?.get().then(() => 'answered').catch(() => 'no handler'))).not.toBe('answered')
    }))
  })

  for (const appearance of ['dark', 'light'] as const) {
    test(`a teammate's message shows in the conversation, and the tab holds the link, ${appearance}`, async () => {
      await mkdir(evidence, { recursive: true })
      await onReleaseTrack('owl', () => withSotto(options(appearance), async launched => {
        const { page, app } = launched
        await resizeContentWindow(launched, 1600, 1000)
        await openRoom(page)
        const row = page.locator('#watcher-pane .teammate-message[data-state="answered"][data-direction="we-asked"]')
        await expect(row).toContainText('Drake\'s Watcher')
        await expect(page.locator('#watcher-pane .teammate-message[data-direction="they-asked"]')).toContainText('asked what you are working on')
        await expect(row).toContainText('so I would merge #2031 first')
        await expect(row).toContainText('It changes nothing here.')
        await expect(page.locator('#watcher-pane .teammate-message[data-state="failed"]')).toContainText('did not answer')
        await holdOwlSky(page)
        await captureWindow(app, resolve(evidence, `conversation-${appearance}-1600x1000.png`))

        const tabs = page.getByRole('tablist', { name: 'Watcher\'s room' }), watcherTab = tabs.getByRole('tab', { name: 'Watcher', exact: true }), teamsTab = tabs.getByRole('tab', { name: 'Teams', exact: true })
        await watcherTab.focus()
        await page.keyboard.press('ArrowRight')
        await expect(teamsTab).toBeFocused()
        await expect(teamsTab).toHaveAttribute('aria-selected', 'true')
        await expect(page.getByRole('heading', { level: 2, name: 'Teams' })).toBeVisible()
        const card = page.getByRole('region', { name: 'Link with Drake' })
        await expect(card).toContainText('drake-pc')
        await expect(card).toContainText('3 of 20 today')
        await expect(page.getByText('never says who is online')).toBeVisible()
        await expect(card.getByText('online', { exact: false })).toHaveCount(0)
        for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560]] as const) {
          await resizeContentWindow(launched, width, height)
          await holdOwlSky(page)
          expect(await pageBoundProblems(page), `${width}x${height}`).toEqual([])
          expect(await page.locator('.teams-page').evaluate(node => node.scrollWidth <= node.clientWidth), `no sideways scroll at ${width}x${height}`).toBe(true)
          await captureWindow(app, resolve(evidence, `tab-linked-${appearance}-${width}x${height}.png`))
        }
        await resizeContentWindow(launched, 1280, 800)
        // Pressing Make a code asks the stand-in for its address and shows a code that names it, and nothing else.
        await page.getByRole('button', { name: 'Make a code' }).click()
        const code = page.locator('.teams-code__text')
        await expect(code).toContainText(/^sotto-team:laptop-russh2j5\.tail5728ca\.ts\.net:8445:[A-Z0-9]{8}$/u)
        await captureWindow(app, resolve(evidence, `tab-code-${appearance}-1280x800.png`))
        await page.getByRole('button', { name: 'Cancel code' }).click()
        await expect(code).toHaveCount(0)
        // A project left out stays left out, and takes back its tick.
        const box = page.getByRole('checkbox').first()
        await expect(box).toBeChecked()
        await box.click()
        await expect(box).not.toBeChecked()
        await box.click()
        await expect(box).toBeChecked()
        // Remove asks first, sends nothing, and leaves the forms.
        await card.getByRole('button', { name: 'Remove link' }).click()
        await expect(card).toContainText('Nothing is sent to them.')
        await expect(card.getByRole('button', { name: 'Keep it' })).toBeFocused()
        await page.keyboard.press('Escape')
        await expect(card.getByRole('button', { name: 'Remove link' })).toBeFocused()
        await card.getByRole('button', { name: 'Remove link' }).click()
        await card.getByRole('group').getByRole('button', { name: 'Remove link' }).click()
        await expect(card).toHaveCount(0)
        await expect(page.getByRole('button', { name: 'Make a code' })).toBeVisible()
        await captureWindow(app, resolve(evidence, `tab-no-link-${appearance}-1280x800.png`))
        await teamsTab.focus()
        await page.keyboard.press('ArrowLeft')
        await expect(watcherTab).toHaveAttribute('aria-selected', 'true')
        await expect(page.locator('#watcher-pane [data-message-id="teams-23"]')).toBeVisible()
      }))
    })
  }

  test('Settings says when a link was last used', async () => {
    await onReleaseTrack('owl', () => withSotto(options('dark'), async ({ page }) => {
      await openRoom(page)
      await openPage(page, 'Settings')
      await page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: 'Hosts & phones' }).click()
      const section = page.getByRole('region', { name: 'Team links' })
      await expect(section).toContainText('Drake')
      await expect(section).toContainText('Last used')
    }))
  })

  const deskAnswer = { status: 'desk', desk: { more: 2, threads: [
    { project: 'Sotto', title: 'iPhone on the unfolded Duo', stands: 'working', pullRequests: [{ number: 2158, title: 'One rail pill on the Duo', draft: false, checks: 'passed', checksPassedAt: at(40) }, { number: 2164, title: 'A title with <b>markup</b> in it', draft: false, checks: 'unknown' }] },
    { project: 'Sotto', title: 'Android pairing', stands: 'idle', pullRequests: [{ number: 2161, title: 'Pair an Android phone by code', draft: true, checks: 'unknown' }] },
    { project: 'Client work', title: 'A long title that keeps going so that a narrow desk has to wrap it rather than run it off the side of the window', stands: 'waiting-on-its-owner', pullRequests: [] },
    { project: 'Client work', title: 'Nightly import', stands: 'failed', pullRequests: [{ number: 88, title: 'Retry the import', draft: false, checks: 'failed' }] },
  ] } }

  for (const appearance of ['dark', 'light'] as const) {
    test(`two desks read a teammate's desk only on a press, in ${appearance}`, async () => {
      await onReleaseTrack('owl', () => withSotto(options(appearance), async launched => {
        const { page, app } = launched
        await openRoom(page)
        await page.getByRole('tablist', { name: 'Watcher\'s room' }).getByRole('tab', { name: 'Teams', exact: true }).click()
        // A read of this computer's desk is on the tab, and every kept one is a press away.
        const latest = page.getByRole('region', { name: 'Latest' })
        await expect(latest).toContainText('Drake read your desk.')
        await latest.getByText('Every read of your desk (1)').click()
        await expect(latest.locator('.teams-reads__list li')).toHaveCount(1)
        const open = page.getByRole('button', { name: 'Open two desks' })
        await open.click()
        const desks = page.getByRole('group', { name: 'Two desks with Drake' })
        const back = desks.getByRole('button', { name: 'Back to Teams' })
        await expect(back).toBeFocused()
        // Opening sends nothing, so the desk has nothing of Drake's and the order says why.
        const drake = page.getByRole('region', { name: 'Drake\'s desk' }), order = page.getByRole('region', { name: 'Merge order' })
        await expect(drake).toContainText('Nothing from Drake yet.')
        await expect(order).toContainText('Needs Drake\'s desk first.')
        await expect(page.getByRole('region', { name: 'Your desk' })).toBeVisible()
        await captureWindow(app, resolve(evidence, `desks-not-read-${appearance}-1280x800.png`))
        // The stand-in has no answer yet, as a computer that is off has none.
        const get = desks.getByRole('button', { name: 'Get Drake\'s desk' })
        await get.click()
        await expect(drake.getByRole('alert')).toContainText('Drake\'s computer did not answer. Nothing is waiting to send.')
        await writeFile(join(await app.evaluate(({ app: electron }) => electron.getPath('userData')), 'e2e-team-desk.json'), JSON.stringify(deskAnswer))
        await get.click()
        await expect(drake.getByRole('alert')).toHaveCount(0)
        await expect(drake).toContainText('As of')
        await expect(drake).toContainText('iPhone on the unfolded Duo')
        await expect(drake).toContainText('2 more threads did not fit.')
        // A teammate's title is text, whatever is in it.
        await expect(drake).toContainText('A title with <b>markup</b> in it')
        await expect(drake.locator('b')).toHaveCount(0)
        await expect(order.getByRole('listitem').first()).toContainText('#2158')
        await expect(order.getByRole('listitem').last()).toContainText('draft')
        await expect(order).toContainText('Nothing merges from this')
        await expect(order.getByRole('button')).toHaveCount(0)
        for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560]] as const) {
          await resizeContentWindow(launched, width, height)
          await holdOwlSky(page)
          expect(await pageBoundProblems(page), `${width}x${height}`).toEqual([])
          expect(await page.locator('.teams-page').evaluate(node => node.scrollWidth <= node.clientWidth), `no sideways scroll at ${width}x${height}`).toBe(true)
          await captureWindow(app, resolve(evidence, `desks-read-${appearance}-${width}x${height}.png`))
        }
        await resizeContentWindow(launched, 1280, 800)
        // Escape closes it, and focus goes back to the press that opened it.
        await page.keyboard.press('Escape')
        await expect(desks).toHaveCount(0)
        await expect(open).toBeFocused()
        // What was read stays while Sotto runs.
        await open.click()
        await expect(page.getByRole('region', { name: 'Drake\'s desk' })).toContainText('iPhone on the unfolded Duo')
      }))
    })
  }

  test('a pasted code that names anything but a tailnet address says so and links nothing', async () => {
    await onReleaseTrack('owl', () => withSotto(options('dark'), async ({ page }) => {
      await openRoom(page)
      await page.getByRole('tab', { name: 'Teams', exact: true }).click()
      await page.getByLabel('Got a code from your teammate?').fill('sotto-team:evil.example.com:8445:ABCD2345')
      await page.getByRole('button', { name: 'Link', exact: true }).click()
      await expect(page.getByRole('alert')).toContainText('That is not a Teams code.')
      await expect(page.getByRole('region', { name: 'Link with Drake' })).toHaveCount(1)
    }))
  })
})

