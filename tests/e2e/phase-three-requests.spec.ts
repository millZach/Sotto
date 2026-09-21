import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import type { AgentCommand, AgentRequest, AgentState } from '../../src/shared/agents'
import { closeSotto, launchSotto, openThreads, paneMenuAction, type LaunchedSotto } from './support/sottoLaunch'

// #52 in the complete app: AppShell, Threads page, main controller, IPC and preload are real. Only the provider
// effects come from the explicit unpackaged E2E host, and requests arrive through window.sottoE2E.agentEvent.

type Recorder = { answers: AgentCommand[]; release: (() => void) | null; hold: Promise<void> | null }
declare global { var requestJourney: Recorder | undefined }

const AGENT_COMMAND = 'sotto:agents:command'
const nativeOnly = 'This field needs the native Codex client; Sotto cannot submit this field type or its validation rules.'

const layoutForm: AgentRequest = {
  id: 'layout-form', kind: 'question', text: 'Settings page questions', options: [], questions: [
    { id: 'layout', header: 'Layout', question: 'Which layout should the settings page use?', multiSelect: false, allowFreeText: true,
      options: [{ id: 'sidebar', label: 'Sidebar', description: 'Sections stay listed on the left.' }, { id: 'tabs', label: 'Tabs', description: 'One section at a time across the top.' }] },
    { id: 'checks', header: 'Checks', question: 'Which checks should run before you finish?', multiSelect: true, allowFreeText: false,
      options: [{ id: 'unit', label: 'Unit tests' }, { id: 'types', label: 'Typecheck' }, { id: 'e2e', label: 'Electron journeys' }] },
    { id: 'branch', question: 'Name the branch for this work.', multiSelect: false, allowFreeText: true, options: [] },
    { id: 'depth', question: 'How thorough should the review be?', multiSelect: false, allowFreeText: false, required: false,
      options: [{ id: 'quick', label: 'Quick review' }, { id: 'full', label: 'Full review' }] },
    { id: 'workers', question: 'Parallel workers', multiSelect: false, allowFreeText: false, required: false, options: [], unavailableReason: nativeOnly },
  ],
}
const audienceForm: AgentRequest = {
  id: 'audience-form', kind: 'question', text: 'Guide questions', options: [], questions: [
    { id: 'audience', question: 'Who should the guide address?', multiSelect: false, allowFreeText: false,
      options: [{ id: 'new', label: 'New contributors' }, { id: 'maintainers', label: 'Maintainers' }] },
    { id: 'deadline', header: 'Deadline', question: 'Publish date', multiSelect: false, allowFreeText: false, required: true, options: [], unavailableReason: nativeOnly },
  ],
}
const testPermission: AgentRequest = {
  id: 'run-tests', kind: 'permission', text: 'Run the settings tests', options: [],
  context: { toolName: 'Bash', toolCallId: 'tool-1', command: 'npm run test -- tests/unit/settings', cwd: 'C:\\work\\sotto' },
  permissionChoices: [
    { id: 'once', label: 'Allow once', kind: 'allow-once' },
    { id: 'acceptForSession', label: 'Allow for this session', kind: 'allow-session' },
    { id: 'allow_always', label: 'Always allow npm run test', kind: 'allow-always', description: 'The provider remembers this command for the project.' },
    { id: 'reject', label: 'Deny', kind: 'deny' },
  ],
}
const networkPermission: AgentRequest = {
  id: 'network-profile', kind: 'permission', text: 'Grant additional permissions', options: [], permissionChoices: [],
  context: { toolName: 'item/permissions/requestApproval', details: '{"permissions":{"network":{"enabled":true}}}' },
}

