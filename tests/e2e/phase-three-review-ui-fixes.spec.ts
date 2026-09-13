import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { claudePending } from '../../src/main/agents/claudeRequests'
import { pendingRequest } from '../../src/main/agents/codexRequests'
import { defaultAgentConfiguration, type AgentRequest } from '../../src/shared/agents'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import { closeSotto, launchSotto, type LaunchedSotto } from './support/sottoLaunch'

// Two Spec review fixes in the complete app: the arrangement switch in a compact pane view, and a structured form's
// native explanation and tool context. Providers are fixtures; the request payloads come from the real provider mappers.
const SHOTS = 'artifacts/phase-three-review-ui-fixes'

async function size(launched: LaunchedSotto, width: number, height: number): Promise<void> {
  await launched.app.evaluate(({ BrowserWindow }, [width, height]) => {
    const window = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'))!
    // The shipped minimum is an outer size; relax it slightly so the content area can be exactly 820x560.
    window.setMinimumSize(800, 540)
    window.setContentSize(width, height)
  }, [width, height] as const)
  await expect.poll(() => launched.page.evaluate(() => `${window.innerWidth}x${window.innerHeight}`)).toBe(`${width}x${height}`)
}

async function shoot(page: Page, name: string, before?: () => Promise<void>): Promise<void> {
  for (const appearance of ['dark', 'light'] as const) {
    await page.evaluate(async mode => window.sotto!.updateSettings({ appearance: mode }), appearance)
    await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
    await before?.()
    await page.screenshot({ path: `${SHOTS}/${name}-${appearance}.png`, animations: 'disabled' })
  }
  await page.evaluate(async () => window.sotto!.updateSettings({ appearance: 'dark' }))
}

interface Rect { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number }

/** The shown pane's layout controls against everything they must not crowd: title, crumb, header actions, tabs, composer. */
const controlsLayout = (pane: Locator) => pane.evaluate(section => {
  const rect = (element: Element | Range | null): Rect | null => {
    if (!element) return null
    const box = element.getBoundingClientRect()
    return box.width && box.height ? { left: box.left, top: box.top, right: box.right, bottom: box.bottom } : null
  }
  const controls = section.querySelector('.thread-pane__controls')!
  const title = section.querySelector('.thread-workspace__title h2')!
  // The heading box can stretch across the header; measure the words themselves.
  const range = document.createRange()
  range.selectNodeContents(title)
  const others = {
    title: rect(range),
    crumb: rect(section.querySelector('.thread-workspace__crumb')),
    actions: [...section.querySelectorAll('.thread-workspace__actions button')].map(rect).filter(Boolean),
    tabs: rect(document.querySelector('.thread-panes__tabs')),
    compose: rect(section.querySelector('.thread-workspace__compose')),
  }
  return { controls: rect(controls)!, pane: rect(section)!, buttons: [...controls.querySelectorAll('button')].map(button => ({ name: button.getAttribute('aria-label'), ...rect(button)! })), others }
})

// Buttons carry transparent padding around their marks; boxes that meet within 4px on an axis are grazing, not crowding.
// (The placed grid's controls already graze the header's last action by about 2 × 3px at 1280.)
const GRAZE = 4
const overlaps = (a: Rect, b: Rect | null): boolean => b !== null && Math.min(a.right, b.right) - Math.max(a.left, b.left) > GRAZE && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > GRAZE

async function expectUncrowded(pane: Locator): Promise<void> {
  const layout = await controlsLayout(pane)
  for (const button of layout.buttons) expect([button.right - button.left, button.bottom - button.top]).toEqual([32, 34])
  expect(layout.controls.right).toBeLessThanOrEqual(layout.pane.right)
  expect(layout.controls.top).toBeGreaterThanOrEqual(layout.pane.top)
  const { title, crumb, actions, tabs, compose } = layout.others
  for (const [name, other] of [['title', title], ['crumb', crumb], ['tabs', tabs], ['compose', compose], ...actions.map((box, index) => [`action ${index}`, box] as const)] as const) {
    expect(overlaps(layout.controls, other), `layout controls overlap ${name}: ${JSON.stringify(layout)}`).toBe(false)
  }
}

