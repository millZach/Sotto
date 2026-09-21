# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: phase-four-personal-providers.spec.ts >> Claude and Grok use their own saved-chat identity, native requests and keyboard composer in Electron
- Location: tests\e2e\phase-four-personal-providers.spec.ts:8:5

# Error details

```
TimeoutError: locator.click: Timeout 30000ms exceeded.
Call log:
  - waiting for getByRole('button', { name: 'Disconnect', exact: true })
    - locator resolved to <button type="button" class="tt-button tt-focusable tt-button--ghost" title="End personal chat connections. Chats and drafts stay.">Disconnect</button>
  - attempting click action
    2 × waiting for element to be visible, enabled and stable
      - element is visible, enabled and stable
      - scrolling into view if needed
      - done scrolling
      - <svg width="16" height="16" fill="none" stroke-width="2" aria-hidden="true" viewBox="0 0 24 24" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-square" xmlns="http://www.w3.org/2000/svg">…</svg> from <div class="threads-view__winctl">…</div> subtree intercepts pointer events
    - retrying click action
    - waiting 20ms
    2 × waiting for element to be visible, enabled and stable
      - element is visible, enabled and stable
      - scrolling into view if needed
      - done scrolling
      - <svg width="16" height="16" fill="none" stroke-width="2" aria-hidden="true" viewBox="0 0 24 24" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-square" xmlns="http://www.w3.org/2000/svg">…</svg> from <div class="threads-view__winctl">…</div> subtree intercepts pointer events
    - retrying click action
      - waiting 100ms
    58 × waiting for element to be visible, enabled and stable
       - element is visible, enabled and stable
       - scrolling into view if needed
       - done scrolling
       - <svg width="16" height="16" fill="none" stroke-width="2" aria-hidden="true" viewBox="0 0 24 24" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-square" xmlns="http://www.w3.org/2000/svg">…</svg> from <div class="threads-view__winctl">…</div> subtree intercepts pointer events
     - retrying click action
       - waiting 500ms

```

# Test source

```ts
  1  | import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
  2  | import { tmpdir } from 'node:os'
  3  | import { join } from 'node:path'
  4  | import { expect, test } from '@playwright/test'
  5  | import { closeSotto, launchSotto } from './support/sottoLaunch'
  6  | import { DEFAULT_SETTINGS } from '../../src/shared/settings'
  7  | 
  8  | test('Claude and Grok use their own saved-chat identity, native requests and keyboard composer in Electron', async () => {
  9  |   test.setTimeout(90_000)
  10 |   const profile = await mkdtemp(join(tmpdir(), 'sotto-e2e-phase4-personal-'))
  11 |   await writeFile(join(profile, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, onboardingComplete: true, historyEnabled: true }))
  12 |   const launched = await launchSotto('success', profile)
  13 |   const { page, app } = launched
  14 |   await mkdir('artifacts/phase-four-native-chats', { recursive: true })
  15 |   try {
  16 |     await page.evaluate(async () => window.sotto!.updateSettings({ onboardingComplete: true, historyEnabled: true }))
  17 |     await page.getByRole('link', { name: 'Chats', exact: true }).click()
  18 |     for (const [provider, label] of [['claude', 'Claude'], ['grok', 'Grok']] as const) {
  19 |       await page.evaluate(async provider => window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true, speak: false, reasoning: provider, reasoningModel: `${provider}:test`, reasoningEffort: 'low' } }), provider)
  20 |       const earlier = (await page.evaluate(() => window.sotto!.personalChats!.get())).chats.map(chat => chat.id)
  21 |       await page.getByRole('navigation', { name: 'Chats', exact: true }).getByRole('button', { name: 'New chat', exact: true }).click()
  22 |       const composer = page.getByRole('textbox', { name: 'Message', exact: true })
  23 |       // Until the new chat is selected, the previous chat's composer is still the enabled textbox.
  24 |       await expect.poll(async () => { const selected = (await page.evaluate(() => window.sotto!.personalChats!.get())).selectedChatId; return Boolean(selected) && !earlier.includes(selected!) }).toBe(true)
  25 |       await expect(composer).toBeFocused()
  26 |       await composer.fill(`${label} conversation`)
  27 |       await composer.press('Enter')
  28 |       await expect(page.getByText(`You said: ${label} conversation`)).toBeVisible()
  29 |       await expect(page.getByPlaceholder(`Reply to ${label}`)).toBeVisible()
  30 |       const id = await page.evaluate(async () => (await window.sotto!.personalChats!.get()).selectedChatId!)
  31 |       await page.evaluate(async id => window.sottoE2E!.agentEvent!({ scope: 'personal', type: 'permission', threadId: id, text: '', request: {
  32 |         id: 'permission-check', kind: 'permission', text: 'Read the suggested itinerary', options: [],
  33 |         permissionChoices: [{ id: 'native:once', label: 'Allow once', kind: 'allow-once' }, { id: 'native:deny', label: 'Skip', kind: 'deny' }],
  34 |       } }), id)
  35 |       await expect(page.getByRole('button', { name: 'Allow once', exact: true })).toBeVisible()
  36 |       for (const [width, height, theme] of [[1280, 900, 'dark'], [820, 560, 'light']] as const) {
  37 |         await app.evaluate(({ BrowserWindow }, { width, height }) => { const win = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'))!; win.setSize(width, height) }, { width, height })
  38 |         await page.evaluate(async theme => window.sotto!.updateSettings({ appearance: theme }), theme)
  39 |         await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
  40 |         await page.screenshot({ path: `artifacts/phase-four-native-chats/${provider}-${width}-${theme}.png` })
  41 |       }
  42 |       await page.getByRole('button', { name: 'Skip', exact: true }).click()
  43 |       await expect(page.locator('.agent-request')).toHaveCount(0)
> 44 |       await page.getByRole('button', { name: 'Disconnect', exact: true }).click()
     |                                                                           ^ TimeoutError: locator.click: Timeout 30000ms exceeded.
  45 |       await expect(page.getByRole('button', { name: `Connect ${label}`, exact: true })).toBeVisible()
  46 |       await page.getByRole('button', { name: `Connect ${label}`, exact: true }).click()
  47 |       await expect(page.getByPlaceholder(`Reply to ${label}`)).toBeEnabled()
  48 |     }
  49 |     const state = await page.evaluate(async () => window.sotto!.personalChats!.get())
  50 |     expect(state.chats.map(chat => chat.providerId)).toEqual(['grok', 'claude'])
  51 |     expect(state.chats.every(chat => !('projectId' in chat) && chat.decisions?.[0]?.status === 'accepted')).toBe(true)
  52 |   } finally { await closeSotto(launched) }
  53 | })
  54 | 
```