async function prepare(launched: LaunchedSotto): Promise<void> {
  const { page } = launched
  await page.evaluate(async () => {
    await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark', accent: 'blue' })
    await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true, speak: false } })
    await window.sotto!.agents!.command({ type: 'connect' })
  })
  await page.reload()
  await openThreads(page)
  // Observe (and optionally hold) answer commands as they cross into main; the real handler still answers them.
  await launched.app.evaluate(({ ipcMain }, channel) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers?: Map<string, (event: unknown, payload: unknown) => unknown> })._invokeHandlers
    const original = handlers?.get(channel)
    if (!handlers || !original) throw new Error('The agent command handler is not registered.')
    const recorder: Recorder = { answers: [], release: null, hold: null }
    globalThis.requestJourney = recorder
    handlers.set(channel, async (event, payload) => {
      if ((payload as AgentCommand).type === 'answer') {
        recorder.answers.push(structuredClone(payload as AgentCommand))
        if (recorder.hold) await recorder.hold
      }
      return original(event, payload)
    })
  }, AGENT_COMMAND)
}

const answers = (app: ElectronApplication): Promise<AgentCommand[]> => app.evaluate(() => globalThis.requestJourney!.answers)
const hold = (app: ElectronApplication): Promise<void> => app.evaluate(() => {
  const recorder = globalThis.requestJourney!
  recorder.hold = new Promise(resolve => { recorder.release = () => { recorder.hold = null; recorder.release = null; resolve() } })
})
const release = (app: ElectronApplication): Promise<void> => app.evaluate(() => { globalThis.requestJourney!.release?.() })
const state = (page: Page): Promise<AgentState> => page.evaluate(() => window.sotto!.agents!.get())
const pending = async (page: Page, threadId: string): Promise<string[]> => (await state(page)).host.threads.find(thread => thread.id === threadId)!.requests.map(request => request.id)

async function emit(page: Page, threadId: string, request: AgentRequest): Promise<void> {
  await page.evaluate(async ([threadId, request]) => window.sottoE2E!.agentEvent!({ type: request.kind, threadId, text: request.text, request, status: 'running' }), [threadId, request] as const)
}

async function selectThread(page: Page, title: string): Promise<void> {
  await page.getByRole('button', { name: title, exact: true }).click()
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible()
}

const transcript = (page: Page): Locator => page.getByLabel('Thread transcript', { exact: true })
const card = (page: Page): Locator => page.locator('.agent-request')

async function resize(launched: LaunchedSotto, width: number, height: number): Promise<void> {
  await launched.app.evaluate(({ BrowserWindow }, [width, height]) => {
    BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'))!.setContentSize(width, height)
  }, [width, height] as const)
  // The window's own 820 × 560 minimum can round the content height up by a pixel or two.
  await expect.poll(() => launched.page.evaluate(([width, height]) => window.innerWidth === width && Math.abs(window.innerHeight - height) <= 2, [width, height] as const)).toBe(true)
}

/** Questions scroll above the message bar; permissions stay in the transcript, with neither clipping the composer. */
async function expectRoomy(page: Page, minimumLog: number): Promise<void> {
  const layout = await page.evaluate(() => {
    const log = document.querySelector('[aria-label="Thread transcript"]')!
    const compose = document.querySelector('.thread-workspace__compose')!.getBoundingClientRect()
    const request = document.querySelector('.agent-request')!
    const questions = document.querySelector('.thread-questions')
    const prompt = document.querySelector('.thread-prompt textarea')?.getBoundingClientRect()
    return { logHeight: log.clientHeight, composeBottom: compose.bottom, composeTop: compose.top, height: window.innerHeight,
      pageOverflow: document.documentElement.scrollWidth - window.innerWidth, cardOverflow: request.scrollWidth - request.clientWidth,
      logBottom: log.getBoundingClientRect().bottom,
      questionsHeight: questions?.clientHeight ?? null, questionsBottom: questions?.getBoundingClientRect().bottom ?? null,
      promptTop: prompt?.top ?? null }
  })
  expect(layout.composeBottom).toBeLessThanOrEqual(layout.height + 1)
  expect(layout.logBottom).toBeLessThanOrEqual(layout.composeTop + 1)
  expect(layout.logHeight).toBeGreaterThanOrEqual(layout.questionsHeight === null ? minimumLog : 60)
  if (layout.questionsHeight !== null) {
    expect(layout.questionsHeight).toBeGreaterThan(0)
    expect(layout.questionsHeight).toBeLessThan(layout.height)
    expect(layout.promptTop).not.toBeNull()
    expect(layout.questionsBottom).toBeLessThanOrEqual(layout.promptTop! + 1)
  }
  expect(layout.pageOverflow).toBeLessThanOrEqual(0)
  expect(layout.cardOverflow).toBeLessThanOrEqual(0)
}

