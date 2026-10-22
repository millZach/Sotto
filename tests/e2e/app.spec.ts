import { spawn } from 'node:child_process'
import { mkdir, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'

import { expect, test, type ElectronApplication, type Page } from '@playwright/test'

import {
  type E2ESnapshot,
  type SottoE2EBridge,
} from '../../src/shared/e2e'
import type { SottoBridge } from '../../src/shared/contracts'
import { TRANSCRIPTION_KEPT_DETAIL } from '../../src/shared/dictation'
import { DETERMINISTIC_TRANSCRIPT, PRESERVED_CLIPBOARD_TEXT } from '../fixtures/fakeTranscription'
import { evidenceDirectory } from '../fixtures/evidence'
import { closeSotto, e2eEnvironment, finishFirstRunSetupFrom, launchSotto, openPage, reachFirstRunStep } from './support/sottoLaunch'
import { ownedE2EProfile, removeOwnedE2EProfile } from './support/e2eProfile'
import { resizeContentWindow } from './support/sottoWindow'

const evidence = evidenceDirectory('artifacts/review-quit-drain')
const recordEvidence = evidenceDirectory('artifacts/dictation-record')

/** Onboarding, and then the Dictate page the dictation tests work on. */
async function completeOnboarding(page: Page): Promise<void> {
  await finishFirstRunSetupFrom(page, 'welcome', { microphone: 'test' })
  await openPage(page, 'Dictate')
  await expect(page.getByRole('heading', { name: /ready when you are/i })).toBeVisible()
}

async function dictateWithButton(page: Page): Promise<void> {
  await page.getByRole('button', { name: /start dictation/i }).click()
  await page.getByRole('button', { name: 'Stop', exact: true }).click()
}

async function snapshot(page: Page): Promise<E2ESnapshot> {
  const value = await page.evaluate(() =>
    (globalThis as unknown as { sottoE2E?: SottoE2EBridge }).sottoE2E?.snapshot(),
  )
  if (value === undefined) throw new Error('E2E bridge unavailable')
  return value
}

async function closeMainToTray(app: ElectronApplication, page: Page): Promise<void> {
  if (process.platform === 'win32') {
    await page.getByRole('button', { name: 'Close Sotto to tray' }).click()
  } else {
    // Only Windows draws a close button. macOS closes through its traffic light and Linux through the
    // compositor (Super+W), and both arrive as the window's native close event.
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'))!.close()
    })
  }
}

