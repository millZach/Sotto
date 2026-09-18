import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { closeSotto, launchSotto } from './support/sottoLaunch'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import { BUILT_IN_THEMES } from '../../src/shared/themes/library'

test('personal dictation and spoken exchange retain each provider chat, support mute/interrupt and stop on navigation', async () => {
  test.setTimeout(120_000)
  const profile = await mkdtemp(join(tmpdir(), 'sotto-e2e-phase5-voice-'))
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, onboardingComplete: true, historyEnabled: true, voiceCoordinatorEnabled: true }))
  const launched = await launchSotto('success', profile)
  const { page, app } = launched
  await mkdir('artifacts/phase-five-personal-voice', { recursive: true })
  const evidence: unknown[] = []
  try {
    await page.getByRole('link', { name: 'Chats', exact: true }).click()
    await page.evaluate(() => {
      const heard: string[] = []
      window.addEventListener('sotto:e2e:personal-spoken', event => heard.push((event as CustomEvent<string>).detail))
      Object.assign(window, { personalSpoken: heard })
    })
    for (const [provider, label] of [['codex', 'Codex'], ['claude', 'Claude'], ['grok', 'Grok']] as const) {
      await page.evaluate(async provider => window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true, speak: false, reasoning: provider, reasoningModel: `${provider}:test`, reasoningEffort: 'low' } }), provider)
      const earlier = (await page.evaluate(() => window.sotto!.personalChats!.get())).chats.map(chat => chat.id)
      await page.getByRole('navigation', { name: 'Chats', exact: true }).getByRole('button', { name: 'New chat', exact: true }).click()
      const composer = page.getByRole('textbox', { name: 'Message', exact: true })
      // Until the new chat is selected, the previous chat's composer is still the enabled textbox.
      await expect.poll(async () => { const selected = (await page.evaluate(() => window.sotto!.personalChats!.get())).selectedChatId; return Boolean(selected) && !earlier.includes(selected!) }).toBe(true)
      await expect(composer).toBeFocused()
      await composer.fill('Typed thought')
      await page.getByRole('button', { name: 'Dictate', exact: true }).click()
      await expect(page.getByRole('button', { name: 'Finish dictation', exact: true })).toBeVisible()
      await page.getByRole('button', { name: 'Finish dictation', exact: true }).click()
      await expect(composer).not.toHaveValue('Typed thought')
      const dictated = await composer.inputValue()
      expect(dictated.startsWith('Typed thought\n')).toBe(true)
      expect((await page.evaluate(() => window.sotto!.personalChats!.get())).chats[0]!.messages).toHaveLength(0)
      await composer.fill('')
      const before = await page.evaluate(() => window.sotto!.agents!.get())
      await page.getByRole('combobox', { name: 'Chat reply voice' }).selectOption(provider === 'claude' ? 'kokoro' : 'grok')
      await page.getByRole('button', { name: 'Talk', exact: true }).focus()
      await page.getByRole('button', { name: 'Talk', exact: true }).press('Enter')
      await expect(page.getByRole('status').filter({ hasText: /^Listening$/ })).toBeVisible()
      await page.getByRole('button', { name: 'Mute chat microphone' }).click()
      await expect(page.getByText('Microphone muted', { exact: true })).toBeVisible()
      await page.evaluate(() => window.dispatchEvent(new CustomEvent('sotto:e2e:microphone', { detail: 'Must not send muted speech' })))
      await page.getByRole('button', { name: 'Unmute chat microphone' }).click()
      await expect(page.getByRole('status').filter({ hasText: /^Listening$/ })).toBeVisible()
      const started = Date.now()
      const phrase = `${label} spoken thought: create a project and approve it`
      await page.evaluate(text => window.dispatchEvent(new CustomEvent('sotto:e2e:microphone', { detail: text })), phrase)
      await expect(page.getByText(`You said: ${phrase}`)).toBeVisible()
      await expect(page.getByRole('button', { name: 'Stop spoken reply' })).toBeVisible()
      await page.getByRole('button', { name: 'Stop spoken reply' }).click()
      await expect(page.getByRole('button', { name: 'Stop spoken reply' })).toHaveCount(0)
      const saved = await page.evaluate(() => window.sotto!.personalChats!.get())
      const owner = saved.chats.find(chat => chat.id === saved.selectedChatId)!
      expect(owner.providerId).toBe(provider)
      expect(owner.messages.filter(message => message.role === 'user').map(message => message.text)).toEqual([phrase])
      const after = await page.evaluate(() => window.sotto!.agents!.get())
      expect(after.host.projects).toEqual(before.host.projects)
      expect(after.host.threads).toEqual(before.host.threads)
      expect(after.assignments).toEqual(before.assignments)
      const spoken = await page.evaluate(() => (window as unknown as { personalSpoken: string[] }).personalSpoken)
      expect(spoken.at(-1)).toContain(`You said: ${phrase}`)
      expect(spoken.some(text => /Must not send muted speech|Wrong destination/u.test(text))).toBe(false)
      evidence.push({ provider, boundary: 'injected text through production voice state machine to fixture saved chat', elapsedMs: Date.now() - started, ownerId: owner.id, messages: owner.messages.length })
      for (const [width, height, theme] of [[1280, 900, 'dark'], [820, 560, 'light']] as const) {
        await app.evaluate(({ BrowserWindow }, size) => { const win = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'))!; win.setSize(size.width, size.height) }, { width, height })
        await page.evaluate(theme => window.sotto!.updateSettings({ appearance: theme }), theme)
        await page.screenshot({ path: `artifacts/phase-five-personal-voice/${provider}-${width}-${theme}.png` })
        const bounds = await page.locator('.personal-voice').boundingBox()
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width)
        expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(height)
      }
      if (provider === 'grok') {
        for (const [width, height] of [[1280, 900], [820, 560]] as const) {
          await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'))!.setSize(...size), [width, height] as const)
          for (const palette of BUILT_IN_THEMES) for (const appearance of ['dark', 'light'] as const) {
            await page.evaluate(({ id, appearance }) => window.sotto!.updateSettings({ appearance, lightTheme: id, darkTheme: id }), { id: palette.id, appearance })
            await page.screenshot({ path: `artifacts/phase-five-personal-voice/palette-${palette.id}-${width}-${appearance}.png`, animations: 'disabled' })
            expect(await page.locator('.personal-voice').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
          }
        }
        await page.evaluate(() => window.sotto!.updateSettings({ appearance: 'light', lightTheme: 'ocean', darkTheme: 'ocean' }))
      }
      await page.getByRole('button', { name: 'End voice', exact: true }).click()
      await composer.fill('Keep my typed plan')
      await page.getByRole('button', { name: 'Talk', exact: true }).click()
      await expect(page.getByRole('status').filter({ hasText: /^Listening$/ })).toBeVisible()
      await page.evaluate(() => window.dispatchEvent(new CustomEvent('sotto:e2e:microphone', { detail: 'Add this thought for review' })))
      await expect(composer).toHaveValue('Keep my typed plan\nAdd this thought for review')
      await expect(page.getByText('Speech is in your draft. Review it before sending.')).toBeVisible()
      expect((await page.evaluate(() => window.sotto!.personalChats!.get())).chats.find(chat => chat.id === owner.id)!.messages).toHaveLength(2)
      await page.getByRole('button', { name: 'Talk', exact: true }).click()
      await expect(page.getByRole('status').filter({ hasText: /^Listening$/ })).toBeVisible()
      await page.getByRole('navigation', { name: 'Chats', exact: true }).getByRole('button', { name: 'New chat', exact: true }).click()
      await expect(page.getByRole('button', { name: 'Talk', exact: true })).toBeVisible()
      await page.evaluate(() => window.dispatchEvent(new CustomEvent('sotto:e2e:microphone', { detail: 'Wrong destination' })))
      const next = await page.evaluate(() => window.sotto!.personalChats!.get())
      expect(next.chats.find(chat => chat.id === next.selectedChatId)!.messages).toHaveLength(0)
    }
    await page.reload()
    await page.getByRole('link', { name: 'Chats', exact: true }).click()
    const reloaded = await page.evaluate(() => window.sotto!.personalChats!.get())
    expect(reloaded.chats.filter(chat => chat.messages.length > 0)).toHaveLength(3)
    await writeFile('artifacts/phase-five-personal-voice/software-journey.json', JSON.stringify({ physicalMicrophone: 'pending by user direction', measurements: evidence }, null, 2))
  } finally { await closeSotto(launched) }
})