async function capture(launched: LaunchedSotto, name: string, scrollTo?: Locator, minimumLog = 180): Promise<void> {
  const sizes = [[1280, 860], [820, 560]] as const
  for (const [width, height] of sizes) {
    await resize(launched, width, height)
    for (const appearance of ['dark', 'light'] as const) {
      await launched.page.evaluate(async mode => window.sotto!.updateSettings({ appearance: mode }), appearance)
      await expect(launched.page.locator('html')).toHaveAttribute('data-theme', appearance)
      if (scrollTo) await scrollTo.evaluate(element => element.scrollIntoView({ block: 'start' }))
      await expectRoomy(launched.page, minimumLog)
      await launched.page.screenshot({ path: `artifacts/crossing/phase3-requests-${name}-${width}-${appearance}.png`, animations: 'disabled' })
    }
  }
  await resize(launched, 1280, 860)
  await launched.page.evaluate(async () => window.sotto!.updateSettings({ appearance: 'dark' }))
}

async function outbox(userData: string): Promise<unknown[]> {
  const found: string[] = []
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) await walk(join(directory, entry.name))
      else if (entry.name === 'agents.json') found.push(join(directory, entry.name))
    }
  }
  await walk(userData)
  expect(found).toHaveLength(1)
  return (JSON.parse(await readFile(found[0]!, 'utf8')) as { outbox?: unknown[] }).outbox ?? []
}