interface NativeRectangle {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

interface NativeWidgetGeometry {
  readonly contentBounds: NativeRectangle
  readonly workArea: NativeRectangle
}

async function nativeWidgetGeometry(
  app: ElectronApplication,
): Promise<NativeWidgetGeometry | null> {
  return app.evaluate(({ BrowserWindow, screen }) => {
    const widget = BrowserWindow.getAllWindows().find((candidate) =>
      candidate.webContents.getURL().endsWith('/widget.html'),
    )
    if (widget === undefined) return null
    const bounds = widget.getBounds()
    const workArea = screen.getDisplayNearestPoint({
      x: bounds.x + bounds.width / 2,
      y: bounds.y + bounds.height / 2,
    }).workArea
    return { contentBounds: widget.getContentBounds(), workArea }
  })
}

async function sampleNativeWidgetContentBounds(
  app: ElectronApplication,
): Promise<readonly NativeRectangle[]> {
  return app.evaluate(async ({ BrowserWindow }) => {
    const widget = BrowserWindow.getAllWindows().find((candidate) =>
      candidate.webContents.getURL().endsWith('/widget.html'),
    )
    if (widget === undefined) return []
    const samples = []
    for (let index = 0; index < 40; index += 1) {
      samples.push(widget.getContentBounds())
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    return samples
  })
}

async function nativeWidgetVisible(app: ElectronApplication): Promise<boolean | null> {
  return app.evaluate(({ BrowserWindow }) => {
    const widget = BrowserWindow.getAllWindows().find((candidate) =>
      candidate.webContents.getURL().endsWith('/widget.html'),
    )
    return widget?.isVisible() ?? null
  })
}

async function triggerShortcut(page: Page): Promise<void> {
  await page.evaluate(() =>
    (globalThis as unknown as { sottoE2E?: SottoE2EBridge }).sottoE2E?.triggerShortcut(),
  )
}

test('onboards, dictates through the registered shortcut, pastes, and records local history', async () => {
  const launched = await launchSotto()
  try {
    await reachFirstRunStep(launched.page, 'shortcut', { microphone: 'test' })
    const pasteTarget = launched.page.getByLabel('Paste test')
    await pasteTarget.focus()

    await triggerShortcut(launched.page)
    const widget = launched.app.windows().find((candidate) => candidate.url().endsWith('/widget.html'))
    if (widget === undefined) throw new Error('Widget window unavailable')
    await expect(widget.locator('.widget-shell[data-status="listening"]')).toBeVisible()
    await triggerShortcut(launched.page)

    await expect(pasteTarget).toHaveValue(DETERMINISTIC_TRANSCRIPT)
    await expect(widget.getByText('Pasted', { exact: true })).toBeVisible()
    await expect.poll(() => snapshot(launched.page)).toMatchObject({
      clipboardText: DETERMINISTIC_TRANSCRIPT,
      pasteAttempts: 1,
    })

    await finishFirstRunSetupFrom(launched.page, 'shortcut', { microphone: 'test' })
    // Transcripts live in the Dictate room's Journal (#1293).
    await openPage(launched.page, 'Dictate')
    await expect(launched.page.getByText(DETERMINISTIC_TRANSCRIPT).first()).toBeVisible()
  } finally {
    await closeSotto(launched)
  }
})

test('keeps history disabled without blocking dictation', async () => {
  const launched = await launchSotto('history-disabled')
  try {
    await completeOnboarding(launched.page)
    await launched.page.getByRole('link', { name: 'Settings' }).click()
    await launched.page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: 'Application', exact: true }).click()
    await launched.page.getByRole('switch', { name: 'Keep local history' }).click()
    await expect(launched.page.getByText('Setting saved.')).toBeVisible()
    await launched.page.getByRole('tab', { name: 'Dictate', exact: true }).click()
    await dictateWithButton(launched.page)
    await expect(launched.page.getByRole('heading', { name: /^Pasted( into .+)?\.$/ })).toBeVisible()
    await expect(launched.page.getByText('History is off. New dictations keep their numbers only.', { exact: true })).toBeVisible()
    await expect(launched.page.locator('.journal-entry')).toHaveCount(0)
  } finally {
    await closeSotto(launched)
  }
})

