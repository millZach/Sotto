/* PROTOTYPE, throwaway: captures every theme-picker variant. Build with VITE_THEME_PROTOTYPE=1, run with SOTTO_THEME_PROTOTYPE=1. */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { test } from '@playwright/test'

import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import { closeSotto, launchSotto, openPage, resizeWindow } from './support/sottoLaunch'

const out = resolve(process.cwd(), 'artifacts/prototype-theme-picker')

test.skip(process.env.SOTTO_THEME_PROTOTYPE !== '1', 'prototype captures are opt-in')

for (const appearance of ['dark', 'light'] as const) {
  test(`theme picker variants, ${appearance}`, async () => {
    test.setTimeout(240_000)
    await mkdir(out, { recursive: true })
    const profile = await mkdtemp(join(tmpdir(), 'sotto-e2e-proto-'))
    await writeFile(join(profile, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, onboardingComplete: true, appearance }), 'utf8')
    const launched = await launchSotto('success', profile)
    try {
      const { page } = launched
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await resizeWindow(launched, Number(process.env.PROTO_W ?? 1600), Number(process.env.PROTO_H ?? 1000))
      await openPage(page, 'Settings')
      for (const palettes of ['today', 'new'] as const) {
        for (const variant of (process.env.PROTO_VARIANTS ?? 'current,spheres,rooms,halves,index').split(',')) {
          await page.evaluate(state => { sessionStorage.setItem('sotto.prototype.theme-picker', JSON.stringify(state)) }, { variant, palettes })
          await page.reload()
          await page.waitForLoadState('domcontentloaded')
          await openPage(page, 'Settings')
          await page.locator('#tab-settings-appearance').click()
          await page.waitForSelector('#settings-appearance')
          await page.locator('#settings-appearance').scrollIntoViewIfNeeded()
          await page.evaluate(() => document.querySelector('#settings-appearance')?.scrollIntoView({ block: 'start' }))
          await page.mouse.move(0, 0)
          await page.waitForTimeout(300)
          await page.screenshot({ path: join(out, `${variant}-${palettes}-${appearance}.png`), animations: 'disabled' })
          await page.locator('#settings-appearance').screenshot({ path: join(out, `${variant}-${palettes}-${appearance}-full.png`), animations: 'disabled' })
        }
      }
    } finally {
      await closeSotto(launched)
    }
  })
}