test('answers every native question in the thread that asked, keeping simultaneous selections and omitting optional fields', async () => {
  test.setTimeout(120_000)
  const launched = await launchSotto()
  const { page, app } = launched
  try {
    await prepare(launched)
    await emit(page, 'workshop', layoutForm)
    await emit(page, 'docs', audienceForm)
    await selectThread(page, 'Workshop')

    const form = card(page)
    await expect(form.getByRole('group')).toHaveCount(5)
    await expect(form.getByText('Optional', { exact: true })).toHaveCount(2)
    const workers = form.getByRole('group', { name: /Parallel workers/u })
    await expect(workers).toContainText(nativeOnly)
    await expect(workers.locator('input, textarea')).toHaveCount(0)
    const send = form.getByRole('button', { name: 'Send answers' })
    await expect(send).toBeDisabled()

    await form.getByRole('radio', { name: /Sidebar/u }).click()
    await form.getByRole('checkbox', { name: 'Unit tests' }).click()
    await form.getByRole('checkbox', { name: 'Typecheck' }).click()
    await form.getByRole('radio', { name: 'Full review' }).click()
    const clear = form.getByRole('button', { name: 'Clear choice for How thorough should the review be?' })
    await clear.focus()
    await page.keyboard.press('Enter')
    await expect(form.getByRole('radio', { name: 'Full review' })).not.toBeChecked()
    await expect(form.getByRole('radio', { name: 'Quick review' })).toBeFocused()
    await expect(clear).toHaveCount(0)
    await expect(form.getByText('1 left to answer')).toBeVisible()
    await expect(send).toBeDisabled()

    // The other thread's request is answered in its own pane and holds its own choice.
    await selectThread(page, 'Docs')
    const docs = card(page)
    await docs.getByRole('radio', { name: 'Maintainers' }).click()
    await expect(docs.getByRole('group', { name: /Publish date/u })).toContainText(nativeOnly)
    await expect(docs.getByText('Finish this form in the provider’s app.')).toBeVisible()
    await expect(docs.getByRole('button', { name: 'Send answers' })).toBeDisabled()
    await capture(launched, 'docs-required-unavailable', docs)

    await selectThread(page, 'Workshop')
    await expect(form.getByRole('radio', { name: /Sidebar/u })).toBeChecked()

    // A provider disconnect blocks the choices without forgetting them; the pane's own Reconnect restores the same request.
    await page.evaluate(async () => window.sottoE2E!.agentEvent!({ type: 'disconnect', threadId: 'workshop', text: '' }))
    await expect(form.getByText(/^Reconnect .+ to answer\.$/u)).toBeVisible()
    await expect(form.getByRole('radio', { name: /Sidebar/u })).toBeDisabled()
    await paneMenuAction(page, 'Reconnect')
    await expect(form.getByRole('radio', { name: /Sidebar/u })).toBeEnabled()
    expect(await pending(page, 'workshop')).toEqual(['layout-form'])
    await expect(form.getByRole('checkbox', { name: 'Unit tests' })).toBeChecked()
    await expect(form.getByRole('checkbox', { name: 'Typecheck' })).toBeChecked()
    await form.getByRole('textbox', { name: 'Name the branch for this work.' }).fill('settings-layou')
    await capture(launched, 'workshop-form', form)
    await capture(launched, 'workshop-form-footer', send)
    expect(await answers(app)).toEqual([])

    // Keyboard only from here: finish the text answer, then activate the explicit Send answers button.
    const branch = form.getByRole('textbox', { name: 'Name the branch for this work.' })
    await branch.focus()
    await page.keyboard.press('End')
    await page.keyboard.type('t')
    await expect(form.getByText('Ready to send')).toBeVisible()
    await send.focus()
    await page.keyboard.press('Enter')
    await expect(card(page)).toHaveCount(0)

    expect(await answers(app)).toEqual([{ type: 'answer', threadId: 'workshop', requestId: 'layout-form', answer: '', questionAnswers: {
      layout: { optionIds: ['sidebar'] }, checks: { optionIds: ['unit', 'types'] }, branch: { optionIds: [], text: 'settings-layout' },
    } }])
    const after = await state(page)
    expect(after.error).toBeNull()
    expect(after.assignments).toEqual([])
    expect(await pending(page, 'workshop')).toEqual([])
    expect(await pending(page, 'docs')).toEqual(['audience-form'])
    expect(await outbox(launched.userData)).toEqual([])

    await selectThread(page, 'Docs')
    await expect(card(page).getByRole('radio', { name: 'Maintainers' })).toBeChecked()
    expect(await answers(app)).toHaveLength(1)
  } finally { await closeSotto(launched) }
})

