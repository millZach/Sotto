import { expect, test, type Locator, type Page } from '@playwright/test'
import { closeSotto, launchSotto, openThreads, resizeWindow } from './support/sottoLaunch'

/** Where each folder's count ends, in the order the folders are listed. */
const countEdges = (sidebar: Locator): Promise<number[]> =>
  sidebar.locator('.thread-folder__count').evaluateAll(counts => counts.map(count => Math.round(count.getBoundingClientRect().right)))

/** Connects the design fixture's three projects and returns the Threads sidebar. */
async function connect(page: Page): Promise<Locator> {
  await page.evaluate(async () => {
    await window.sotto!.updateSettings({ onboardingComplete: true })
    await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true } })
    await window.sotto!.agents!.command({ type: 'connect' })
  })
  await page.reload()
  await openThreads(page)
  return page.getByRole('complementary', { name: 'Thread sidebar' })
}

// The counts read as a column only when every one ends on the same edge, whatever sits beside it: two actions (an open
// project), one (a settled project), none (a project's older settled threads), or a dot for work that is going or
// waiting (a folder that is closed).
test('every folder count ends on one edge, whatever sits beside it', async () => {
  test.setTimeout(90_000)
  const launched = await launchSotto('design-threads')
  const { page } = launched
  try {
    const sidebar = await connect(page)
    const projects = sidebar.getByRole('region', { name: 'Projects' })
    const expectOneColumn = async (folders: number): Promise<void> => {
      const edges = await countEdges(sidebar)
      expect(edges).toHaveLength(folders)
      expect(edges).toEqual(edges.map(() => edges[0]))
      // The column stands clear of the room the actions take.
      expect(edges[0]).toBeLessThanOrEqual(await projects.locator('.thread-folder__actions').first().evaluate(actions => Math.round(actions.getBoundingClientRect().left)))
    }

    // Open: workshop, sotto-site and notes, each with a new-thread and a settle action.
    await expect(projects.locator('.thread-folder')).toHaveCount(3)
    await expectOneColumn(3)
    // A row is as tall as its action buttons.
    expect(await projects.locator('.thread-folder__head').first().evaluate(head => head.getBoundingClientRect().height >= head.querySelector('.thread-folder__actions button')!.getBoundingClientRect().height)).toBe(true)

    // Settled holds workshop's and notes' older threads, whose projects stay open, so those folders offer no action.
    await sidebar.getByRole('button', { name: /^Settled / }).click()
    await expect(sidebar.getByRole('region', { name: 'Settled', exact: true }).locator('.thread-folder')).toHaveCount(2)
    await expectOneColumn(5)

    // A settled project offers Restore alone; its folder moves down to Settled.
    await projects.getByRole('button', { name: 'Settle project sotto-site', exact: true }).click()
    await expect(projects.locator('.thread-folder')).toHaveCount(2)
    const restore = sidebar.getByRole('region', { name: 'Settled', exact: true }).getByRole('button', { name: 'Restore project sotto-site', exact: true })
    await expect(restore).toHaveCount(1)
    await expectOneColumn(5)
    // Restore sits where Settle does.
    const rightEdge = async (button: Locator): Promise<number> => { const box = (await button.boundingBox())!; return Math.round(box.x + box.width) }
    expect(await rightEdge(restore)).toBe(await rightEdge(projects.getByRole('button', { name: /^Settle project / }).first()))

    // Closed, a folder with work going or waiting shows a dot, and the count still ends where the others do.
    for (const toggle of await projects.locator('.thread-folder__toggle').all()) await toggle.click()
    await expect(projects.locator('.thread-nav__indicators')).toHaveCount(2)
    await expectOneColumn(5)
    const gaps = await projects.locator('.thread-nav__indicators').evaluateAll(dots => dots.map(dots => Math.round(dots.nextElementSibling!.getBoundingClientRect().left - dots.getBoundingClientRect().right)))
    expect(Math.max(...gaps)).toBeLessThanOrEqual(8)

    // The narrowest window keeps the column, as does the light theme.
    await resizeWindow(launched, 820, 560)
    await expectOneColumn(5)
    await page.evaluate(async () => window.sotto!.updateSettings({ appearance: 'light' }))
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await expectOneColumn(5)

    // A host's badge sits before the dots and the count, and loses its name in the narrowest sidebar. This one is supplied as
    // workspace-picker.spec.ts supplies it, without a remote connection.
    const head = projects.locator('.thread-folder__head').first()
    await head.locator('.thread-folder__title').evaluate(title => {
      const badge = document.createElement('span')
      badge.className = 'host-badge'; badge.dataset.kind = 'local'; badge.setAttribute('aria-hidden', 'true')
      badge.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M4 4h16v12H4zM2 20h20"/></svg><span class="host-badge__name">This computer</span>'
      title.after(badge)
    })
    const separator = page.getByRole('separator', { name: 'Resize sidebar' })
    for (const key of ['Home', 'End']) {
      await separator.focus()
      await separator.press(key)
      await expectOneColumn(5)
      expect(await head.evaluate(element => element.querySelector('.host-badge')!.getBoundingClientRect().right <= element.querySelector('.thread-nav__indicators')!.getBoundingClientRect().left)).toBe(true)
    }
  } finally { await closeSotto(launched) }
})

// Room an action does not use stays part of the folder's toggle, so a press on the far end of the row still opens it.
test('a folder row opens from its far end, up to the actions it shows', async () => {
  test.setTimeout(90_000)
  const launched = await launchSotto('design-threads')
  const { page } = launched
  try {
    const sidebar = await connect(page)
    const settled = sidebar.getByRole('region', { name: 'Settled', exact: true })
    await sidebar.getByRole('button', { name: /^Settled / }).click()
    const pressAt = async (head: Locator, fromRight: number): Promise<void> => {
      const toggle = head.locator('.thread-folder__toggle')
      await expect(toggle).toHaveAttribute('aria-expanded', 'true')
      const box = (await head.boundingBox())!
      await head.click({ position: { x: box.width - fromRight, y: box.height / 2 } })
      await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    }
    // No action at all: the very end of the row.
    await pressAt(settled.locator('.thread-folder__head').first(), 6)
    // Restore alone, 22px wide at the end of the row: the room beside it.
    await sidebar.getByRole('region', { name: 'Projects' }).getByRole('button', { name: 'Settle project sotto-site', exact: true }).click()
    await pressAt(settled.locator('.thread-folder__head').filter({ has: page.getByRole('button', { name: 'Restore project sotto-site', exact: true }) }), 40)
  } finally { await closeSotto(launched) }
})