test('keeps a dictation record with history on and off, and lists older transcripts after a restart with it off', async () => {
  const directory = (await ownedE2EProfile({ prefix: 'sotto-e2e-' })).directory
  let launched = await launchSotto('success', directory)
  const records = async (): Promise<{ id: string; words: number; durationMs: number; app?: string }[]> =>
    (await readFile(join(directory, 'dictation-records.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as never)
  try {
    await completeOnboarding(launched.page)
    await dictateWithButton(launched.page)
    await expect(launched.page.getByRole('heading', { name: /^Pasted( into .+)?\.$/ })).toBeVisible()
    await launched.page.evaluate(async () => window.sotto!.updateSettings({ historyEnabled: false }))
    await dictateWithButton(launched.page)
    await expect(launched.page.getByRole('heading', { name: /^Pasted( into .+)?\.$/ })).toBeVisible()

    // Both dictations keep their numbers and the app Sotto delivered them into; only the first kept its text.
    await expect.poll(async () => (await records()).length).toBe(2)
    const kept = await records()
    for (const record of kept) {
      expect(record.app).toBe('Sotto')
      expect(record.words).toBeGreaterThan(0)
    }
    expect(await readFile(join(directory, 'dictation-records.jsonl'), 'utf8')).not.toContain(DETERMINISTIC_TRANSCRIPT.split(' ')[1]!)
    const saved = JSON.parse(await readFile(join(directory, 'history.json'), 'utf8')) as { id: string; app?: string }[]
    expect(saved).toHaveLength(1)
    expect(saved[0]!.app).toBe('Sotto')
    expect(await launched.page.evaluate(async () => (await window.sotto!.listDictationRecords()).length)).toBe(2)
    await closeSotto(launched)

    launched = await launchSotto('success', directory)
    await openPage(launched.page, 'Dictate')
    await expect(launched.page.getByText(/^History is off\. New dictations keep their numbers only; older transcripts stay here/)).toBeVisible()
    await expect(launched.page.locator('.journal-entry')).toHaveCount(1)
    // Both dictations count today, the one whose words were not kept included.
    await expect(launched.page.getByRole('complementary', { name: 'Your dictation' })).toContainText('in 2 dictations')
    await mkdir(recordEvidence, { recursive: true })
    await resizeContentWindow(launched, 1280, 800)
    await launched.page.screenshot({ path: join(recordEvidence, 'history-off-after-restart-1280x800.png'), animations: 'disabled' })
    await resizeContentWindow(launched, 820, 560)
    await launched.page.screenshot({ path: join(recordEvidence, 'history-off-after-restart-820x560.png'), animations: 'disabled' })
    await launched.page.locator('.journal-entry__toggle').click()
    await launched.page.getByRole('button', { name: 'Delete saved transcript' }).click()
    await launched.page.getByRole('dialog').getByRole('button', { name: 'Delete transcript', exact: true }).click()
    await expect(launched.page.locator('.journal-entry')).toHaveCount(0)
    expect((await records()).map(record => record.id)).toEqual(kept.filter(record => record.id !== saved[0]!.id).map(record => record.id))

    // The Keep local history description says what is kept with it off.
    await openPage(launched.page, 'Settings')
    await launched.page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: 'Application', exact: true }).click()
    const description = launched.page.getByText("With it off, Sotto saves no text but still keeps each dictation's time, length, word count and app name.", { exact: false })
    await description.scrollIntoViewIfNeeded()
    await expect(description).toBeVisible()
    await launched.page.screenshot({ path: join(recordEvidence, 'keep-local-history-dark-820x560.png'), animations: 'disabled' })
    await launched.page.evaluate(async () => { await window.sotto!.updateSettings({ appearance: 'light' }) })
    await expect(launched.page.locator('html')).toHaveAttribute('data-theme', 'light')
    await resizeContentWindow(launched, 1280, 800)
    await description.scrollIntoViewIfNeeded()
    await launched.page.screenshot({ path: join(recordEvidence, 'keep-local-history-light-1280x800.png'), animations: 'disabled' })

  } finally {
    await closeSotto(launched)
    await removeOwnedE2EProfile(directory)
  }
})

test('deletes retained transcripts one at a time from disk while history is off', async () => {
  const testInfo = test.info()
  const launched = await launchSotto()
  try {
    await completeOnboarding(launched.page)
    await dictateWithButton(launched.page)
    await expect(launched.page.getByRole('heading', { name: /^Pasted( into .+)?\.$/ })).toBeVisible()
    await dictateWithButton(launched.page)
    await expect(launched.page.getByRole('heading', { name: /^Pasted( into .+)?\.$/ })).toBeVisible()
    await expect(launched.page.locator('.journal-entry')).toHaveCount(2)
    const retained = JSON.parse(await readFile(join(launched.userData, 'history.json'), 'utf8')) as { id: string }[]
    await launched.page.evaluate(async () => window.sotto!.updateSettings({ historyEnabled: false }))
    await expect(launched.page.getByText(/^History is off\. New dictations keep their numbers only; older transcripts stay here/)).toBeVisible()
    await launched.page.locator('.journal-entry__toggle').first().click()
    await launched.page.screenshot({ path: testInfo.outputPath('retained-history-off.png') })
    await launched.page.getByRole('button', { name: 'Delete saved transcript' }).click()
    await launched.page.getByRole('dialog').getByRole('button', { name: 'Delete transcript', exact: true }).click()
    await expect(launched.page.getByRole('dialog')).toHaveCount(0)
    await expect(launched.page.locator('.journal-entry')).toHaveCount(1)
    const remaining = JSON.parse(await readFile(join(launched.userData, 'history.json'), 'utf8')) as { id: string }[]
    expect(remaining).toHaveLength(1)
    expect(retained.map(entry => entry.id)).toContain(remaining[0]!.id)
    await expect(launched.page.locator('.journal-entry')).toBeVisible()
    await launched.page.screenshot({ path: testInfo.outputPath('remaining-history-off.png') })
    await launched.page.locator('.journal-entry__toggle').click()
    await launched.page.getByRole('button', { name: 'Delete saved transcript' }).click()
    await launched.page.getByRole('dialog').getByRole('button', { name: 'Delete transcript', exact: true }).click()
    await expect(launched.page.getByRole('dialog')).toHaveCount(0)
    await expect(launched.page.locator('.journal-entry')).toHaveCount(0)

    expect(JSON.parse(await readFile(join(launched.userData, 'history.json'), 'utf8'))).toEqual([])
    await launched.page.evaluate(async () => window.sotto!.updateSettings({ historyEnabled: true }))
    await launched.page.reload()
    await openPage(launched.page, 'Dictate')
    await expect(launched.page.getByRole('heading', { name: 'Nothing here yet.' })).toBeVisible()
    await launched.page.screenshot({ path: testInfo.outputPath('deleted-after-reload.png') })
  } finally {
    await closeSotto(launched)
  }
})

test('keeps the widget theme apart from the main window and applies a persisted appearance after reload', async () => {
  const launched = await launchSotto()
  try {
    await completeOnboarding(launched.page)
    const html = launched.page.locator('html')
    await launched.page.evaluate(async () => {
      const bridge = (globalThis as unknown as { sotto: SottoBridge }).sotto
      await bridge.updateSettings({ theme: 'light' })
    })
    await launched.page.reload()
    // A reload lands on Threads the same way a cold start does, so Dictate is a deliberate stop again.
    await openPage(launched.page, 'Dictate')
    await expect(launched.page.getByRole('heading', { name: /ready when you are/i })).toBeVisible()
    // The widget theme never reaches the main window, which keeps the dark default.
    await expect(html).toHaveAttribute('data-theme', 'dark')
    await expect(html).toHaveAttribute('data-theme-id', 't3-code')
    const darkCanvas = await launched.page.evaluate(() => getComputedStyle(document.body).backgroundColor)

    await launched.page.evaluate(async () => {
      const bridge = (globalThis as unknown as { sotto: SottoBridge }).sotto
      await bridge.updateSettings({ appearance: 'light', lightTheme: 'tropic' })
    })
    await expect(html).toHaveAttribute('data-theme', 'light')
    await launched.page.reload()
    // A reload lands on Threads the same way a cold start does, so Dictate is a deliberate stop again.
    await openPage(launched.page, 'Dictate')
    await expect(launched.page.getByRole('heading', { name: /ready when you are/i })).toBeVisible()
    await expect(html).toHaveAttribute('data-theme', 'light')
    await expect(html).toHaveAttribute('data-theme-id', 'tropic')
    expect(await launched.page.evaluate(() => getComputedStyle(document.body).backgroundColor)).not.toBe(darkCanvas)
  } finally {
    await closeSotto(launched)
  }
})

test('reports a hotkey conflict and preserves the previous shortcut', async () => {
  const launched = await launchSotto('hotkey-conflict')
  try {
    await completeOnboarding(launched.page)
    await launched.page.getByRole('link', { name: 'Settings' }).click()
    // E2E_CONFLICTING_HOTKEY is Ctrl+Alt+9 in Windows terms; CommandOrControl is Command on macOS.
    const control = process.platform === 'darwin' ? 'Meta' : 'Control'
    const pressRow = launched.page.getByRole('group', { name: 'Press to start and stop' })
    const shortcut = pressRow.getByRole('button', { name: /^Change shortcut/u })
    const previous = await shortcut.getAttribute('aria-label')
    await shortcut.click()
    await launched.page.keyboard.down(control)
    await launched.page.keyboard.down('Alt')
    await launched.page.keyboard.press('9')
    await launched.page.keyboard.up('Alt')
    await launched.page.keyboard.up(control)
    await expect(pressRow.getByRole('alert')).toContainText('Another app already uses')
    await expect(pressRow.getByRole('button', { name: /^Change shortcut/u })).toHaveAttribute('aria-label', previous ?? '')

    await triggerShortcut(launched.page)
    const widget = launched.app.windows().find((candidate) => candidate.url().endsWith('/widget.html'))
    if (widget === undefined) throw new Error('Widget window unavailable')
    await expect(widget.locator('.widget-shell[data-status="listening"]')).toBeVisible()
    await triggerShortcut(launched.page)
    await expect(widget.getByText('Pasted', { exact: true })).toBeVisible()
  } finally {
    await closeSotto(launched)
  }
})

test('recovers after microphone permission is denied once', async () => {
  const launched = await launchSotto('microphone-denied-once')
  try {
    await reachFirstRunStep(launched.page, 'microphone')
    await launched.page.getByRole('button', { name: /test microphone/i }).click()
    await expect(launched.page.getByText('Microphone access is blocked.')).toBeVisible()
    await expect(launched.page.getByText(/privacy & security.*microphone/i)).toBeVisible()
    await launched.page.getByRole('button', { name: /try microphone again/i }).click()
    await expect(launched.page.getByText('Sotto heard you. Your microphone works.')).toBeVisible()
  } finally {
    await closeSotto(launched)
  }
})

test('silence preserves the clipboard and creates no history', async () => {
  const launched = await launchSotto('silence')
  try {
    await completeOnboarding(launched.page)
    expect(await snapshot(launched.page)).toMatchObject({
      clipboardText: PRESERVED_CLIPBOARD_TEXT,
      pasteAttempts: 0,
    })
    await dictateWithButton(launched.page)
    await expect(launched.page.getByRole('alert')).toContainText(/no speech was detected/i)
    expect(await snapshot(launched.page)).toMatchObject({
      clipboardText: PRESERVED_CLIPBOARD_TEXT,
      pasteAttempts: 0,
    })
    await expect(launched.page.getByRole('heading', { name: 'Nothing here yet.' })).toBeVisible()
  } finally {
    await closeSotto(launched)
  }
})

test('paste rejection falls back to a durable copied result', async () => {
  const launched = await launchSotto('paste-failure')
  try {
    await completeOnboarding(launched.page)
    await dictateWithButton(launched.page)
    await expect(launched.page.getByRole('heading', { name: 'Copied.' })).toBeVisible()
    expect(await snapshot(launched.page)).toMatchObject({
      clipboardText: DETERMINISTIC_TRANSCRIPT,
      pasteAttempts: 1,
    })
  } finally {
    await closeSotto(launched)
  }
})

test('persists settings through reload', async () => {
  const launched = await launchSotto()
  try {
    await completeOnboarding(launched.page)
    await launched.page.getByRole('link', { name: 'Settings' }).click()
    await launched.page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: 'Output', exact: true }).click()
    const delay = launched.page.getByLabel('Paste delay')
    await delay.fill('275')
    await launched.page.getByLabel('Paste delay').press('Tab')
    await expect(launched.page.getByText('Paste delay saved.')).toBeVisible()
    await launched.page.reload()
    await launched.page.getByRole('link', { name: 'Settings' }).click()
    await launched.page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: 'Output', exact: true }).click()
    await expect(launched.page.getByLabel('Paste delay')).toHaveValue('275')
  } finally {
    await closeSotto(launched)
  }
})

