import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import type { AgentCommand, AgentRequest, AgentState } from '../../src/shared/agents'
import { closeSotto, launchSotto, type LaunchedSotto } from './support/sottoLaunch'

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
  await page.getByRole('link', { name: 'Threads', exact: true }).click()
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
const card = (page: Page): Locator => transcript(page).locator('.agent-request')

async function resize(launched: LaunchedSotto, width: number, height: number): Promise<void> {
  await launched.app.evaluate(({ BrowserWindow }, [width, height]) => {
    BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'))!.setContentSize(width, height)
  }, [width, height] as const)
  // The window's own 820 × 560 minimum can round the content height up by a pixel or two.
  await expect.poll(() => launched.page.evaluate(([width, height]) => window.innerWidth === width && Math.abs(window.innerHeight - height) <= 2, [width, height] as const)).toBe(true)
}

/** The card sits inside the transcript: the composer stays whole, the transcript keeps room, nothing scrolls sideways. */
async function expectRoomy(page: Page, minimumLog: number): Promise<void> {
  const layout = await page.evaluate(() => {
    const log = document.querySelector('[aria-label="Thread transcript"]')!
    const compose = document.querySelector('.thread-workspace__compose')!.getBoundingClientRect()
    const request = document.querySelector('.agent-request')!
    return { logHeight: log.clientHeight, composeBottom: compose.bottom, composeTop: compose.top, height: window.innerHeight,
      pageOverflow: document.documentElement.scrollWidth - window.innerWidth, cardOverflow: request.scrollWidth - request.clientWidth,
      logBottom: log.getBoundingClientRect().bottom }
  })
  expect(layout.composeBottom).toBeLessThanOrEqual(layout.height + 1)
  expect(layout.logBottom).toBeLessThanOrEqual(layout.composeTop + 1)
  expect(layout.logHeight).toBeGreaterThanOrEqual(minimumLog)
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
    await page.getByRole('button', { name: 'Reconnect', exact: true }).click()
    await expect(form.getByRole('radio', { name: /Sidebar/u })).toBeEnabled()
    expect(await pending(page, 'workshop')).toEqual(['layout-form'])
    await expect(form.getByRole('checkbox', { name: 'Unit tests' })).toBeChecked()
    await expect(form.getByRole('checkbox', { name: 'Typecheck' })).toBeChecked()
    await form.getByRole('textbox', { name: 'Name the branch for this work.' }).fill('settings-layou')
    await capture(launched, 'workshop-form', form)
    await capture(launched, 'workshop-form-footer', send)
    expect(await answers(app)).toEqual([])

    // Keyboard only from here: finish the text answer and send it with Enter.
    const branch = form.getByRole('textbox', { name: 'Name the branch for this work.' })
    await branch.focus()
    await page.keyboard.press('End')
    await page.keyboard.type('t')
    await expect(form.getByText('Ready to send')).toBeVisible()
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
    await expect(page.getByRole('button', { name: 'Jump to latest' })).toBeVisible()
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
    // ThreadPane also shows the command error above the transcript, which costs the short window about 40px.
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
