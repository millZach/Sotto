import { mkdir, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { evidenceDirectory } from '../fixtures/evidence'
import { ownedE2EProfile, removeOwnedE2EProfile } from './support/e2eProfile'
import { elementContrast } from './support/elementContrast'
import { closeSotto, launchSotto, openThreads, resizeWindow, type LaunchedSotto } from './support/sottoLaunch'

const evidence = evidenceDirectory('artifacts/own-model-servers')

/** A model as OpenCode 2 lists it, from the model source `providerID`. */
const native = (providerID: string, id: string, name: string) => ({ id, modelID: id, providerID, name, capabilities: { tools: true, input: ['text'], output: ['text'] },
  variants: [{ id: 'low' }, { id: 'medium' }, { id: 'high' }], enabled: true, status: 'active', limit: { context: 200000, output: 32000 } })
const models = [native('opencode', 'zen-0', 'Big Pickle'), native('anthropic', 'claude-0', 'Claude Sonnet 5')]
const providers = [['opencode', 'OpenCode'], ['anthropic', 'Anthropic']].map(([id, name]) => ({ id, name, activation: 'enabled', package: '@opencode/ai/providers/openai-compatible' }))

/**
 * A stand-in SGLang server on this computer: its OpenAI model list, one model with its context and one without, and
 * `/model_info` naming a reasoning parser. Nothing here is a real model; it answers only what the check asks.
 */
async function sglang(): Promise<{ readonly server: Server; readonly port: number }> {
  const server = createServer((request, response) => {
    const send = (status: number, body: unknown): void => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)) }
    if (request.url === '/v1/models') return send(200, { object: 'list', data: [
      { id: 'deepseek-v4.1-flash', object: 'model', owned_by: 'sglang', max_model_len: 1_048_576 },
      { id: 'qwen3-coder-30b', object: 'model', owned_by: 'sglang' },
    ] })
    if (request.url === '/model_info') return send(200, { model_path: 'deepseek-v4.1-flash', is_generation: true, reasoning_parser: 'deepseek-r1' })
    send(404, { error: 'not found' })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return { server, port: (server.address() as AddressInfo).port }
}

async function providersPage(page: Page): Promise<Locator> {
  await page.getByRole('link', { name: 'Settings', exact: true }).click()
  await page.getByRole('tab', { name: 'Providers', exact: true }).click()
  const group = page.getByRole('region', { name: 'Your own model servers', exact: true })
  await expect(group).toBeVisible()
  return group
}

/** Nothing in the dialog spills sideways or past the window at this size. */
async function fits(page: Page, dialog: Locator): Promise<void> {
  const box = await dialog.boundingBox()
  const size = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
  expect(box).not.toBeNull()
  expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.y).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width).toBeLessThanOrEqual(size.width + 1); expect(box!.y + box!.height).toBeLessThanOrEqual(size.height + 1)
  expect(await dialog.evaluate(node => [node, ...node.querySelectorAll<HTMLElement>('.own-dialog__body, .own-model, .tt-dialog__actions')]
    .filter(part => part.scrollWidth > part.clientWidth + 1).map(part => part.className))).toEqual([])
}

const contrasts: { surface: string; size: string; appearance: string; ratio: number }[] = []
async function measure(root: Locator, surfaces: Record<string, string>, size: string, appearance: string): Promise<void> {
  for (const [surface, selector] of Object.entries(surfaces)) {
    const ratio = await elementContrast(root.locator(selector).first())
    contrasts.push({ surface, size, appearance, ratio: Math.round(ratio * 100) / 100 })
    expect(ratio, `${surface} at ${size} ${appearance}`).toBeGreaterThanOrEqual(4.5)
  }
}
const DIALOG_TEXT = { label: '.own-field label', note: '.own-field small', who: '.own-found__who', 'context label': '.own-model__context label', 'context note': '.own-model__note', privacy: '.own-privacy' }