test('keeps the real main window frameless, with a strip while onboarding and the Threads page after it', async () => {
  const launched = await launchSotto()
  try {
    const geometry = await launched.app.evaluate(({ BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows().find((candidate) =>
        candidate.webContents.getURL().endsWith('/index.html'),
      )
      if (main === undefined) return null
      return {
        bounds: main.getBounds(),
        contentBounds: main.getContentBounds(),
      }
    })

    expect(geometry).not.toBeNull()
    expect(geometry?.contentBounds).toEqual(geometry?.bounds)
    await expect(launched.page.locator('header.app-strip')).toHaveCount(1)

    await finishFirstRunSetupFrom(launched.page)

    // Onboarding hands over to Threads, which owns the whole window: no strip, and the window controls it carries
    // itself instead. macOS paints its own traffic lights over the sidebar's top row and gets none of ours, and
    // Linux draws none, because Hyprland closes windows itself (#849).
    await expect(launched.page.getByRole('complementary', { name: /Thread sidebar|Terminal sidebar/ })).toBeVisible()
    await expect(launched.page.locator('header.app-strip')).toHaveCount(0)
    await expect(launched.page.locator('.app-controls')).toHaveCount(process.platform === 'win32' ? 1 : 0)
  } finally {
    await closeSotto(launched)
  }
})

test('keeps onboarding Continue reachable and clickable at the supported 820x560 minimum', async () => {
  const launched = await launchSotto()
  try {
    await expect(
      launched.page.getByRole('heading', { name: /talk to your computer and your coding agents/i }),
    ).toBeVisible()
    await launched.app.evaluate(({ BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows().find((candidate) =>
        candidate.webContents.getURL().endsWith('/index.html'),
      )
      if (main === undefined) throw new Error('Main window unavailable')
      main.setBounds({ ...main.getBounds(), width: 820, height: 560 }, false)
    })
    await expect.poll(() => launched.page.evaluate(() =>
      (globalThis as unknown as { readonly innerWidth: number }).innerWidth,
    )).toBe(820)
    await expect.poll(() => launched.app.evaluate(({ BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows().find((candidate) =>
        candidate.webContents.getURL().endsWith('/index.html'),
      )
      return main?.getMinimumSize() ?? null
    })).toEqual([820, 560])

    const continueButton = launched.page.getByRole('button', { name: 'Get started' })
    const access = await continueButton.evaluate((button) => {
      const shell = button.closest('.onboarding-shell')
      if (shell === null) return null
      const buttonInsideViewport = (): boolean => {
        const bounds = button.getBoundingClientRect()
        const viewportHeight = (
          globalThis as unknown as { readonly innerHeight: number }
        ).innerHeight
        return bounds.top >= 0 && bounds.bottom <= viewportHeight
      }
      const initiallyVisible = buttonInsideViewport()
      shell.scrollTop = shell.scrollHeight
      return {
        initiallyVisible,
        clientHeight: shell.clientHeight,
        scrollHeight: shell.scrollHeight,
        scrollTop: shell.scrollTop,
        visibleAfterScroll: buttonInsideViewport(),
      }
    })

    expect(access).not.toBeNull()
    expect(
      access!.initiallyVisible || (
        access!.scrollHeight > access!.clientHeight &&
        access!.scrollTop > 0 &&
        access!.visibleAfterScroll
      ),
    ).toBe(true)

    await continueButton.click()
    await expect(
      launched.page.getByRole('heading', { name: /choose how sotto looks/i }),
    ).toBeVisible()
  } finally {
    await closeSotto(launched)
  }
})

test('uses stable content-sized native widget bounds for bottom-edge presentations', async () => {
  const launched = await launchSotto()
  const expectedGeometry = async (width: number) => {
    const geometry = await nativeWidgetGeometry(launched.app)
    if (geometry === null) return null
    return {
      width: geometry.contentBounds.width,
      height: geometry.contentBounds.height,
      centeredOffset: geometry.contentBounds.x - (
        geometry.workArea.x + Math.round((geometry.workArea.width - width) / 2)
      ),
      bottomInset: geometry.workArea.y + geometry.workArea.height - (
        geometry.contentBounds.y + geometry.contentBounds.height
      ),
    }
  }

  try {
    await completeOnboarding(launched.page)
    const widget = launched.app.windows().find((candidate) =>
      candidate.url().endsWith('/widget.html'),
    )
    if (widget === undefined) throw new Error('Widget window unavailable')
    const sliver = widget.getByTestId('widget-sliver')
    await expect(sliver).toBeVisible()

    await expect.poll(() => expectedGeometry(124)).toEqual({
      width: 124,
      height: 54,
      centeredOffset: 0,
      bottomInset: 16,
    })

    await sliver.hover()
    await expect.poll(() => expectedGeometry(248)).toEqual({
      width: 248,
      height: 76,
      centeredOffset: 0,
      bottomInset: 16,
    })
    const hoveredSamples = await sampleNativeWidgetContentBounds(launched.app)
    expect(hoveredSamples).toHaveLength(40)
    expect(hoveredSamples.every(({ width, height }) => width === 248 && height === 76)).toBe(true)

    await triggerShortcut(launched.page)
    await expect(widget.locator('.widget-shell[data-status="listening"]')).toBeVisible()
    await expect.poll(() => expectedGeometry(248)).toEqual({
      width: 248,
      height: 88,
      centeredOffset: 0,
      bottomInset: 16,
    })
  } finally {
    await closeSotto(launched)
  }
})

test('hiding the idle widget terminates its renderer drag before the next reveal', async () => {
  const launched = await launchSotto()
  try {
    await completeOnboarding(launched.page)
    const widget = launched.app.windows().find((candidate) =>
      candidate.url().endsWith('/widget.html'),
    )
    if (widget === undefined) throw new Error('Widget window unavailable')
    const sliver = widget.getByTestId('widget-sliver')
    await expect(sliver).toBeVisible()

    await sliver.dispatchEvent('pointerdown', {
      pointerId: 17, button: 0, isPrimary: true, screenX: 50, screenY: 60,
    })
    await sliver.dispatchEvent('pointermove', {
      pointerId: 17, button: 0, isPrimary: true, screenX: 80, screenY: 60,
    })
    await expect(widget.locator('.widget-shell')).toHaveAttribute('data-dragging', 'true')

    await launched.page.getByRole('link', { name: 'Settings' }).click()
    await launched.page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: 'Application', exact: true }).click()
    const idleWidgetToggle = launched.page.getByRole('switch', {
      name: 'Show floating widget when idle',
    })
    await idleWidgetToggle.click()
    await expect.poll(() => nativeWidgetVisible(launched.app)).toBe(false)
    await expect(widget.locator('.widget-shell')).not.toHaveAttribute('data-dragging', 'true')

    await idleWidgetToggle.click()
    await expect.poll(() => nativeWidgetVisible(launched.app)).toBe(true)
    await expect(widget.locator('.widget-shell')).not.toHaveAttribute('data-dragging', 'true')
  } finally {
    await closeSotto(launched)
  }
})

test('closing the main window hides it to the tray without quitting', async () => {
  const launched = await launchSotto()
  try {
    await completeOnboarding(launched.page)
    await closeMainToTray(launched.app, launched.page)
    await expect.poll(async () => (await snapshot(launched.page)).mainVisible).toBe(false)
    expect(launched.app.process().exitCode).toBeNull()
  } finally {
    await closeSotto(launched)
  }
})

test('a second instance reveals the existing hidden window', async () => {
  const launched = await launchSotto()
  try {
    await completeOnboarding(launched.page)
    await closeMainToTray(launched.app, launched.page)
    await expect.poll(async () => (await snapshot(launched.page)).mainVisible).toBe(false)

    const electronExecutable = createRequire(join(process.cwd(), 'package.json'))('electron') as string
    const second = spawn(electronExecutable, ['out/main/index.js'], {
      cwd: process.cwd(),
      env: e2eEnvironment('success', launched.userData),
      stdio: 'ignore',
      windowsHide: true,
    })
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { second.kill(); reject(new Error('Second instance did not exit')) }, 10_000)
      second.once('error', (error) => { clearTimeout(timeout); reject(error) })
      second.once('exit', () => { clearTimeout(timeout); resolve() })
    })
    await expect.poll(async () => (await snapshot(launched.page)).mainVisible).toBe(true)
  } finally {
    await closeSotto(launched)
  }
})

