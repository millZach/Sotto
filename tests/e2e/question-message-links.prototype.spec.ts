// PROTOTYPE — throwaway. Screenshots each question-card variant from a build made with VITE_SOTTO_PROTOTYPE=1.
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import type { AgentRequest } from '../../src/shared/agents'
import { closeSotto, launchSotto, openThreads } from './support/sottoLaunch'
import { evidenceDirectory } from '../fixtures/evidence'

const evidence = evidenceDirectory('artifacts/question-message-links-prototype')

const message = [
  '**Review page:** http://localhost:8075/ (it’s open in your browser)',
  'I found why the page looks different. Every other Settings page is a flat list of rows split by thin lines. Cloud iPhone uses three boxed cards instead.',
  'I built three layouts that follow the other pages, plus today’s for comparison. The variants are also on https://github.com/millZach/Sotto/tree/prototype/cloud-iphone-settings-layout.',
].join('\n\n')

const question: AgentRequest = {
  id: 'layout-choice', kind: 'question', text: 'Which layout should Settings > Cloud iPhone use?', options: [], questions: [{
    id: 'layout', header: 'Layout', question: 'Which layout should Settings > Cloud iPhone use?', multiSelect: false, allowFreeText: true,
    options: [
      { id: 'a', label: 'A · Groups (Recommended)', description: 'Three small headings with icons, as Git groups its settings.' },
      { id: 'b', label: 'B · One list', description: 'No subheadings, one run of rows like Output.' },
      { id: 'c', label: 'C · Usage first', description: 'This month’s minutes lead with a wide meter.' },
    ],
  }],
}

async function resize(app: ElectronApplication, page: Page, width: number, height: number): Promise<void> {
  await app.evaluate(({ BrowserWindow }, [width, height]) => {
    BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'))!.setContentSize(width, height)
  }, [width, height] as const)
  await expect.poll(() => page.evaluate(([width, height]) => window.innerWidth === width && Math.abs(window.innerHeight - height) <= 2, [width, height] as const)).toBe(true)
}

test('captures every question-card links variant', async () => {
  test.setTimeout(240_000)
  await mkdir(evidence, { recursive: true })
  const launched = await launchSotto()
  const { page, app } = launched
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  try {
    await page.evaluate(async () => {
      await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark', reducedMotion: 'on' })
      await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true } })
      await window.sotto!.agents!.command({ type: 'connect' })
    })
    await page.reload()
    await openThreads(page)
    await page.getByRole('complementary', { name: 'Thread sidebar' }).getByRole('button', { name: 'Workshop', exact: true }).click()
    const say = (type: 'manual' | 'ready', text: string) => page.evaluate(async ([type, text]) => window.sottoE2E!.agentEvent!({ type, threadId: 'workshop', text, status: 'running' }), [type, text] as const)
    await say('manual', 'The cloud iPhone page in settings looks different than all the other setting pages. Can you make sure the layout matches?')
    await say('ready', message)
    await page.evaluate(async request => window.sottoE2E!.agentEvent!({ type: 'question', threadId: 'workshop', text: request.text, request, status: 'running' }), question)
    const card = page.locator('.thread-questions .agent-request')
    await expect(card).toBeVisible()
    const bar = page.getByRole('group', { name: 'Prototype variants' })
    await expect(bar).toBeVisible()
    for (const [width, height] of [[1280, 800], [820, 560]] as const) {
      await resize(app, page, width, height)
      for (const variant of ['A', 'B', 'C', 'Now']) {
        while ((await bar.locator('b').textContent()) !== variant) await bar.getByRole('button', { name: 'Next variant' }).click()
        for (const mode of width === 1280 ? ['dark', 'light'] as const : ['dark'] as const) {
          await page.evaluate(async appearance => window.sotto!.updateSettings({ appearance }), mode)
          await expect(page.locator('html')).toHaveAttribute('data-theme', mode)
          await page.mouse.move(1, 1)
          await page.screenshot({ path: join(evidence, `${variant}-${width}-${mode}.png`), animations: 'disabled', caret: 'hide' })
        }
      }
    }
    expect(errors).toEqual([])
  } finally {
    await closeSotto(launched)
  }
})
