import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { evidenceDirectory } from '../fixtures/evidence'
import { withShownPictureThread } from './support/shownPictureThread'
import { openPage, openThreads, resizeWindow } from './support/sottoLaunch'

/**
 * A plugin change asks first (ADR-0205, decision 7): a thread's agent calls `github_comment`, the thread shows a card
 * with where the comment goes and all of it, and nothing reaches gh until the user presses **Post the comment**. Saying
 * no changes nothing. Both answers show in the plugin's Recent use. gh is a stand-in that reaches nothing and keeps what
 * it was handed. A second journey closes an issue, whose card names it by the title GitHub gave, and promotes a
 * deployment to production against a stand-in for Vercel's API on this computer, with a made-up token. Captures go to
 * artifacts/plugins-change for the verification notes.
 */
const evidence = evidenceDirectory('artifacts/plugins-change')
const OWNED = ['SOTTO_E2E_GH_SCRIPT', 'SOTTO_E2E_GH_EXECUTABLE', 'FAKE_GH_SIGN_IN', 'FAKE_GH_POSTS'] as const
/** A made-up token: nothing here is a real credential. */
const VERCEL_TOKEN = 'made-up-token-vercel-accepts'
const COMMENT = { owner: 'example-owner', repo: 'example-repo', number: 12, body: 'The preview build is fixed.\nIt was a missing environment name.' }

interface Held { __pluginChange?: Promise<{ content: { type: string; text?: string }[]; isError?: boolean | undefined }> }

async function shot(page: Page, name: string): Promise<void> {
  await page.mouse.move(1, 1)
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))
  await page.screenshot({ path: join(evidence, `${name}.png`), animations: 'disabled', caret: 'hide' })
}

/** Calls the tool as the thread's agent would and leaves the call waiting, as it does until the user answers. */
async function ask(page: Page, threadId: string, name: string, args: unknown): Promise<void> {
  await page.evaluate(request => { (window as unknown as Held).__pluginChange = window.sottoE2E!.pluginTool!(request) }, { threadId, name, arguments: args })
}
const askToComment = (page: Page, threadId: string): Promise<void> => ask(page, threadId, 'github_comment', COMMENT)
/** What the waiting call came back with, once it was answered. */
async function answered(page: Page): Promise<{ text: string; isError: boolean }> {
  const result = await page.evaluate(() => (window as unknown as Held).__pluginChange!)
  return { text: result.content.map(part => part.text ?? '').join('\n'), isError: result.isError === true }
}

