import { ownedE2EProfile, removeOwnedE2EProfile } from './support/e2eProfile'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type Locator } from '@playwright/test'
import { SocketHostService } from '../../src/main/agents/socketHostService'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import { closeSotto, launchSotto, openPage } from './support/sottoLaunch'

/**
 * Settings > Phones in the built app, through every state the prototype drew: off, Tailscale not
 * running, ports 8443 and 10000 taken, ready, a pairing code, and a paired phone. Tailscale is the end-to-end
 * stand-in in the profile (`e2e-tailscale.json`), never the machine's own; the phone is this test,
 * pairing over the listener's loopback port the way Tailscale Serve would carry it.
 */
test('Phones: sets up through the checklist, pairs a phone with a code, and closes when turned off', async () => {
  test.setTimeout(240_000)
  const profile = (await ownedE2EProfile({ prefix: 'sotto-e2e-phones-' })).directory
  const tailscale = (fixture: Record<string, unknown>) => writeFile(join(profile, 'e2e-tailscale.json'), JSON.stringify(fixture))
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, onboardingComplete: true, reducedMotion: 'on' }))
  await tailscale({ state: 'not-running' })
  const launched = await launchSotto('success', profile)
  const { page } = launched
  const errors: string[] = []
  const phones: SocketHostService[] = []
  page.on('pageerror', error => errors.push(error.message))
  /** Every size and both halves, with what the state is about scrolled into view the way focus would. */
  const capture = async (name: string, subject?: Locator): Promise<void> => {
    for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560]]) {
      await launched.app.evaluate(({ BrowserWindow }, size) => {
        BrowserWindow.getAllWindows().find(item => item.webContents.getURL().endsWith('/index.html'))!.setContentSize(size.width!, size.height!)
      }, { width, height })
      for (const appearance of ['dark', 'light'] as const) {
        await page.evaluate(async appearance => window.sotto!.updateSettings({ appearance }), appearance)
        await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
        await subject?.scrollIntoViewIfNeeded()
        expect(await page.evaluate(() => ({ page: document.documentElement.scrollWidth > innerWidth,
          form: document.querySelector('.settings-scroll')!.scrollWidth > document.querySelector('.settings-scroll')!.clientWidth + 1 }))).toEqual({ page: false, form: false })
        await page.screenshot({ path: test.info().outputPath(`phones-${name}-${width}-${appearance}.png`), animations: 'disabled' })
      }
    }
  }
  const steps = page.getByRole('list', { name: 'Setup' })
  const step = (name: string) => steps.getByRole('listitem').filter({ hasText: name })
  try {
    await openPage(page, 'Settings')
    const tabs = page.getByRole('tablist', { name: 'Settings sections' })
    await expect(tabs.getByRole('tab')).toHaveText(['Dictation', 'Transcription', 'Cleanup', 'Providers', 'Hosts', 'Phones', 'Cloud iPhone', 'Agents', 'Output', 'Appearance', 'Application', 'Git'])
    // The keyboard reaches Phones from Hosts with one arrow.
    await tabs.getByRole('tab', { name: 'Hosts', exact: true }).click()
    await page.keyboard.press('ArrowDown')
    await expect(tabs.getByRole('tab', { name: 'Phones', exact: true })).toBeFocused()
    await expect(page.getByRole('heading', { name: 'Phones', exact: true })).toBeVisible()
    const toggle = page.getByRole('switch', { name: 'Let phones connect' })
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await expect(step('Tailscale is running')).toContainText('Checked when you turn this on.')
    await expect(page.getByRole('button', { name: 'Show a pairing code' })).toBeDisabled()
    await capture('off')

    // Tailscale not running: the first step fails in plain words and nothing else is tried.
    await toggle.click()
    await expect(step('Tailscale is running')).toContainText('Tailscale isn’t running on this computer, or isn’t signed in.')
    await expect(step('Tailscale Serve on port 8443')).toContainText('Waits for Tailscale.')
    await capture('tailscale', step('Tailscale is running'))

    // Other apps on 8443 and 10000: left alone, and said so.
    await tailscale({ state: 'running', serve: 'both-taken' })
    await step('Tailscale is running').getByRole('button', { name: 'Try again' }).click()
    await expect(step('Tailscale Serve on port 8443')).toContainText('Other apps already use ports 8443 and 10000 in Tailscale Serve on this computer. Sotto left those settings alone')
    await capture('port', step('Tailscale Serve on port 8443'))

    // Ready: every step done, the address to copy.
    await tailscale({ state: 'running' })
    await step('Tailscale Serve on port 8443').getByRole('button', { name: 'Try again' }).click()
    await expect(step('Address phones use')).toContainText('https://laptop-russh2j5.tail5728ca.ts.net:8443')
    await expect(step('Tailscale is running')).toContainText('Signed in. This computer is laptop-russh2j5 on your tailnet.')
    const port = (JSON.parse(await readFile(join(profile, 'phone-access.json'), 'utf8')) as { port: number }).port
    const base = `http://127.0.0.1:${port}`
    expect(await (await fetch(base + '/v1/health')).json()).toMatchObject({ v: 1, status: 'ready', name: 'laptop-russh2j5' })
    expect((await fetch(base + '/v1/admin/pairing-code', { method: 'POST' })).status).toBe(400)
    await capture('ready')

    // A code: shown big with its countdown, focused, and Escape withdraws it.
    await page.getByRole('button', { name: 'Show a pairing code' }).click()
    const codeBox = page.getByRole('group', { name: 'Pairing code' })
    await expect(codeBox).toBeFocused()
    await expect(codeBox).toContainText(/Works once\. Expires in [45]:\d\d/u)
    await page.keyboard.press('Escape')
    await expect(codeBox).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Show a pairing code' })).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(codeBox).toBeVisible()
    await capture('code', codeBox)

    // The phone redeems it: the code closes and the phone is listed, connected once it opens a socket.
    const code = (await codeBox.locator('.phones-code__value').textContent())!
    expect(code).toMatch(/^[2-9A-Z]{8}$/u)
    expect(await codeBox.ariaSnapshot()).toContain(`Pairing code ${[...code].join(' ')}`)
    await expect(codeBox.locator('.phones-code__value')).toHaveAttribute('aria-hidden', 'true')
    await expect(codeBox.locator('[role="img"], [role="status"], [aria-live]')).toHaveCount(0)
    const paired = await SocketHostService.pair(base, code, 'Zach’s iPhone')
    await expect(codeBox).toHaveCount(0)
    const row = page.getByRole('region', { name: 'Zach’s iPhone' })
    const pairedAt = await page.evaluate(async () => (await window.sotto!.phones!.get()).phones.find(phone => phone.name === 'Zach’s iPhone')!.pairedAt)
    await expect(row).toContainText(`Paired ${new Date(pairedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`)
    await expect(row).toContainText('Not connected')
    await expect(row.getByRole('switch', { name: 'Can answer: let Zach’s iPhone answer questions and permissions' })).toHaveAttribute('aria-checked', 'false')
    const phone = new SocketHostService({ url: base, token: paired.token, expectedHostId: paired.hostId })
    phones.push(phone)
    expect((await phone.connect()).capabilities.mayAnswer).toBe(false)
    await expect(row).toContainText('· Connected')
    await capture('paired', row)

    // Can answer writes the owner's grant; Remove asks first.
    await row.getByRole('switch', { name: 'Can answer: let Zach’s iPhone answer questions and permissions' }).click()
    await expect(row).toContainText('Reads and replies. Can answer questions and permissions.')
    expect((await phone.connect()).capabilities.mayAnswer).toBe(true)
    await row.getByRole('button', { name: 'Remove Zach’s iPhone' }).click()
    const dialog = page.getByRole('dialog', { name: 'Remove Zach’s iPhone?' })
    await expect(dialog.getByRole('button', { name: 'Keep phone' })).toBeFocused()
    await page.screenshot({ path: test.info().outputPath('phones-remove-1280-light.png'), animations: 'disabled' })
    await dialog.getByRole('button', { name: 'Remove phone' }).click()
    await expect(row).toHaveCount(0)
    await expect(phone.connect()).rejects.toMatchObject({ code: 'unauthenticated' })

    // Off: the Serve setting goes and the listener closes.
    await toggle.click()
    await expect(step('Address phones use')).toContainText('Checked when you turn this on.')
    await expect.poll(() => fetch(base + '/v1/health').then(() => 'open', () => 'closed')).toBe('closed')
    expect(JSON.parse(await readFile(join(profile, 'phone-access.json'), 'utf8'))).toEqual({ port, mapped: false })
    expect(errors).toEqual([])
  } finally {
    await Promise.all(phones.map(phone => phone.close()))
    await closeSotto(launched)
    await removeOwnedE2EProfile(profile)
  }
})