test('quitting retains native windows during the drain and releases the lock for relaunch', async () => {
  const launched = await launchSotto()
  let relaunched: Awaited<ReturnType<typeof launchSotto>> | undefined
  try {
    await mkdir(evidence, { recursive: true })
    await launched.page.screenshot({ path: join(evidence, 'before-quit.png') })
    const exited = new Promise<number | null>(resolve => launched.app.process().once('exit', resolve))
    const state = await launched.app.evaluate(({ app, BrowserWindow }) => {
      let observed: { prevented: boolean; windows: number } | undefined
      app.once('before-quit', event => {
        observed = {
          prevented: event.defaultPrevented,
          windows: BrowserWindow.getAllWindows().length,
        }
      })
      app.quit()
      return observed
    })
    expect(state?.prevented).toBe(true)
    expect(state?.windows).toBeGreaterThan(0)
    expect(await exited).toBe(0)
    relaunched = await launchSotto('success', launched.userData)
    await expect(relaunched.page.getByRole('button', { name: 'Get started', exact: true })).toBeVisible()
  } finally {
    if (relaunched) await closeSotto(relaunched)
    await closeSotto(launched)
  }
})

test('transcription failure is finite and leaves clipboard and history untouched', async () => {
  const launched = await launchSotto('transcription-failure')
  try {
    await completeOnboarding(launched.page)
    await dictateWithButton(launched.page)
    await expect(launched.page.getByRole('alert')).toContainText(TRANSCRIPTION_KEPT_DETAIL.TRANSCRIPTION_FAILED)
    expect(await snapshot(launched.page)).toMatchObject({
      clipboardText: PRESERVED_CLIPBOARD_TEXT,
      pasteAttempts: 0,
    })
    await expect(launched.page.getByRole('heading', { name: 'Nothing here yet.' })).toBeVisible()
  } finally {
    await closeSotto(launched)
  }
})