test('A comment an agent asks to post on GitHub waits for the user’s answer in its thread', async () => {
  test.skip(process.platform !== 'win32', 'Windows desktop acceptance')
  test.setTimeout(300_000)
  await mkdir(evidence, { recursive: true })
  const scratch = await mkdtemp(join(tmpdir(), 'sotto-e2e-plugins-change-'))
  const posts = join(scratch, 'posts.jsonl')
  await writeFile(join(scratch, 'sign-in.json'), JSON.stringify({ login: 'example-user' }), 'utf8')
  const previous = Object.fromEntries(OWNED.map(key => [key, process.env[key]]))
  process.env.SOTTO_E2E_GH_SCRIPT = resolve('tests/fixtures/fakeGhSignIn.mjs')
  process.env.SOTTO_E2E_GH_EXECUTABLE = process.execPath
  process.env.FAKE_GH_SIGN_IN = join(scratch, 'sign-in.json')
  process.env.FAKE_GH_POSTS = posts
  const posted = async (): Promise<{ args: string[]; stdin: string }[]> =>
    (await readFile(posts, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line) as { args: string[]; stdin: string })
  try {
    await withShownPictureThread('sotto-e2e-plugins-change-', async ({ launched, page, pane, threadId }) => {
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      await page.evaluate(async () => { await window.sotto!.updateSettings({ reducedMotion: 'on' }) })

      // The agent asks. The card is in the thread, with where the comment goes and every word of it.
      await askToComment(page, threadId)
      const card = pane.locator('section.agent-request[data-kind="permission"]')
      await expect(card).toHaveCount(1, { timeout: 30_000 })
      await expect(card.getByText('Comment on GitHub as example-user', { exact: true })).toBeVisible()
      await expect(card.getByText('example-owner/example-repo #12', { exact: true })).toBeVisible()
      await expect(card.locator('.agent-request__details')).toHaveText(COMMENT.body)
      const post = card.getByRole('button', { name: 'Post the comment', exact: true })
      const leave = card.getByRole('button', { name: 'Don’t post it', exact: true })
      await expect(post).toBeVisible()
      await expect(leave).toBeVisible()
      // Nothing has been handed to gh while the card waits.
      expect(await posted()).toEqual([])

      for (const [mode, width, height] of [['dark', 1280, 800], ['light', 1280, 800], ['dark', 1600, 1000], ['dark', 820, 560]] as const) {
        await page.evaluate(async appearance => { await window.sotto!.updateSettings({ appearance }) }, mode)
        await resizeWindow(launched, width, height)
        await expect(post).toBeVisible()
        // The card stays inside its pane at every checked size.
        const [cardBox, paneBox] = [await card.boundingBox(), await pane.boundingBox()]
        expect(cardBox!.x + cardBox!.width, `card inside the pane at ${width}x${height}`).toBeLessThanOrEqual(paneBox!.x + paneBox!.width + 1)
        await shot(page, `comment-card-${mode}-${width}x${height}`)
      }
      await resizeWindow(launched, 1280, 800)

      // The user says no: the agent is told, and nothing was posted.
      await leave.click()
      expect(await answered(page)).toEqual({ text: 'The user said no. Nothing was changed. Do not ask again unless they tell you to.', isError: true })
      await expect(card).toHaveCount(0)
      expect(await posted()).toEqual([])

      // Asked again, and allowed from the keyboard: gh is handed the comment on standard input, once.
      await askToComment(page, threadId)
      await expect(card).toHaveCount(1, { timeout: 30_000 })
      await post.focus()
      await page.keyboard.press('Enter')
      expect(await answered(page)).toEqual({ text: 'The user allowed it, and the comment is posted: https://github.com/example-owner/example-repo/issues/12#issuecomment-1', isError: false })
      await expect(card).toHaveCount(0)
      const calls = await posted()
      expect(calls).toHaveLength(1)
      expect(calls[0]!.args).toContain('repos/example-owner/example-repo/issues/12/comments')
      expect(calls[0]!.args.join(' ')).not.toContain('preview build')
      expect(JSON.parse(calls[0]!.stdin)).toEqual({ body: COMMENT.body })

      // Settings › Plugins says what was done and what was only asked for, newest first, and never the comment's words.
      await openPage(page, 'Settings')
      await page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: 'Plugins', exact: true }).click()
      const panel = page.getByRole('tabpanel', { name: 'Plugins', exact: true })
      await panel.getByRole('button', { name: /^GitHub/u }).click()
      await expect(panel.getByText('Reading never asks you, except that each thread asks once before it reads a mail account. A change, such as posting a comment, asks you first in its thread, each time.', { exact: false })).toBeVisible()
      const used = panel.getByRole('region', { name: 'Recent use' }).getByRole('listitem')
      await expect(used).toHaveCount(2)
      await expect(used.nth(0)).toContainText('Posted a comment in “Check the checkout page” You allowed it.')
      await expect(used.nth(1)).toContainText('Asked to post a comment in “Check the checkout page” You said no.')
      await expect(panel).not.toContainText('preview build is fixed')
      await shot(page, 'recent-use-changes-dark-1280x800')
      await openThreads(page)
      expect(errors).toEqual([])
    }, { owlFeatures: 'plugins=1' })
  } finally {
    for (const key of OWNED) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
    await rm(scratch, { recursive: true, force: true })
  }
})

