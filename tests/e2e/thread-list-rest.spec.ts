import { expect, test, type Locator, type Page } from '@playwright/test'
import { populatedHistory, withSotto } from '../fixtures/designCaptureProfile'
import { openThreads } from './support/sottoLaunch'
import { holdContentSize } from './support/sottoWindow'

// The thread list comes to rest on a row's edge under the stuck folder head, and a scroll shorter than a row still
// moves it: it goes on to the next row the way it went rather than springing back (listEndRoom.ts). Run after
// `npm run build`.

/** The list's scroll once it has stopped moving. */
async function still(page: Page, list: Locator): Promise<number> {
  let last = Number.NaN, same = 0
  for (let tries = 0; tries < 60 && same < 4; tries += 1) {
    await page.waitForTimeout(100)
    const at = await list.evaluate(element => element.scrollTop)
    same = at === last ? same + 1 : 0
    last = at
  }
  return last
}

/** How far the first row the stuck head does not wholly cover lies below the head's edge: under 0 is cut. */
const offset = (list: Locator): Promise<number> => list.evaluate(element => {
  const top = element.getBoundingClientRect().top
  const stuck = [...element.querySelectorAll<HTMLElement>('.thread-folder__head')].find(head => {
    const box = head.getBoundingClientRect()
    return box.top - top <= 6.5 && box.bottom - top > 0
  })
  const line = stuck === undefined ? top + 6 : stuck.getBoundingClientRect().bottom
  const row = [...element.querySelectorAll<HTMLElement>('.thread-folder__rows > .thread-nav__row, .thread-nav__settled, .thread-folder__head')]
    .filter(item => item !== stuck && item.getBoundingClientRect().height > 0)
    .find(item => item.getBoundingClientRect().bottom > line + 0.5)
  return row === undefined ? 0 : row.getBoundingClientRect().top - line
})

test('a small scroll of the thread list moves it a row and comes to rest on a whole row', async () => {
  test.setTimeout(180_000)
  await withSotto({ onboardingComplete: true, appearance: 'dark', scenario: 'phase3-workspace', agents: 'design-threads', history: populatedHistory }, async launched => {
    const page = launched.page
    // Short enough that the list scrolls, wide enough that the sidebar is the list, not the rail.
    await holdContentSize(launched, 1280, 600, [820, 560])
    await openThreads(page)
    // Enough threads in one folder that the list scrolls well past a screen.
    await page.evaluate(async () => {
      const agents = window.sotto!.agents!
      const state = await agents.get()
      const project = state.host.projects[0]!
      const model = state.host.models.find(value => value.ready)!
      for (let index = 1; index <= 24; index += 1) {
        const made = await agents.command({ type: 'create-thread', projectId: project.id, title: `Resting row ${index}`, titleSource: 'user', modelId: model.id, workingCopy: 'shared' })
        if (made.error) throw new Error(made.error)
      }
    })
    const list = page.locator('.thread-nav[data-mode] .thread-nav__scroll')
    await expect(list).toBeVisible()
    await expect(list.locator('.thread-folder__rows > .thread-nav__row').first()).toBeVisible({ timeout: 30_000 })
    await expect.poll(() => list.evaluate(element => element.scrollHeight - element.clientHeight)).toBeGreaterThan(80)
    await list.evaluate(element => { element.scrollTop = 0 })
    expect(await still(page, list)).toBe(0)
    const box = (await list.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)

    // A nudge of a few pixels down, as a touchpad gives, moves the list on and rests on a whole row.
    for (const step of [3, 3]) await page.mouse.wheel(0, step)
    const down = await still(page, list)
    expect(down).toBeGreaterThan(6)
    expect(await offset(list)).toBeGreaterThanOrEqual(-0.5)

    // A nudge up from there moves it back up a row, again whole.
    for (const step of [-3, -3]) await page.mouse.wheel(0, step)
    const up = await still(page, list)
    expect(up).toBeLessThan(down)
    expect(await offset(list)).toBeGreaterThanOrEqual(-0.5)

    // A longer scroll that ends between rows rests on a whole row too.
    await page.mouse.wheel(0, 67)
    expect(await still(page, list)).toBeGreaterThan(up)
    expect(await offset(list)).toBeGreaterThanOrEqual(-0.5)
  })
})