test('offers only native approval choices, keeps a refused answer, and sends a held answer once', async () => {
  test.setTimeout(120_000)
  const launched = await launchSotto()
  const { page, app } = launched
  try {
    await prepare(launched)
    await emit(page, 'workshop', testPermission)
    await emit(page, 'docs', networkPermission)

    await selectThread(page, 'Docs')
    const network = card(page)
    await expect(network.getByText('Sotto has no choice it can send for this request. Answer it in the provider’s app.')).toBeVisible()
    await expect(network.getByRole('button')).toHaveCount(0)
    await expect(network.getByText(/Say “allow”/u)).toHaveCount(0)
    await capture(launched, 'permission-no-choices', network)

    await selectThread(page, 'Workshop')
    const approval = card(page)
    await expect(approval.getByRole('button')).toHaveText(['Allow once', 'Allow for this session', 'Always allow npm run test', 'Deny'])
    await expect(approval.getByText('npm run test -- tests/unit/settings')).toBeVisible()
    await expect(approval.getByText('The provider remembers this command for the project.')).toBeVisible()
    await capture(launched, 'permission-choices', approval)

    // In the shortest window, keyboard focus from an older reading position brings each choice into view, uncovered.
    await resize(launched, 820, 560)
    await transcript(page).evaluate(element => { element.scrollTop = 0 })
    // The jump control steps aside while request choices occupy its bottom band.
    await expect(page.getByRole('button', { name: 'Jump to latest' })).toHaveCount(0)
    await approval.getByRole('button', { name: 'Allow once' }).focus()
    for (const name of ['Allow once', 'Allow for this session', 'Always allow npm run test', 'Deny']) {
      const choice = approval.getByRole('button', { name, exact: true })
      await expect(choice).toBeFocused()
      await expect.poll(() => choice.evaluate(element => {
        const box = element.getBoundingClientRect()
        return document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2) === element
          && document.elementFromPoint(box.left + box.width / 2, box.bottom - 2) === element
      })).toBe(true)
      if (name !== 'Deny') await page.keyboard.press('Tab')
    }
    await resize(launched, 1280, 860)

    // A provider refusal leaves the original request answerable, with the reason in the card.
    await page.evaluate(async () => window.sottoE2E!.agentEvent!({ type: 'reject', threadId: 'workshop', text: 'Claude could not accept that decision right now.' }))
    await approval.getByRole('button', { name: 'Allow for this session' }).click()
    await expect(approval.getByRole('alert')).toContainText('Claude could not accept that decision right now.')
    await expect(approval.getByRole('button', { name: 'Allow for this session' })).toBeEnabled()
    expect(await pending(page, 'workshop')).toEqual(['run-tests'])
    // The refusal appears once in its request card, without a duplicate workspace banner.
    await capture(launched, 'permission-refused', approval, 160)

    // A slow bridge: the card holds on Sending…, a second press does nothing, and switching threads keeps it held.
    await hold(app)
    await approval.getByRole('button', { name: 'Allow once' }).focus()
    await page.keyboard.press('Enter')
    await expect(approval.getByText('Sending…', { exact: true })).toBeVisible()
    await expect(approval.getByRole('button', { name: 'Allow once' })).toBeDisabled()
    await page.keyboard.press('Enter')
    await selectThread(page, 'Docs')
    await selectThread(page, 'Workshop')
    await expect(card(page).getByText('Sending…', { exact: true })).toBeVisible()
    await expect(card(page).getByRole('button', { name: 'Deny' })).toBeDisabled()
    await page.screenshot({ path: 'artifacts/crossing/phase3-requests-permission-sending-1280-dark.png', animations: 'disabled' })
    await release(app)
    await expect(card(page)).toHaveCount(0)

    expect(await answers(app)).toEqual([
      { type: 'answer', threadId: 'workshop', requestId: 'run-tests', answer: 'Allow for this session', approved: true, permissionChoice: 'acceptForSession' },
      { type: 'answer', threadId: 'workshop', requestId: 'run-tests', answer: 'Allow once', approved: true, permissionChoice: 'once' },
    ])
    expect(await pending(page, 'workshop')).toEqual([])
    expect(await pending(page, 'docs')).toEqual(['network-profile'])
    expect((await state(page)).assignments).toEqual([])
    expect(await outbox(launched.userData)).toEqual([])
  } finally { await closeSotto(launched) }
})


