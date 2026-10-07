import { mkdir, rename, rmdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { closeSotto, launchSotto, openPage } from './support/sottoLaunch'

test('Phones and Hosts explain real failed saves beside the affected control and allow keyboard retry', async () => {
  test.setTimeout(180_000)
  const launched = await launchSotto()
  const { page, userData } = launched
  const settingsPath = join(userData, 'settings.json')
  const backupPath = join(userData, 'settings-save-feedback-backup.json')
  let blocked = false
  const block = async (): Promise<void> => {
    await rename(settingsPath, backupPath)
    await mkdir(settingsPath)
    blocked = true
  }
  const unblock = async (): Promise<void> => {
    await rmdir(settingsPath)
    await rename(backupPath, settingsPath)
    blocked = false
  }
  try {
    await writeFile(join(userData, 'e2e-tailscale.json'), JSON.stringify({ state: 'not-running' }))
    await page.evaluate(() => window.sotto!.updateSettings({ onboardingComplete: true, reducedMotion: 'on' }))
    await page.reload()
    await openPage(page, 'Settings')
    for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560]]) {
      await launched.app.evaluate(({ BrowserWindow }, size) => {
        BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'))!.setContentSize(size.width!, size.height!)
      }, { width, height })
      for (const appearance of ['dark', 'light'] as const) {
        await page.evaluate(appearance => window.sotto!.updateSettings({ appearance, phoneAccess: false, phoneAccessName: '', localHostEnabled: true }), appearance)
        await page.getByRole('tab', { name: 'Phones', exact: true }).click()
        const toggle = page.getByRole('switch', { name: 'Let phones connect' })
        await block()
        await toggle.focus()
        await page.keyboard.press('Space')
        await expect(page.locator('.phones-switch').getByRole('alert')).toHaveText('Phone access could not be saved. Nothing was changed. Try again.')
        await expect(toggle).toHaveAttribute('aria-checked', 'false')
        await page.screenshot({ path: test.info().outputPath(`phone-access-${width}-${appearance}.png`), animations: 'disabled' })
        await unblock()
        await page.keyboard.press('Space')
        await expect(page.locator('.phones-switch').getByRole('alert')).toHaveCount(0)
        await expect(toggle).toHaveAttribute('aria-checked', 'true')

        const name = page.getByRole('textbox', { name: 'Name on phones' })
        await block()
        await name.fill('My computer')
        await page.keyboard.press('Enter')
        await expect(page.locator('.phones-name .tt-field__error')).toHaveText('The name could not be saved. Phones still use the previous name. Try again.')
        await expect(name).toHaveValue('My computer')
        await unblock()
        await page.keyboard.press('Enter')
        await expect(page.locator('.phones-name .tt-field__error')).toHaveCount(0)
        expect((await page.evaluate(() => window.sotto!.getSettings())).phoneAccessName).toBe('My computer')

        await page.getByRole('tab', { name: 'Hosts', exact: true }).click()
        const host = page.getByRole('switch', { name: 'Run the local host' })
        await block()
        await host.focus()
        await page.keyboard.press('Space')
        await expect(page.locator('.hosts-local').getByRole('alert')).toHaveText('The local host setting could not be saved. Nothing was changed. Try again.')
        await expect(host).toHaveAttribute('aria-checked', 'true')
        expect(await page.evaluate(() => ({
          pageOverflow: document.documentElement.scrollWidth > innerWidth,
          formOverflow: document.querySelector('.settings-scroll')!.scrollWidth > document.querySelector('.settings-scroll')!.clientWidth + 1,
        }))).toEqual({ pageOverflow: false, formOverflow: false })
        await page.screenshot({ path: test.info().outputPath(`local-host-${width}-${appearance}.png`), animations: 'disabled' })
        await unblock()
        await page.keyboard.press('Space')
        await expect(page.locator('.hosts-local').getByRole('alert')).toHaveCount(0)
        await expect(host).toHaveAttribute('aria-checked', 'false')
      }
    }
  } finally {
    if (blocked) await unblock()
    await closeSotto(launched)
  }
})
