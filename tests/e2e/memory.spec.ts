import { expect, test, type Page } from '@playwright/test'
import { closeSotto, launchSotto } from './support/sottoLaunch'

async function snapshot(page: Page) { return page.evaluate(() => window.sotto!.memory!.get()) }

test('remembers working preferences across restart, retains supersession history and keeps policies separate', async () => {
  const original = await launchSotto()
  let launched = original
  try {
    let page = launched.page
    await page.evaluate(() => window.sotto!.updateSettings({ onboardingComplete: true }))
    await page.reload()
    await expect(page.getByRole('tab', { name: 'Dictate', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByRole('heading', { name: 'How should Sotto keep you in the loop?' })).toHaveCount(0)
    await page.getByRole('tab', { name: 'Agents', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'How should Sotto keep you in the loop?' })).toBeFocused()
    await page.getByRole('textbox').fill('Give concise replies and interrupt only when I need to decide.')
    await page.screenshot({ animations: 'disabled', path: 'artifacts/memory/questionnaire.png' })
    await page.getByRole('button', { name: 'Not now', exact: true }).click()
    await page.getByRole('link', { name: 'Memory', exact: true }).click()
    await expect(page.getByText('Sotto has no saved memories yet.')).toBeVisible()
    await page.getByRole('button', { name: 'Set working preferences', exact: true }).click()
    await expect(page.getByRole('textbox')).toHaveValue('Give concise replies and interrupt only when I need to decide.')
    await page.getByRole('button', { name: 'Continue', exact: true }).click()
    for (let index = 0; index < 6; index++) {
      await page.getByRole('button', { name: 'No preference', exact: true }).click()
      await page.getByRole('button', { name: 'Continue', exact: true }).click()
    }
    await page.getByRole('checkbox', { name: 'Starting new spending' }).check()
    await page.getByRole('checkbox', { name: 'Publishing or sending work outside Sotto' }).check()
    await page.screenshot({ animations: 'disabled', path: 'artifacts/memory/boundaries.png' })
    await page.getByRole('button', { name: 'Continue', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Here’s what Sotto will remember' })).toBeVisible()
    await page.screenshot({ animations: 'disabled', path: 'artifacts/memory/review.png' })
    expect((await snapshot(page)).memories).toHaveLength(0)
    await page.getByRole('button', { name: 'Save preferences', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'What Sotto remembers' })).toBeVisible()
    const saved = await snapshot(page)
    expect(saved.memories).toHaveLength(7)
    expect(saved.policies).toHaveLength(2)
    expect(saved.memories.every(memory => memory.authority === 'preference' && memory.sourceClass === 'explicit')).toBe(true)
    const row = page.getByRole('article', { name: 'Give concise replies and interrupt only when I need to decide.', exact: true })
    await row.getByRole('button', { name: 'Edit', exact: true }).click()
    await row.getByRole('textbox', { name: 'Edit memory' }).fill('Give detailed replies with the reasoning behind each decision.')
    await row.getByRole('button', { name: 'Save memory', exact: true }).click()
    await expect(page.getByRole('article', { name: 'Give detailed replies with the reasoning behind each decision.', exact: true })).toBeVisible()
    await page.getByRole('checkbox', { name: 'Show past versions' }).check()
    await expect(row).toContainText('Superseded')
    await row.getByText('Why Sotto remembers this', { exact: true }).click()
    await expect(row).toContainText('Working preferences')
    await page.screenshot({ animations: 'disabled', path: 'artifacts/memory/history.png' })
    await launched.app.close()
    launched = await launchSotto('success', original.userData)
    page = launched.page
    await page.getByRole('tab', { name: 'Agents', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'How should Sotto keep you in the loop?' })).toHaveCount(0)
    await page.getByRole('link', { name: 'Memory', exact: true }).click()
    const edited = page.getByRole('article', { name: 'Give detailed replies with the reasoning behind each decision.', exact: true })
    await expect(edited).toBeVisible()
    expect((await snapshot(page)).policies).toEqual(saved.policies)
    await page.screenshot({ animations: 'disabled', path: 'artifacts/memory/inspector.png' })
    await launched.app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'))!; window.setMinimumSize(320, 400); window.setSize(420, 740) })
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(420)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ animations: 'disabled', path: 'artifacts/memory/inspector-narrow.png' })
    await edited.getByRole('button', { name: 'Supersede', exact: true }).click()
    await edited.getByRole('textbox', { name: 'Replacement memory' }).fill('Keep spoken answers brief; put the detail in writing.')
    await edited.getByRole('button', { name: 'Save memory', exact: true }).click()
    const current = page.getByRole('article', { name: 'Keep spoken answers brief; put the detail in writing.', exact: true })
    await current.getByRole('button', { name: 'Delete', exact: true }).click()
    await expect(current).toContainText('all its past versions')
    await current.getByRole('button', { name: 'Delete memory', exact: true }).click()
    await expect(current).toHaveCount(0)
    const final = await snapshot(page)
    expect(final.memories).toHaveLength(6)
    expect(final.memories.some(memory => memory.tags.includes('communication'))).toBe(false)
    expect(final.policies).toEqual(saved.policies)
  } finally {
    await closeSotto(launched)
    if (launched !== original) await closeSotto(original)
  }
})

test('keeps an unsaved correction when another edit supersedes its memory', async () => {
  const launched = await launchSotto()
  const { page } = launched
  try {
    const originalId = await page.evaluate(async () => {
      await window.sotto!.updateSettings({ onboardingComplete: true })
      const saved = await window.sotto!.memory!.command({ type: 'complete-questionnaire',
        answers: ['communication', 'autonomy', 'verification', 'git', 'agents', 'workflow', 'privacy'].map(topic => ({ topic, content: `${topic}: no preference` })) as { topic: 'communication' | 'autonomy' | 'verification' | 'git' | 'agents' | 'workflow' | 'privacy'; content: string }[], boundaries: [],
      })
      return saved.memories.find(memory => memory.tags.includes('communication'))!.id
    })
    await page.reload()
    await page.getByRole('link', { name: 'Memory', exact: true }).click()
    const row = page.getByRole('article', { name: 'communication: no preference', exact: true })
    await row.getByRole('button', { name: 'Edit', exact: true }).click()
    await row.getByRole('textbox', { name: 'Edit memory' }).fill('Keep spoken replies brief and show details in writing.')
    await page.evaluate(id => window.sotto!.memory!.command({ type: 'edit', id, content: 'Include a summary with every reply.' }), originalId)
    await expect(row.getByRole('textbox', { name: 'Edit memory' })).toHaveValue('Keep spoken replies brief and show details in writing.')
    await expect(row.getByRole('button', { name: 'Review current replacement' })).toBeVisible()
    await launched.app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'))!; window.setMinimumSize(320, 400); window.setSize(720, 760) })
    await row.scrollIntoViewIfNeeded()
    await page.screenshot({ animations: 'disabled', path: 'artifacts/memory/stale-edit.png' })
    await row.getByRole('button', { name: 'Review current replacement' }).click()
    const current = page.getByRole('article', { name: 'Include a summary with every reply.', exact: true })
    await expect(current).toContainText('Include a summary with every reply.')
    await expect(current.getByRole('textbox', { name: 'Edit memory' })).toHaveValue('Keep spoken replies brief and show details in writing.')
    await current.getByRole('button', { name: 'Save memory', exact: true }).click()
    await expect(page.getByRole('article', { name: 'Keep spoken replies brief and show details in writing.', exact: true })).toBeVisible()
  } finally { await closeSotto(launched) }
})