test('keeps model choices above the message bar until an explicit answer, preserving a separate prompt draft', async () => {
  test.setTimeout(120_000)
  const launched = await launchSotto()
  const { page, app } = launched
  const question = 'How should we organize the settings page?'
  const request: AgentRequest = {
    id: 'question-choices', kind: 'question', text: question, options: [], questions: [{
      id: 'layout', question, multiSelect: false, allowFreeText: true,
      options: [
        { id: 'sidebar (Recommended)', label: 'Sections in a sidebar (Recommended)', description: 'Keep each section easy to find as settings grow.' },
        { id: 'tabs', label: 'Tabs across the top', description: 'Show one section at a time in a familiar layout.' },
        { id: 'single', label: 'One scrolling page', description: 'Keep all settings together in one place.' },
      ],
    }],
  }
  try {
    await prepare(launched)
    await selectThread(page, 'Workshop')
    const prompt = page.getByRole('textbox', { name: 'Prompt', exact: true })
    await prompt.fill('Keep keyboard navigation consistent with the rest of the app.')
    await expect(prompt).toHaveValue('Keep keyboard navigation consistent with the rest of the app.')
    await emit(page, 'workshop', request)
    const panel = page.locator('.thread-workspace__compose .thread-questions')
    const form = panel.locator('.agent-request')
    await expect(form).toBeVisible()
    await expect(prompt).toHaveValue('Keep keyboard navigation consistent with the rest of the app.')
    await expect(transcript(page).locator('.agent-request')).toHaveCount(0)
    await expect(form.getByText('(recommended)', { exact: true })).toBeVisible()
    const recommended = form.getByRole('radio', { name: /Sections in a sidebar/u })
    const custom = form.getByRole('textbox', { name: `Other answer to: ${question}` })
    const customChoice = form.getByRole('radio', { name: 'Write my own answer', exact: true })
    const send = form.getByRole('button', { name: 'Send answer', exact: true })
    await expect(custom).toBeVisible()
    await expect(recommended).not.toBeChecked()
    await expect(customChoice).not.toBeChecked()
    await expect(send).toBeDisabled()
    await recommended.click()
    await expect(recommended).toBeChecked()
    await expect(send).toBeEnabled()
    expect(await answers(app)).toEqual([])

    // The user's custom response survives both another choice and a collapsed panel.
    await custom.fill('Use the sidebar layout')
    await expect(customChoice).toBeChecked()
    await custom.press('End')
    await custom.press('Enter')
    await custom.pressSequentially('with a search field.')
    await expect(custom).toHaveValue('Use the sidebar layout\nwith a search field.')
    expect(await answers(app)).toEqual([])
    await recommended.click()
    await expect(custom).toHaveValue('Use the sidebar layout\nwith a search field.')
    await customChoice.click()
    await custom.focus()
    await custom.press('Escape')
    const reopen = form.getByRole('button', { name: 'Show question', exact: true })
    await expect(reopen).toBeFocused()
    await expect(custom).toBeHidden()
    await expect(prompt).toHaveValue('Keep keyboard navigation consistent with the rest of the app.')
    await reopen.press('Enter')
    await expect(custom).toBeVisible()
    await expect(customChoice).toBeChecked()
    await expect(custom).toHaveValue('Use the sidebar layout\nwith a search field.')
    expect(await answers(app)).toEqual([])

    // Retain the approved stacked-choice state in every required window, theme and motion mode.
    await recommended.click()
    for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560]] as const) {
      await resize(launched, width, height)
      for (const appearance of ['dark', 'light'] as const) {
        await page.evaluate(async mode => window.sotto!.updateSettings({ appearance: mode }), appearance)
        await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
        for (const reducedMotion of ['no-preference', 'reduce'] as const) {
          await page.emulateMedia({ reducedMotion })
          if (reducedMotion === 'reduce') expect(await form.evaluate(element => getComputedStyle(element).animationName)).toBe('none')
          await page.screenshot({ path: `artifacts/question-choices/choices-${width}x${height}-${appearance}-${reducedMotion}.png`, animations: 'disabled' })
          await expectRoomy(page, 60)
          await expect(prompt).toBeInViewport()
        }
      }
    }

    // The app's reduced-motion setting also overrides a system with motion enabled.
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await page.evaluate(async () => window.sotto!.updateSettings({ reducedMotion: 'on' }))
    await expect(page.locator('html')).toHaveAttribute('data-reduced-motion', 'on')
    expect(await form.evaluate(element => getComputedStyle(element).animationName)).toBe('none')

    // Keyboard focus reveals the action in the minimum window before the explicit send.
    await send.focus()
    await expect(send).toBeInViewport()
    await expect.poll(() => send.evaluate(element => {
      const box = element.getBoundingClientRect()
      return element.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2))
    })).toBe(true)
    await page.screenshot({ path: 'artifacts/question-choices/choices-820x560-light-send-focused.png', animations: 'disabled' })
    // Sending a recommendation retains the provider's exact ID, including its suffix.
    await send.press('Enter')
    await expect(panel).toHaveCount(0)
    expect(await answers(app)).toEqual([{ type: 'answer', threadId: 'workshop', requestId: request.id, answer: '',
      questionAnswers: { layout: { optionIds: ['sidebar (Recommended)'] } } }])
    await expect(prompt).toHaveValue('Keep keyboard navigation consistent with the rest of the app.')
    expect(await pending(page, 'workshop')).toEqual([])
  } finally { await closeSotto(launched) }
})


