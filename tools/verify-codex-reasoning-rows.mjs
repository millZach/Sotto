// Usage: npm run build && SOTTO_NATIVE_THREADS_LIVE=1 node tools/verify-codex-reasoning-rows.mjs <out-dir>
// Sends one real Codex turn that takes a few steps in the built app, on an owned throwaway profile, and records how many
// Reasoning summary rows the thread draws, beside how many reasoning items Codex wrote for the turn in its own session file.
import console from 'node:console'
import process from 'node:process'
import { _electron as electron } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const out = resolve(process.argv[2] ?? 'artifacts/codex-reasoning-rows')
if (process.env.SOTTO_NATIVE_THREADS_LIVE !== '1') throw new Error('Set SOTTO_NATIVE_THREADS_LIVE=1: this sends a real Codex turn.')
await mkdir(out, { recursive: true })
const root = await mkdtemp(join(tmpdir(), 'sotto-e2e-native-'))
const profile = join(root, 'profile'), project = join(root, 'project')
await mkdir(profile); await mkdir(project)
await writeFile(join(profile, 'settings.json'), JSON.stringify({ onboardingComplete: true }))
await writeFile(join(project, 'notes.txt'), 'one\ntwo\nthree\n')
execFileSync('git', ['init', '-q'], { cwd: project })
const started = Date.now()

const app = await electron.launch({ args: [resolve('tests/fixtures/nativeThreadsMain.cjs')],
  env: Object.fromEntries(Object.entries({ ...process.env, SOTTO_NATIVE_THREADS_ROOT: root }).filter(([key, value]) => value !== undefined && key !== 'ELECTRON_RUN_AS_NODE')) })
