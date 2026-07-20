import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { join } from 'node:path'

import { expect, test, type Page } from '@playwright/test'

import {
  E2E_CONFLICTING_HOTKEY,
  type E2ESnapshot,
  type TalkTypeE2EBridge,
} from '../../src/shared/e2e'
import { DETERMINISTIC_TRANSCRIPT, PRESERVED_CLIPBOARD_TEXT } from '../fixtures/fakeTranscription'
import { closeTalkType, e2eEnvironment, launchTalkType } from './support/talktypeLaunch'

async function reachFinalOnboardingStep(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: /test microphone/i }).click()
  await expect(page.getByText(/microphone ready/i)).toBeVisible()
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByText(/balanced model is included and ready/i)).toBeVisible()
  await page.getByRole('button', { name: 'Continue' }).click()
}

async function finishOnboarding(page: Page): Promise<void> {
  await page.getByRole('button', { name: /finish setup/i }).click()
  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible()
}

async function completeOnboarding(page: Page): Promise<void> {
  await reachFinalOnboardingStep(page)
  await finishOnboarding(page)
}

async function dictateWithButton(page: Page): Promise<void> {
  await page.getByRole('button', { name: /start dictation/i }).click()
  await page.getByRole('button', { name: /stop and transcribe/i }).click()
}

async function snapshot(page: Page): Promise<E2ESnapshot> {
  const value = await page.evaluate(() =>
    (globalThis as unknown as { talktypeE2E?: TalkTypeE2EBridge }).talktypeE2E?.snapshot(),
  )
  if (value === undefined) throw new Error('E2E bridge unavailable')
  return value
}

async function triggerShortcut(page: Page): Promise<void> {
  await page.evaluate(() =>
    (globalThis as unknown as { talktypeE2E?: TalkTypeE2EBridge }).talktypeE2E?.triggerShortcut(),
  )
}

test('onboards, dictates through the registered shortcut, pastes, and records local history', async () => {
  const launched = await launchTalkType()
  try {
    await reachFinalOnboardingStep(launched.page)
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

    await finishOnboarding(launched.page)
    await launched.page.getByRole('link', { name: 'History' }).click()
    await expect(launched.page.getByText(DETERMINISTIC_TRANSCRIPT)).toBeVisible()
  } finally {
    await closeTalkType(launched)
  }
})

test('keeps history disabled without blocking private dictation', async () => {
  const launched = await launchTalkType('history-disabled')
  try {
    await completeOnboarding(launched.page)
    await launched.page.getByRole('link', { name: 'Settings' }).click()
    await launched.page.getByRole('switch', { name: 'Keep local history' }).click()
    await expect(launched.page.getByText('Setting saved.')).toBeVisible()
    await launched.page.getByRole('link', { name: 'Home' }).click()
    await dictateWithButton(launched.page)
    await expect(launched.page.getByRole('heading', { name: 'Text pasted' })).toBeVisible()
    await launched.page.getByRole('link', { name: 'History' }).click()
    await expect(launched.page.getByRole('heading', { name: 'History is turned off' })).toBeVisible()
  } finally {
    await closeTalkType(launched)
  }
})

test('persists the dark theme across a renderer reload', async () => {
  const launched = await launchTalkType()
  try {
    await completeOnboarding(launched.page)
    await launched.page.getByRole('link', { name: 'Settings' }).click()
    await launched.page.getByLabel('Theme').selectOption('dark')
    await expect.poll(() => launched.page.locator('html').getAttribute('data-theme')).toBe('dark')
    await launched.page.reload()
    await expect(launched.page.getByRole('heading', { name: 'Home' })).toBeVisible()
    await expect(launched.page.locator('html')).toHaveAttribute('data-theme', 'dark')
  } finally {
    await closeTalkType(launched)
  }
})