test('keeps a question and its message bar reachable in a short stacked pane', async () => {
  test.setTimeout(120_000)
  const launched = await launchSotto('design-threads')
  const { page, app } = launched
  try {
    await prepare(launched)
    await resize(launched, 1280, 620)
    await selectThread(page, 'Grok voice previews')
    const sidebar = page.getByRole('complementary', { name: 'Thread sidebar' })
    for (const title of ['Footer links', 'Weekly note']) {
      await sidebar.getByRole('button', { name: title, exact: true }).hover()
      await sidebar.getByRole('button', { name: `Open ${title} beside`, exact: true }).click()
    }
    const panes = page.getByRole('group', { name: 'Thread panes' })
    await expect(panes.locator('section.thread-pane[role="region"]:not([data-hidden])')).toHaveCount(3)
    const pane = panes.locator('section.thread-pane[data-thread-id="footer-links"]')
    const prompt = pane.getByRole('textbox', { name: 'Prompt', exact: true })
    await prompt.fill('Keep this independent follow-up draft.')
    await emit(page, 'footer-links', { id: 'short-question', kind: 'question', text: 'Choose the next step.', options: [], questions: [{
      id: 'next', question: 'Choose the next step.', multiSelect: false, allowFreeText: true,
      options: [{ id: 'review', label: 'Review the links (Recommended)', description: 'Check every footer destination before editing.' },
        { id: 'edit', label: 'Edit the footer', description: 'Start changing the current layout.' }],
    }] })
    const form = pane.locator('.thread-questions .agent-request')
    await expect(form.getByRole('radio', { name: /Review the links/u })).toBeEnabled()
    await page.screenshot({ path: 'artifacts/question-choices/choices-short-stacked-pane-before-choice-dark.png', animations: 'disabled' })
    await form.getByRole('radio', { name: /Edit the footer/u }).click()
    await form.getByRole('radio', { name: 'Write my own answer', exact: true }).click()
    const custom = form.getByRole('textbox', { name: 'Other answer to: Choose the next step.' })
    await custom.click()
    await custom.fill('Check keyboard access first.')
    await form.getByRole('radio', { name: /Review the links/u }).click()
    await expect(pane.getByLabel('Thread transcript', { exact: true })).toBeHidden()
    await form.getByRole('button', { name: 'Collapse question', exact: true }).click()
    await expect(pane.getByLabel('Thread transcript', { exact: true })).toBeVisible()
    await form.getByRole('button', { name: 'Show question', exact: true }).click()
    await expect(pane.getByLabel('Thread transcript', { exact: true })).toBeHidden()
    await expect(form.getByRole('radio', { name: /Review the links/u })).toBeChecked()
    const send = form.getByRole('button', { name: 'Send answer', exact: true })
    await send.focus()
    await resize(launched, 1280, 620)
    await page.screenshot({ path: 'artifacts/question-choices/choices-short-stacked-pane-dark.png', animations: 'disabled' })
    const layout = await pane.evaluate(element => {
      const paneBox = element.getBoundingClientRect()
      const compose = element.querySelector('.thread-workspace__compose')!.getBoundingClientRect()
      const questions = element.querySelector('.thread-questions')!.getBoundingClientRect()
      return { paneHeight: paneBox.height, paneBottom: paneBox.bottom, composeBottom: compose.bottom, questionHeight: questions.height,
        overflow: element.scrollHeight - element.clientHeight }
    })
    expect(layout.paneHeight).toBeLessThanOrEqual(320)
    expect(layout.composeBottom).toBeLessThanOrEqual(layout.paneBottom + 1)
    expect(layout.overflow).toBeLessThanOrEqual(1)
    expect(layout.questionHeight).toBeGreaterThanOrEqual(48)
    await expect(send).toBeInViewport()
    await expect(prompt).toBeInViewport()
    await expect.poll(() => send.evaluate(element => {
      const box = element.getBoundingClientRect()
      return element.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2))
    })).toBe(true)
    expect(await answers(app)).toEqual([])
    await send.press('Enter')
    await expect(form).toHaveCount(0)
    await expect(prompt).toHaveValue('Keep this independent follow-up draft.')
    expect(await answers(app)).toHaveLength(1)
  } finally { await closeSotto(launched) }
})