/** Vercel, as far as these changes go: who the token belongs to, one deployment, and a promotion it takes. Everything asked of it is kept. */
async function standInVercel(): Promise<{ server: Server; url: string; asked: string[] }> {
  const asked: string[] = []
  const server = createServer((request, response) => {
    asked.push(`${request.method} ${request.url}`)
    const answer = (status: number, body: unknown): void => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body)) }
    if (request.headers.authorization !== `Bearer ${VERCEL_TOKEN}`) { answer(403, { error: { code: 'forbidden', invalidToken: true } }); return }
    if (request.method === 'GET' && request.url === '/v2/user') { answer(200, { user: { username: 'example-user' } }); return }
    if (request.method === 'GET' && request.url === '/v13/deployments/dpl_example1') {
      // A deployment built for production that is not serving it yet, which is what Vercel's promote is for.
      answer(200, { name: 'lumen-shop', projectId: 'prj_example1', target: 'production', url: 'lumen-shop-8k2j1example.vercel.app', readyState: 'READY' }); return
    }
    if (request.method === 'POST' && request.url === '/v10/projects/prj_example1/promote/dpl_example1') { answer(201, {}); return }
    answer(404, { error: { code: 'not_found' } })
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, asked }
}

test('Closing an issue and promoting a deployment each wait for the user’s answer, on a card that names what it acts on', async () => {
  test.skip(process.platform !== 'win32', 'Windows desktop acceptance')
  test.setTimeout(300_000)
  await mkdir(evidence, { recursive: true })
  const scratch = await mkdtemp(join(tmpdir(), 'sotto-e2e-plugins-change-'))
  const posts = join(scratch, 'posts.jsonl')
  await writeFile(join(scratch, 'sign-in.json'), JSON.stringify({ login: 'example-user' }), 'utf8')
  const vercel = await standInVercel()
  const owned = [...OWNED, 'FAKE_GH_ISSUE', 'SOTTO_E2E_VERCEL_API_URL'] as const
  const previous = Object.fromEntries(owned.map(key => [key, process.env[key]]))
  process.env.SOTTO_E2E_GH_SCRIPT = resolve('tests/fixtures/fakeGhSignIn.mjs')
  process.env.SOTTO_E2E_GH_EXECUTABLE = process.execPath
  process.env.FAKE_GH_SIGN_IN = join(scratch, 'sign-in.json')
  process.env.FAKE_GH_POSTS = posts
  process.env.FAKE_GH_ISSUE = JSON.stringify({ title: 'The preview build fails at the install step', state: 'open', pullRequest: false, number: 12,
    repository: 'https://api.github.com/repos/example-owner/example-repo' })
  process.env.SOTTO_E2E_VERCEL_API_URL = vercel.url
  const sent = async (): Promise<{ args: string[]; stdin: string }[]> =>
    (await readFile(posts, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line) as { args: string[]; stdin: string })
  try {
    await withShownPictureThread('sotto-e2e-plugins-change-', async ({ launched, page, pane, threadId }) => {
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      await page.evaluate(async () => { await window.sotto!.updateSettings({ reducedMotion: 'on' }) })
      const card = pane.locator('section.agent-request[data-kind="permission"]')

      // Close an issue: the card names the issue by the title GitHub gave, and gh has only been read from.
      await ask(page, threadId, 'github_close_issue', { owner: 'example-owner', repo: 'example-repo', number: 12 })
      await expect(card).toHaveCount(1, { timeout: 30_000 })
      await expect(card.getByText('Close an issue on GitHub as example-user', { exact: true })).toBeVisible()
      await expect(card.getByText('example-owner/example-repo #12', { exact: true })).toBeVisible()
      await expect(card.locator('.agent-request__details')).toHaveText('Issue: The preview build fails at the install step\nClosed as: completed')
      await expect(card.getByRole('button', { name: 'Leave it open', exact: true })).toBeVisible()
      expect(await sent()).toEqual([])
      await shot(page, 'close-issue-card-dark-1280x800')
      await card.getByRole('button', { name: 'Close the issue', exact: true }).click()
      expect(await answered(page)).toEqual({ text: 'The user allowed it, and the issue is closed: https://github.com/example-owner/example-repo/issues/12', isError: false })
      const changes = await sent()
      expect(changes).toHaveLength(1)
      expect(changes[0]!.args.slice(0, 3)).toEqual(['api', '--method', 'PATCH'])
      expect(JSON.parse(changes[0]!.stdin)).toEqual({ state: 'closed', state_reason: 'completed' })

      // A Vercel account, added as the page would add it, with a made-up token the stand-in accepts.
      const added = await page.evaluate(async secret => window.sotto!.plugins!.addAccount({ plugin: 'vercel', name: 'Work', secret }), VERCEL_TOKEN)
      expect(added.ok).toBe(true)

      // Promote a deployment: the card names the project, says what kind of deployment it is and what production will do.
      await ask(page, threadId, 'vercel_promote_deployment', { deploymentId: 'dpl_example1' })
      await expect(card).toHaveCount(1, { timeout: 30_000 })
      await expect(card.getByText('Promote a deployment to production on Vercel', { exact: true })).toBeVisible()
      await expect(card.locator('.agent-request__details')).toHaveText(['Project: lumen-shop (prj_example1)', 'Kind: production', 'Address: lumen-shop-8k2j1example.vercel.app', 'Its build now: READY',
        'Deployment: dpl_example1', 'Vercel account: Work', 'The project’s production addresses will serve this deployment. It is not built again.'].join('\n'))
      const promote = card.getByRole('button', { name: 'Promote to production', exact: true })
      const leave = card.getByRole('button', { name: 'Leave production as it is', exact: true })
      await expect(promote).toBeVisible()
      // Vercel has been read from and nothing more.
      expect(vercel.asked.filter(line => line.startsWith('POST'))).toEqual([])
      for (const [mode, width, height] of [['dark', 1280, 800], ['light', 1280, 800], ['dark', 820, 560]] as const) {
        await page.evaluate(async appearance => { await window.sotto!.updateSettings({ appearance }) }, mode)
        await resizeWindow(launched, width, height)
        await expect(leave).toBeVisible()
        const [cardBox, paneBox] = [await card.boundingBox(), await pane.boundingBox()]
        expect(cardBox!.x + cardBox!.width, `card inside the pane at ${width}x${height}`).toBeLessThanOrEqual(paneBox!.x + paneBox!.width + 1)
        await shot(page, `promote-card-${mode}-${width}x${height}`)
      }
      await resizeWindow(launched, 1280, 800)
      await page.evaluate(async () => { await window.sotto!.updateSettings({ appearance: 'dark' }) })

      // No leaves production alone; asked again and allowed, Vercel is sent the one promotion.
      await leave.click()
      expect(await answered(page)).toEqual({ text: 'The user said no. Nothing was changed. Do not ask again unless they tell you to.', isError: true })
      expect(vercel.asked.filter(line => line.startsWith('POST'))).toEqual([])
      await ask(page, threadId, 'vercel_promote_deployment', { deploymentId: 'dpl_example1' })
      await expect(card).toHaveCount(1, { timeout: 30_000 })
      await promote.focus()
      await page.keyboard.press('Enter')
      expect((await answered(page)).text).toContain('The user allowed it, and Vercel has taken the promotion')
      expect(vercel.asked.filter(line => line.startsWith('POST'))).toEqual(['POST /v10/projects/prj_example1/promote/dpl_example1'])
      // The made-up token is in nothing the page shows.
      await expect(page.locator('body')).not.toContainText(VERCEL_TOKEN)
      expect(errors).toEqual([])
    }, { owlFeatures: 'plugins=1' })
  } finally {
    for (const key of owned) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
    await new Promise<void>(done => vercel.server.close(() => done()))
    await rm(scratch, { recursive: true, force: true })
  }
})