test('reports a hotkey conflict and preserves the previous shortcut', async () => {
  const launched = await launchTalkType('hotkey-conflict')
  try {
    await completeOnboarding(launched.page)
    await launched.page.getByRole('link', { name: 'Settings' }).click()
    const shortcut = launched.page.getByLabel('Global shortcut')
    const previous = await shortcut.inputValue()
    await shortcut.fill(E2E_CONFLICTING_HOTKEY)
    await launched.page.getByRole('button', { name: 'Apply shortcut' }).click()
    await expect(launched.page.getByRole('alert')).toContainText(/another application is already using/i)
    await expect(shortcut).toHaveValue(previous)

    await triggerShortcut(launched.page)
    const widget = launched.app.windows().find((candidate) => candidate.url().endsWith('/widget.html'))
    if (widget === undefined) throw new Error('Widget window unavailable')
    await expect(widget.locator('.widget-shell[data-status="listening"]')).toBeVisible()
    await triggerShortcut(launched.page)
    await expect(widget.getByText('Pasted', { exact: true })).toBeVisible()
  } finally {
    await closeTalkType(launched)
  }
})

test('recovers after microphone permission is denied once', async () => {
  const launched = await launchTalkType('microphone-denied-once')
  try {
    await launched.page.getByRole('button', { name: 'Continue' }).click()
    await launched.page.getByRole('button', { name: /test microphone/i }).click()
    await expect(launched.page.getByText('Microphone access is blocked.')).toBeVisible()
    await expect(launched.page.getByText(/privacy & security.*microphone/i)).toBeVisible()
    await launched.page.getByRole('button', { name: /try microphone again/i }).click()
    await expect(launched.page.getByText(/microphone ready/i)).toBeVisible()
  } finally {
    await closeTalkType(launched)
  }
})

test('silence preserves the clipboard and creates no history', async () => {
  const launched = await launchTalkType('silence')
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
    await launched.page.getByRole('link', { name: 'History' }).click()
    await expect(launched.page.getByRole('heading', { name: 'No saved transcripts yet' })).toBeVisible()
  } finally {
    await closeTalkType(launched)
  }
})

test('paste rejection falls back to a durable copied result', async () => {
  const launched = await launchTalkType('paste-failure')
  try {
    await completeOnboarding(launched.page)
    await dictateWithButton(launched.page)
    await expect(launched.page.getByRole('heading', { name: 'Text copied' })).toBeVisible()
    expect(await snapshot(launched.page)).toMatchObject({
      clipboardText: DETERMINISTIC_TRANSCRIPT,
      pasteAttempts: 1,
    })
  } finally {
    await closeTalkType(launched)
  }
})

test('persists settings through reload', async () => {
  const launched = await launchTalkType()
  try {
    await completeOnboarding(launched.page)
    await launched.page.getByRole('link', { name: 'Settings' }).click()
    const delay = launched.page.getByLabel('Paste delay')
    await delay.fill('275')
    await launched.page.getByRole('button', { name: 'Save paste delay' }).click()
    await expect(launched.page.getByText('Paste delay saved.')).toBeVisible()
    await launched.page.reload()
    await launched.page.getByRole('link', { name: 'Settings' }).click()
    await expect(launched.page.getByLabel('Paste delay')).toHaveValue('275')
  } finally {
    await closeTalkType(launched)
  }
})

test('closing the main window hides it to the tray without quitting', async () => {
  const launched = await launchTalkType()
  try {
    await completeOnboarding(launched.page)
    await launched.page.getByRole('button', { name: 'Close TalkType to tray' }).click()
    await expect.poll(async () => (await snapshot(launched.page)).mainVisible).toBe(false)
    expect(launched.app.process().exitCode).toBeNull()
  } finally {
    await closeTalkType(launched)
  }
})

test('a second instance reveals the existing hidden window', async () => {
  const launched = await launchTalkType()
  try {
    await completeOnboarding(launched.page)
    await launched.page.getByRole('button', { name: 'Close TalkType to tray' }).click()
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
    await closeTalkType(launched)
  }
})

test('transcription failure is finite and leaves clipboard and history untouched', async () => {
  const launched = await launchTalkType('transcription-failure')
  try {
    await completeOnboarding(launched.page)
    await dictateWithButton(launched.page)
    await expect(launched.page.getByRole('alert')).toContainText(/could not transcribe/i)
    expect(await snapshot(launched.page)).toMatchObject({
      clipboardText: PRESERVED_CLIPBOARD_TEXT,
      pasteAttempts: 0,
    })
    await launched.page.getByRole('link', { name: 'History' }).click()
    await expect(launched.page.getByRole('heading', { name: 'No saved transcripts yet' })).toBeVisible()
  } finally {
    await closeTalkType(launched)
  }
})
