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

test('a thread list a pixel or two taller than its room keeps its end room and scrollbar still', async () => {
  test.setTimeout(180_000)
  await withSotto({ onboardingComplete: true, appearance: 'dark', scenario: 'phase3-workspace', agents: 'design-threads', history: populatedHistory }, async launched => {
    const page = launched.page
    await holdContentSize(launched, 1280, 800, [820, 560])
    await openThreads(page)
    const list = page.locator('.thread-nav[data-mode] .thread-nav__scroll')
    await expect(list.locator('.thread-folder__rows > .thread-nav__row').first()).toBeVisible({ timeout: 30_000 })
    // The list at its whole height, then a room a fraction of a pixel to two pixels short of it. The end room's margin once
    // merged with the Settled shelf's, so there each measure of the list took the room or gave it back, and where the list
    // overflowed by less than a pixel the scrollbar came and went with it every frame, jolting every row's status and
    // time sideways. Each short height is measured again, as any change to a row would, and must hold.
    const changes = await list.evaluate(async (element: HTMLElement) => {
      const frame = (): Promise<void> => new Promise(done => requestAnimationFrame(() => done()))
      const frames = async (count: number): Promise<void> => { for (let index = 0; index < count; index += 1) await frame() }
      const room = (): string => element.style.getPropertyValue('--list-end-room') || '0px'
      const scrollbarWidth = (): number => element.offsetWidth - element.clientWidth
      element.style.flex = '0 0 auto'
      element.style.height = 'auto'
      await frames(10)
      const whole = element.getBoundingClientRect().height
      const found: string[] = []
      for (let short = 0.125; short <= 2; short += 0.125) {
        element.style.height = `${whole - short}px`
        await frames(10)
        const settled = { room: room(), scrollbar: scrollbarWidth() }
        // A theme change asks the list to measure its end room again without resizing anything.
        document.documentElement.setAttribute('data-end-room-probe', String(short))
        let flips = 0, last = scrollbarWidth()
        for (let index = 0; index < 30; index += 1) {
          await frame()
          if (scrollbarWidth() !== last) flips += 1
          last = scrollbarWidth()
        }
        if (room() !== settled.room || scrollbarWidth() !== settled.scrollbar || flips > 0) found.push(`${short}px short: room ${settled.room} then ${room()}, scrollbar changed ${flips} times`)
      }
      document.documentElement.removeAttribute('data-end-room-probe')
      // The room adds just what it says to how far the list scrolls, above the band's own 7px.
      element.style.height = `${whole - 1}px`
      await frames(10)
      const endRoomPx = Number.parseFloat(room()), scrollHeightWithRoom = element.scrollHeight
      element.style.setProperty('--list-end-room', '0px')
      if (endRoomPx <= 0 || scrollHeightWithRoom - element.scrollHeight !== endRoomPx) found.push(`a ${endRoomPx}px room added ${scrollHeightWithRoom - element.scrollHeight}px`)
      return found
    })
    expect(changes).toEqual([])
  })
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