try {
  // The main window, not the widget, which may open first.
  const first = await app.firstWindow(); await first.waitForLoadState('domcontentloaded')
  const page = first.url().endsWith('/index.html') ? first : app.windows().find(item => item.url().endsWith('/index.html'))
    ?? await app.waitForEvent('window', { predicate: async item => { await item.waitForLoadState('domcontentloaded'); return item.url().endsWith('/index.html') } })
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.waitForFunction(() => !!globalThis.sotto?.agents)
  const model = await page.evaluate(async () => {
    await globalThis.sotto.agents.command({ type: 'configure', patch: { provider: 'codex', enabled: true, enabledProviders: ['codex'], reasoning: 'none' } })
    const connected = await globalThis.sotto.agents.command({ type: 'connect', provider: 'codex' })
    if (connected.error) throw new Error(connected.error)
    const ready = (await globalThis.sotto.agents.get()).host.models.filter(item => item.providerId === 'codex' && item.ready)
    const chosen = ready.find(item => /sol/i.test(item.name)) ?? ready[0]
    await globalThis.sotto.agents.command({ type: 'configure', patch: { defaultModelId: chosen.id } })
    return chosen.name
  })
  await page.reload()
  await page.waitForFunction(() => !!globalThis.sotto?.agents)
  const threads = page.getByRole('link', { name: 'Threads', exact: true })
  if (!await page.locator('.threads-view').isVisible()) await (await threads.count() ? threads : page.getByRole('tab', { name: 'Threads', exact: true })).click()
  await page.getByRole('button', { name: 'New thread', exact: true }).first().click()
  const dialog = page.getByRole('dialog', { name: 'New thread', exact: true })
  await dialog.getByRole('button', { name: /Local folder/ }).click()
  await page.getByRole('dialog', { name: /Choose a folder for the new thread/ }).getByRole('button', { name: 'Browse with File Explorer' }).click()
  await dialog.waitFor({ state: 'detached', timeout: 45_000 })
  // Full access, so the turn's commands run without asking.
  await page.getByText('Provider default', { exact: true }).click()
  await page.getByText(/^Full access$/u).last().click()
  // The highest effort the model offers, where Codex reasons in many short steps: the effort slider's End.
  await page.getByText(/^(Low|Medium|High|Max|Ultra|Minimal|None)$/u).first().click()
  await page.getByRole('slider').last().focus()
  await page.keyboard.press('End')
  await page.keyboard.press('Escape')
  const field = page.getByRole('textbox', { name: /prompt/i }).first()
  await field.click()
  await page.keyboard.type('Run git status in this folder, then count the lines in notes.txt with a command, then reply with the one word DONE. Change nothing.')
  await page.getByRole('button', { name: 'Send prompt', exact: true }).click()
  await page.getByLabel('Thread transcript').locator('[data-role="assistant"]').filter({ hasText: 'DONE' }).waitFor({ timeout: 240_000 })
  await page.waitForFunction(async () => { const state = await globalThis.sotto.agents.get(); return state.host.threads.find(item => item.id === state.activeThreadId)?.status === 'idle' }, undefined, { timeout: 60_000, polling: 1_000 })
  await page.waitForTimeout(1_500)
  // Open every fold so each row the thread holds is drawn.
  for (const name of [/^Worked for/u, /^Show \d+ earlier/u, /^(Ran|Changed|Used|Updated) /u]) {
    for (const fold of await page.getByRole('button', { name }).all()) {
      if (await fold.getAttribute('aria-expanded') === 'true') continue
      await fold.click().catch(() => undefined); await page.waitForTimeout(300)
    }
  }
  await page.waitForTimeout(500)
  const activities = await page.evaluate(async () => {
    const state = await globalThis.sotto.agents.get()
    const thread = state.host.threads.find(item => item.id === state.activeThreadId)
    const details = await globalThis.sotto.agents.threadDetail?.(state.activeThreadId).catch(() => undefined)
    const records = details?.activities ?? thread?.activities ?? []
    return records.map(record => ({ kind: record.kind, title: record.title, status: record.status, textLength: (record.text ?? '').trim().length }))
  })
  const drawn = await page.getByLabel('Thread transcript').getByText('Reasoning summary', { exact: true }).count()
  // A fold names what it holds: "Ran 2 commands, 1 reasoning summary". Only Sotto's own fold labels are kept, never
  // transcript text, since the result is printed.
  const folds = (await page.getByRole('button', { name: /^(Ran|Changed|Used|Updated|Worked) /u }).allTextContents())
    .filter(label => /^[\w ,.]+$/u.test(label) && label.length < 120)
  await page.screenshot({ path: join(out, 'thread.png') })
  // Codex's own record of the turn: every session file it wrote since this run began.
  const sessions = join(homedir(), '.codex', 'sessions')
  const files = []
  const walk = async dir => { for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) await walk(path)
    else if (entry.name.endsWith('.jsonl') && (await stat(path)).mtimeMs >= started) {
      // Only this run's session: Codex names its folder in the first record.
      const head = (await readFile(path, 'utf8')).split('\n', 1)[0]
      try { if (JSON.parse(head).payload?.cwd?.toLowerCase() === project.toLowerCase()) files.push(path) } catch { /* not a session */ }
    }
  } }
  await walk(sessions)
  let reasoning = 0, wordless = 0
  for (const file of files) for (const line of (await readFile(file, 'utf8')).split('\n')) {
    if (!line.includes("\"type\":\"reasoning\"")) continue
    try { const payload = JSON.parse(line).payload; if (payload?.type !== 'reasoning') continue; reasoning++; if (!payload.summary?.some(part => (part.text ?? part).trim?.())) wordless++ } catch { /* not a record */ }
  }
  const result = { model, drawn, folds, activities, codexReasoningItems: reasoning, codexWordless: wordless, sessionFiles: files.length }
  await writeFile(join(out, 'result.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify({ ...result, activities: activities.map(item => `${item.kind}:${item.status}:${item.textLength}`) }))
} catch (error) { for (const [index, item] of app.windows().entries()) await item.screenshot({ path: join(out, `failure-${index}.png`) }).catch(() => undefined); throw error } finally { await app.close() }