test('a single row that goes compact keeps its arrangement switch, and the grid comes back from it at 1280 and 820', async () => {
  test.setTimeout(240_000)
  await mkdir(SHOTS, { recursive: true })
  const profile = await mkdtemp(join(tmpdir(), 'sotto-e2e-review-ui-fixes-'))
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, onboardingComplete: true, appearance: 'dark' }))
  await writeFile(join(profile, 'agents.json'), JSON.stringify({
    configuration: { ...defaultAgentConfiguration(), enabled: true, speak: false },
    assignments: [], queue: [], activeThreadId: 'grok-previews', activeProjectId: 'workshop',
    draft: '', draftThreadId: null, draftRequestId: null, composing: false, pendingRequest: '', outbox: [],
  }))
  const launched = await launchSotto('design-threads', profile)
  try {
    const { page } = launched
    await page.evaluate(async () => { await window.sotto!.agents!.command({ type: 'connect' }) })
    await size(launched, 1280, 800)
    await page.getByRole('link', { name: 'Threads', exact: true }).click()
    const panes = page.getByRole('group', { name: 'Thread panes' })
    const pane = (id: string) => panes.locator(`section.thread-pane[data-thread-id="${id}"]`)
    const sidebar = page.getByRole('complementary', { name: 'Thread sidebar' })
    for (const title of ['Footer links', 'Weekly note', 'Visual gate flake']) {
      await sidebar.getByRole('button', { name: title, exact: true }).hover()
      await sidebar.getByRole('button', { name: `Open ${title} beside`, exact: true }).click()
    }
    const placed = panes.locator('section.thread-pane[role="region"]:not([data-hidden])')
    await expect(placed).toHaveCount(4)
    await pane('footer-links').getByRole('textbox', { name: 'Prompt', exact: true }).fill('Footer draft through compact.')
    await pane('visual-gate').click({ position: { x: 200, y: 200 } })
    const rows = page.getByRole('separator', { name: 'Resize rows 1 and 2' })
    await rows.focus()
    await page.keyboard.press('ArrowUp')
    await expect(rows).toHaveAttribute('aria-valuenow', '45')
    const area = await page.locator('.thread-panes__area').boundingBox()
    // The grid fits this pane area; four panes in a row need 4 × 400px plus three dividers.
    expect(area!.width).toBeGreaterThanOrEqual(809)
    expect(area!.width).toBeLessThan(1627)
    await shoot(page, 'panes-grid-1280')
    await expectUncrowded(pane('visual-gate'))

    const tabs = page.getByRole('tablist', { name: 'Open panes' })
    const toggle = pane('visual-gate').getByRole('button', { name: 'Single row' })
    await toggle.click()
    await expect(tabs).toBeVisible()
    await expect(tabs.getByRole('tab', { name: 'Visual gate flake' })).toHaveAttribute('aria-selected', 'true')
    await expect(toggle).toBeVisible()
    await expect(toggle).toHaveAttribute('aria-pressed', 'true')
    await expect(pane('visual-gate').locator('.thread-pane__controls button')).toHaveCount(2)
    await shoot(page, 'panes-row-compact-1280')
    await expectUncrowded(pane('visual-gate'))

    // From the keyboard, back to the same grid.
    await toggle.focus()
    await page.keyboard.press('Enter')
    await expect(tabs).toHaveCount(0)
    await expect(placed).toHaveCount(4)
    await expect(rows).toHaveAttribute('aria-valuenow', '45')
    await expect(toggle).toHaveAttribute('aria-pressed', 'false')
    await expect(toggle).toBeFocused()
    await expect(pane('footer-links').getByRole('textbox', { name: 'Prompt', exact: true })).toHaveValue('Footer draft through compact.')
    await shoot(page, 'panes-grid-returned-1280')

    // At 820 neither arrangement fits the pane area, so the view is compact either way; the switch stays and says which
    // arrangement will return, and widening brings the one chosen here.
    await size(launched, 820, 560)
    await expect(tabs).toBeVisible()
    await expect(toggle).toHaveAttribute('aria-pressed', 'false')
    await shoot(page, 'panes-grid-compact-820')
    await expectUncrowded(pane('visual-gate'))
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-pressed', 'true')
    await expect(panes.locator('> [role="status"]')).toHaveText('Panes will be arranged in a single row when there is room')
    await shoot(page, 'panes-row-compact-820')
    await expectUncrowded(pane('visual-gate'))
    await toggle.focus()
    await page.keyboard.press('Space')
    await expect(toggle).toHaveAttribute('aria-pressed', 'false')
    await expect(toggle).toBeFocused()
    await expect(panes.locator('> [role="status"]')).toHaveText('Panes will be arranged in a grid when there is room')
    await size(launched, 1280, 800)
    await expect(tabs).toHaveCount(0)
    await expect(placed).toHaveCount(4)
    await expect(rows).toHaveAttribute('aria-valuenow', '45')
    await expect(pane('footer-links').getByRole('textbox', { name: 'Prompt', exact: true })).toHaveValue('Footer draft through compact.')
  } finally { await closeSotto(launched) }
})