async function checkedDialog(page: Page, group: Locator, port: number): Promise<Locator> {
  await group.getByRole('button', { name: 'Add a server', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Add your own model server', exact: true })
  await expect(dialog.getByLabel('Address', { exact: true })).toBeFocused()
  await dialog.getByLabel('Address', { exact: true }).fill(`127.0.0.1:${port}`)
  await dialog.getByLabel('Name', { exact: true }).fill('spark-head')
  await dialog.getByRole('button', { name: 'Check this server', exact: true }).click()
  await expect(dialog.getByText(/^SGLang answered in \d+ ms with 2 models\.$/u)).toBeVisible()
  return dialog
}

test('adds your own model server from Settings and from the model menu, checks it again and removes it', async () => {
  test.setTimeout(300_000)
  const profile = (await ownedE2EProfile({ prefix: 'sotto-e2e-own-servers-' })).directory
  const root = join(profile, 'opencode-fixture')
  const projectPath = join(root, 'project')
  await mkdir(projectPath, { recursive: true })
  await mkdir(evidence, { recursive: true })
  await writeFile(join(root, 'script.json'), JSON.stringify({ models, providers }))
  const previousEnvironment = {
    SOTTO_E2E_OPENCODE_ROOT: process.env.SOTTO_E2E_OPENCODE_ROOT,
    SOTTO_E2E_OPENCODE_EXECUTABLE: process.env.SOTTO_E2E_OPENCODE_EXECUTABLE,
    SOTTO_OWL_FEATURES: process.env.SOTTO_OWL_FEATURES,
  }
  process.env.SOTTO_E2E_OPENCODE_ROOT = root
  process.env.SOTTO_E2E_OPENCODE_EXECUTABLE = process.execPath
  process.env.SOTTO_OWL_FEATURES = 'opencode=1,own-model-servers=1'
  const { server, port } = await sglang()
  const pageErrors: string[] = []
  let launched: LaunchedSotto | undefined
  try {
    launched = await launchSotto('success', profile)
    const { page } = launched
    page.on('pageerror', error => pageErrors.push(error.message))
    await page.evaluate(() => window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark', reducedMotion: 'on' }))
    await page.reload()
    await page.evaluate(async () => { await window.sotto!.agents!.command({ type: 'connect', provider: 'opencode' }) })
    await resizeWindow(launched, 1280, 800)

    // The group sits above the provider tiles and reads nothing from any server until a press.
    const group = await providersPage(page)
    await expect(group).toContainText('None yet. Add a model server you run to use its models in OpenCode threads.')
    expect(await group.evaluate(node => Boolean(node.compareDocumentPosition(document.querySelector('.providers-list')!) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true)
    await page.screenshot({ animations: 'disabled', path: join(evidence, 'group-empty-1280-dark.png') })

    // A server that does not answer: said in the dialog, nothing lost, focus on the address.
    await group.getByRole('button', { name: 'Add a server', exact: true }).click()
    let dialog = page.getByRole('dialog', { name: 'Add your own model server', exact: true })
    await page.screenshot({ animations: 'disabled', path: join(evidence, 'dialog-empty-1280-dark.png') })
    await dialog.getByLabel('Address', { exact: true }).fill('127.0.0.1:9')
    await dialog.getByRole('button', { name: 'Check this server', exact: true }).click()
    await expect(dialog.getByRole('alert')).toContainText('Nothing answered at 127.0.0.1:9. Nothing was saved.', { timeout: 60_000 })
    await expect(dialog.getByLabel('Address', { exact: true })).toBeFocused()
    await expect(dialog.getByLabel('Address', { exact: true })).toHaveValue('127.0.0.1:9')
    await page.screenshot({ animations: 'disabled', path: join(evidence, 'dialog-unreachable-1280-dark.png') })
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await expect(group.getByRole('button', { name: 'Add a server', exact: true })).toBeFocused()

    // The check: what answered, each model with its context and Thinking, and the one context nobody said.
    dialog = await checkedDialog(page, group, port)
    const unknown = dialog.getByRole('listitem').filter({ hasText: 'qwen3-coder-30b' }).getByLabel('Context, in tokens')
    await expect(unknown).toBeFocused()
    await expect(dialog.getByRole('switch', { name: 'Thinking for deepseek-v4.1-flash' })).toHaveAttribute('aria-checked', 'true')
    await expect(dialog.getByRole('button', { name: 'Add server', exact: true })).toBeDisabled()
    await fits(page, dialog)
    await measure(dialog, DIALOG_TEXT, '1280x800', 'dark')
    await page.screenshot({ animations: 'disabled', path: join(evidence, 'dialog-checked-1280-dark.png') })
    for (const [width, height] of [[820, 560]] as const) {
      await resizeWindow(launched, width, height)
      await fits(page, dialog)
      await measure(dialog, DIALOG_TEXT, `${width}x${height}`, 'dark')
      await page.screenshot({ animations: 'disabled', path: join(evidence, `dialog-checked-${width}-dark.png`) })
    }
    await resizeWindow(launched, 1280, 800)
    await unknown.fill('128K')
    await page.screenshot({ animations: 'disabled', path: join(evidence, 'dialog-ready-1280-dark.png') })
    await dialog.getByRole('button', { name: 'Add server', exact: true }).click()
    await expect(dialog).toBeHidden({ timeout: 60_000 })
    await expect(group).toContainText('Added spark-head. Its models are in the model menu under spark-head, with OpenCode.')
    const row = group.getByRole('listitem').filter({ hasText: 'spark-head' })
    await expect(row).toContainText('Runs with OpenCode · 2 models')

    // Check again says what this check found on that row, and nothing more.
    await row.getByRole('button', { name: 'Check spark-head again', exact: true }).click()
    await expect(row.getByRole('status')).toHaveText(/^SGLang answered in \d+ ms\.$/u)
    await measure(group, { meta: '.own-server__meta', address: '.own-server__address', check: '.own-server__check', notice: '.own-servers__notice', note: '.settings-group__note' }, '1280x800', 'dark')
    await page.screenshot({ animations: 'disabled', path: join(evidence, 'group-added-1280-dark.png') })

    // Light, at the two sizes.
    await page.evaluate(() => window.sotto!.updateSettings({ appearance: 'light' }))
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await measure(group, { meta: '.own-server__meta', address: '.own-server__address', check: '.own-server__check', note: '.settings-group__note' }, '1280x800', 'light')
    await page.screenshot({ animations: 'disabled', path: join(evidence, 'group-added-1280-light.png') })
    dialog = await checkedDialog(page, group, port)
    await measure(dialog, DIALOG_TEXT, '1280x800', 'light')
    await page.screenshot({ animations: 'disabled', path: join(evidence, 'dialog-checked-1280-light.png') })
    await resizeWindow(launched, 820, 560)
    await fits(page, dialog)
    await measure(dialog, DIALOG_TEXT, '820x560', 'light')
    await page.screenshot({ animations: 'disabled', path: join(evidence, 'dialog-checked-820-light.png') })
    await page.keyboard.press('Escape')
    await page.screenshot({ animations: 'disabled', path: join(evidence, 'group-added-820-light.png') })
    await page.evaluate(() => window.sotto!.updateSettings({ appearance: 'dark' }))
    await page.screenshot({ animations: 'disabled', path: join(evidence, 'group-added-820-dark.png') })
    await resizeWindow(launched, 1280, 800)

    // The model menu: OpenCode's source list ends with Your own server…, which opens the same dialog.
    const created = await page.evaluate(async path => (await window.sotto!.agents!.command({ type: 'create-project', provider: 'opencode', title: 'OpenCode project', path, useExisting: true })).error, projectPath)
    expect(created).toBeNull()
    await openThreads(page)
    await page.getByRole('button', { name: 'New thread in OpenCode project', exact: true }).click()
    const chip = page.getByRole('combobox', { name: 'Thread model', exact: true })
    await chip.click()
    const menu = page.getByRole('dialog', { name: 'Choose model', exact: true })
    await menu.getByRole('tab', { name: 'OpenCode', exact: true }).click()
    const own = menu.getByRole('group', { name: 'OpenCode model sources', exact: true }).getByRole('button').last()
    await expect(own).toHaveAccessibleName('Your own server: add a model server you run')
    await page.screenshot({ animations: 'disabled', path: join(evidence, 'menu-own-server-1280-dark.png') })
    await resizeWindow(launched, 820, 560)
    await page.screenshot({ animations: 'disabled', path: join(evidence, 'menu-own-server-820-dark.png') })
    await own.click()
    await expect(menu).toBeHidden()
    const fromMenu = page.getByRole('dialog', { name: 'Add your own model server', exact: true })
    await expect(fromMenu.getByLabel('Address', { exact: true })).toBeFocused()
    await fits(page, fromMenu)
    await page.screenshot({ animations: 'disabled', path: join(evidence, 'dialog-from-menu-820-dark.png') })
    await page.keyboard.press('Escape')
    await expect(fromMenu).toBeHidden()
    await expect(chip).toBeFocused()
    await resizeWindow(launched, 1280, 800)

    // Remove asks nothing more, says what it did and leaves focus on Add a server.
    const again = await providersPage(page)
    await again.getByRole('button', { name: 'Remove spark-head', exact: true }).click()
    await expect(again).toContainText('Removed spark-head.')
    await expect(again.getByRole('button', { name: 'Add a server', exact: true })).toBeFocused()

    expect(pageErrors).toEqual([])
    await writeFile(join(evidence, 'contrast.json'), `${JSON.stringify(contrasts, null, 2)}\n`)
  } finally {
    if (launched) await closeSotto(launched)
    server.close()
    for (const [name, value] of Object.entries(previousEnvironment)) { if (value === undefined) delete process.env[name]; else process.env[name] = value }
    await removeOwnedE2EProfile(profile)
  }
})