test('keeps simultaneous question and permission controls reachable in a short stacked pane', async () => {
  test.setTimeout(120_000)
  const launched = await launchSotto('design-threads')
  const { page, app } = launched
  try {
    await prepare(launched)
    await resize(launched, 1280, 620)
    await selectThread(page, 'Grok voice previews')
    const sidebar = page.getByRole('complementary', { name: 'Thread sidebar' })
    for (const title of ['Footer links', 'Weekly note']) {
      await sidebar.getByRole('button', { name: title, exact: true }).hover()
      await sidebar.getByRole('button', { name: `Open ${title} beside`, exact: true }).click()
    }
    const pane = page.locator('section.thread-pane[data-thread-id="footer-links"]')
    const prompt = pane.getByRole('textbox', { name: 'Prompt', exact: true })
    await prompt.fill('Keep this follow-up separate from both decisions.')
    await emit(page, 'footer-links', { id: 'mixed-question', kind: 'question', text: 'Which links should be checked?', options: [], questions: [{
      id: 'links', question: 'Which links should be checked?', multiSelect: false, allowFreeText: true,
      options: [{ id: 'all', label: 'Every footer link (Recommended)' }, { id: 'changed', label: 'Changed links only' }],
    }] })
    await emit(page, 'footer-links', testPermission)
    await resize(launched, 1280, 620)
    const transcript = pane.getByLabel('Thread transcript', { exact: true })
    const approval = transcript.locator('.agent-request[data-kind="permission"]')
    const question = pane.locator('.thread-questions .agent-request')
    await expect(transcript).toBeVisible()
    await expect(approval).toBeVisible()
    await expect(question).toBeVisible()
    const layout = await pane.evaluate(element => ({
      paneHeight: element.clientHeight,
      transcriptHeight: element.querySelector('.thread-transcript')!.clientHeight,
      questionHeight: element.querySelector('.thread-questions')!.clientHeight,
      overflow: element.scrollHeight - element.clientHeight,
    }))
    expect(layout.paneHeight).toBeLessThanOrEqual(320)
    expect(layout.transcriptHeight).toBe(160)
    expect(layout.questionHeight).toBeLessThanOrEqual(160)
    expect(layout.overflow).toBeGreaterThan(0)

    await question.getByRole('radio', { name: /Every footer link/u }).click()
    await expect(question.getByRole('radio', { name: /Every footer link/u })).toBeChecked()
    expect(await answers(app)).toEqual([])
    await page.screenshot({ path: 'artifacts/question-choices/choices-short-mixed-question-dark.png', animations: 'disabled' })
    // Keyboard focus must reveal the native decision even while the question stays expanded.
    const deny = approval.getByRole('button', { name: 'Deny', exact: true })
    await deny.focus()
    await expect.poll(() => deny.evaluate(element => {
      const box = element.getBoundingClientRect()
      return element.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2))
    })).toBe(true)
    await page.screenshot({ path: 'artifacts/question-choices/choices-short-mixed-permission-dark.png', animations: 'disabled' })
    await deny.press('Enter')
    await expect(approval).toHaveCount(0)
    await expect(transcript).toBeHidden()
    await expect(question.getByRole('radio', { name: /Every footer link/u })).toBeChecked()
    const send = question.getByRole('button', { name: 'Send answer', exact: true })
    await send.click()
    await expect(question).toHaveCount(0)
    await expect(transcript).toBeVisible()
    await expect(prompt).toHaveValue('Keep this follow-up separate from both decisions.')
    expect(await answers(app)).toEqual([
      { type: 'answer', threadId: 'footer-links', requestId: testPermission.id, answer: 'Deny', approved: false, permissionChoice: 'reject' },
      { type: 'answer', threadId: 'footer-links', requestId: 'mixed-question', answer: '', questionAnswers: { links: { optionIds: ['all'] } } },
    ])
  } finally { await closeSotto(launched) }
})