const nativeMessage = 'The release-notes server needs a publishing target before it drafts v0.9.\nNothing is published until you confirm in the next step.'
const codexForm = (message: string): AgentRequest => pendingRequest('release-notes', 'mcpServer/elicitation/request', {
  threadId: 'native-thread', itemId: 'mcp-call-7', mode: 'form', message,
  requestedSchema: { type: 'object', required: ['channel'], properties: {
    channel: { type: 'string', title: 'Channel', description: 'Where should the notes go?', oneOf: [{ const: 'blog', title: 'Blog post' }, { const: 'email', title: 'Email digest' }] },
    note: { type: 'string', description: 'Anything reviewers should know' },
    reviewers: { type: 'integer', minimum: 1, description: 'How many reviewers must approve' },
  } },
}, 'native-thread')!.request
const claudeQuestions = (): AgentRequest => claudePending({ type: 'control_request', request_id: 'layout-question', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', tool_use_id: 'toolu_1', input: { questions: [
  { question: 'Which layout should the settings page use?', header: 'Layout', options: [{ label: 'Sidebar', description: 'Sections stay listed on the left.' }, { label: 'Tabs' }] },
  { question: 'Name the branch for this work.' },
] } } })!.request

/** The card reads once: the explanation is the provider's exact text, above the first field, and nowhere else. */
async function expectExplained(form: Locator): Promise<void> {
  await expect(form.locator('.agent-request__text')).toHaveText(nativeMessage, { useInnerText: true })
  expect(await form.evaluate(element => element.textContent!.split('publishing target').length - 1)).toBe(1)
  await expect(form.locator('.agent-request__head .agent-request__tag')).toHaveText('mcpServer/elicitation/request')
  expect(await form.evaluate(element => Boolean(element.querySelector('.agent-request__text')!.compareDocumentPosition(element.querySelector('fieldset')!) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true)
  await expect(form.getByRole('group')).toHaveCount(3)
  await expect(form.getByRole('radio')).toHaveCount(2)
  await expect(form.getByText('Optional', { exact: true })).toHaveCount(2)
}

/** In a short window, keyboard focus on Send brings it into view uncovered. */
async function expectSendReachable(page: Page, form: Locator): Promise<void> {
  // Start from the top of whatever scrolls the card, so reaching Send depends on focus alone.
  await form.evaluate(element => {
    for (let node = element.parentElement; node; node = node.parentElement) if (node.scrollHeight > node.clientHeight && getComputedStyle(node).overflowY !== 'visible') node.scrollTop = 0
  })
  const send = form.getByRole('button', { name: 'Send answers' })
  await form.getByRole('radio', { name: 'Email digest' }).focus()
  await page.keyboard.press('Space')
  await page.keyboard.press('Tab')
  await page.keyboard.press('Tab')
  await expect(send).toBeFocused()
  await expect.poll(() => send.evaluate(element => {
    const box = element.getBoundingClientRect()
    return document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2) === element && box.bottom <= window.innerHeight
  })).toBe(true)
}

test('threaded and personal structured forms show the native explanation and tool context once, in light and dark at 820', async () => {
  test.setTimeout(180_000)
  await mkdir(SHOTS, { recursive: true })
  const threaded = await launchSotto()
  try {
    const { page } = threaded
    await page.evaluate(async () => {
      await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark' })
      await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true, speak: false } })
      await window.sotto!.agents!.command({ type: 'connect' })
    })
    await page.reload()
    await page.getByRole('link', { name: 'Threads', exact: true }).click()
    const emit = (threadId: string, request: AgentRequest) => page.evaluate(async ([threadId, request]) => window.sottoE2E!.agentEvent!({ type: request.kind, threadId, text: request.text, request, status: 'running' }), [threadId, request] as const)
    await emit('workshop', codexForm(nativeMessage))
    await emit('docs', claudeQuestions())
    await size(threaded, 820, 560)
    await page.getByRole('button', { name: 'Workshop', exact: true }).click()
    const transcript = page.getByLabel('Thread transcript', { exact: true })
    const form = transcript.locator('.agent-request')
    await expectExplained(form)
    await shoot(page, 'form-threaded-codex-820', () => form.evaluate(element => element.scrollIntoView({ block: 'start' })))
    await expectSendReachable(page, form)
    await shoot(page, 'form-threaded-codex-send-820', async () => { await form.getByRole('button', { name: 'Send answers' }).evaluate(element => element.scrollIntoView({ block: 'end' })) })

    // A provider that fills the text from its own prompts gets no second copy.
    await page.getByRole('button', { name: 'Docs', exact: true }).click()
    const questions = transcript.locator('.agent-request')
    await expect(questions.getByRole('group')).toHaveCount(2)
    await expect(questions.locator('.agent-request__text')).toHaveCount(0)
    await expect(questions.locator('.agent-request__head')).toHaveText('2 questionsAskUserQuestion')
    expect(await questions.evaluate(element => element.textContent!.split('Which layout should the settings page use?').length - 1)).toBe(1)
    await shoot(page, 'form-threaded-claude-820', () => questions.evaluate(element => element.scrollIntoView({ block: 'start' })))
  } finally { await closeSotto(threaded) }

  const profile = await mkdtemp(join(tmpdir(), 'sotto-e2e-review-ui-fixes-personal-'))
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, onboardingComplete: true, historyEnabled: true, appearance: 'dark' }))
  const personal = await launchSotto('success', profile)
  try {
    const { page } = personal
    const id = await page.evaluate(async () => {
      await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true, speak: false, reasoning: 'codex', reasoningModel: 'codex:test', reasoningEffort: 'low' } })
      const bridge = window.sotto!.personalChats!
      await bridge.connect()
      const id = (await bridge.create()).selectedChatId!
      await bridge.saveDraft({ chatId: id, revision: 1, text: 'Draft the v0.9 release notes', skills: [] })
      await bridge.send({ chatId: id, revision: 1 })
      return id
    })
    await expect.poll(() => page.evaluate(async id => (await window.sotto!.personalChats!.get()).chats.find(chat => chat.id === id)?.submissions[0]?.status, id)).toBe('accepted')
    await page.getByRole('link', { name: 'Chats', exact: true }).click()
    await page.evaluate(async ([id, request]) => window.sottoE2E!.agentEvent!({ scope: 'personal', type: 'question', threadId: id, text: '', request }), [id, codexForm(nativeMessage)] as const)
    await size(personal, 820, 560)
    const form = page.locator('.agent-request[data-kind="question"]')
    await expectExplained(form)
    await shoot(page, 'form-personal-codex-820', () => form.evaluate(element => element.scrollIntoView({ block: 'start' })))
    await expectSendReachable(page, form)
    await form.getByRole('button', { name: 'Send answers' }).click()
    await expect(form).toHaveCount(0)
    const chat = await page.evaluate(async id => (await window.sotto!.personalChats!.get()).chats.find(chat => chat.id === id)!, id)
    expect(chat.decisions?.at(-1)?.status).toBe('accepted')
    expect(chat.messages.filter(message => message.role === 'user')).toHaveLength(1)
  } finally { await closeSotto(personal) }
})
