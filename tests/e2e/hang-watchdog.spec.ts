/**
 * The hang watch (#1581, ADR-0098's October 26 amendment) in the built app. A hang of main is seen from the watch's own
 * thread and saved with main's stack; a window that stops answering while main keeps going is saved with each process's
 * numbers; and once Quit is received, Sotto ends itself even if main then stops for good. The waits are shortened for the
 * run through the development-only overrides.
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { closeSotto, launchSotto, type LaunchedSotto } from './support/sottoLaunch'

const OVERRIDES = { SOTTO_OWL_FEATURES: 'main-freeze=1', SOTTO_E2E_MAIN_HANG_MS: '2000', SOTTO_E2E_WINDOW_HANG_MS: '3000', SOTTO_E2E_QUIT_FORCE_MS: '4000' }

async function launch(): Promise<LaunchedSotto> {
  const previous = Object.fromEntries(Object.keys(OVERRIDES).map(key => [key, process.env[key]]))
  Object.assign(process.env, OVERRIDES)
  try { return await launchSotto() } finally {
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value
  }
}

interface SavedHang { kind: string; answeredAfterMs: number | null; stacks?: { frames: { functionName: string; url: string }[] }[]; processes?: { type: string }[] }

/** The hang recordings saved so far, read whole. */
async function hangs(launched: LaunchedSotto): Promise<SavedHang[]> {
  const folder = join(launched.userData, 'performance-recordings')
  const names = (await readdir(folder).catch(() => [])).filter(name => /^sotto-hang-[\d-]+$/u.test(name))
  return Promise.all(names.map(async name => JSON.parse(await readFile(join(folder, name, 'hang.json'), 'utf8')) as SavedHang))
}

test('a hang of main is saved with main\'s stack while main is still stopped, then how long it lasted', async () => {
  test.setTimeout(120_000)
  const launched = await launch()
  try {
    const stopped = Date.now()
    await launched.app.evaluate(() => {
      setTimeout(function stopMainOnPurpose() { const end = Date.now() + 15_000; while (Date.now() < end) { /* stopped on purpose */ } }, 50)
    })
    // Saved while main is still stopped, as a hang that is ended by force has to be.
    await expect.poll(async () => (await hangs(launched)).some(hang => hang.kind === 'main' && hang.answeredAfterMs === null), { timeout: 12_000 }).toBe(true)
    expect(Date.now() - stopped).toBeLessThan(15_000)
    await expect.poll(async () => (await hangs(launched)).find(hang => hang.kind === 'main')?.answeredAfterMs ?? null, { timeout: 30_000 })
      .toBeGreaterThanOrEqual(14_000)
    const hang = (await hangs(launched)).find(item => item.kind === 'main')!
    expect(hang.stacks!.length).toBeGreaterThan(0)
    // The stopping function was evaluated from text, so it keeps neither its name nor its place: only Sotto's own do.
    for (const stack of hang.stacks!) for (const frame of stack.frames) {
      expect(frame.functionName).not.toBe('stopMainOnPurpose')
      expect(frame.url === '(outside Sotto)' || /^(sotto:\/\/\/|node:|electron)/u.test(frame.url)).toBe(true)
    }
    // Node's own timer frames keep their places, so the debugger's script addresses were read.
    expect(hang.stacks!.flatMap(stack => stack.frames).some(frame => frame.url === 'node:internal/timers')).toBe(true)
    expect(JSON.stringify(hang)).not.toContain(launched.userData)
  } finally { await closeSotto(launched) }
})

test('a window that stops answering is saved with each process\'s numbers, while main keeps going', async () => {
  test.setTimeout(120_000)
  const launched = await launch()
  try {
    await launched.page.evaluate(() => {
      setTimeout(() => { const end = Date.now() + 7_000; while (Date.now() < end) { /* stopped on purpose */ } }, 50)
    })
    await expect.poll(async () => (await hangs(launched)).find(hang => hang.kind === 'window')?.answeredAfterMs ?? null, { timeout: 30_000 })
      .toBeGreaterThanOrEqual(3_000)
    const hang = (await hangs(launched)).find(item => item.kind === 'window')!
    expect(hang.processes!.map(item => item.type)).toEqual(expect.arrayContaining(['Browser', 'Tab']))
    expect((await hangs(launched)).some(item => item.kind === 'main')).toBe(false)
  } finally { await closeSotto(launched) }
})

test('once Quit is received, Sotto ends even if main then stops for good', async () => {
  test.setTimeout(120_000)
  const launched = await launch()
  const child = launched.app.process()
  const exited = new Promise<number | null>(resolve => child.once('exit', code => resolve(code)))
  const started = Date.now()
  await launched.app.evaluate(({ app }) => {
    setTimeout(() => { app.quit(); for (;;) { /* stopped for good, on purpose */ } }, 50)
  })
  await expect(Promise.race([exited.then(() => 'ended'), new Promise(resolve => setTimeout(() => resolve('still running'), 30_000))])).resolves.toBe('ended')
  expect(Date.now() - started).toBeGreaterThanOrEqual(4_000)
  await closeSotto(launched).catch(() => undefined)
})
