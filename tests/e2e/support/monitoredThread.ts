import { expect, type Locator, type Page } from '@playwright/test'
import { openThreads, type LaunchedSotto } from './sottoLaunch'

/** The held/working journeys keep their host keys in their own per-case fixture. */
export async function startMonitoredThread(launched: LaunchedSotto, readKeys: (page: Page) => Promise<void>,
  pane: (page: Page) => Locator): Promise<void> {
  await launched.page.evaluate(async () => {
    await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark', reducedMotion: 'system' })
    await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true } })
    await window.sotto!.agents!.command({ type: 'connect' })
  })
  await launched.page.reload()
  await readKeys(launched.page)
  await openThreads(launched.page)
  await launched.page.getByRole('complementary', { name: 'Thread sidebar' }).getByRole('button', { name: 'Workshop', exact: true }).click()
  await expect(pane(launched.page)).toBeVisible()
}

interface Bounds { left: number; right: number; top: number; bottom: number }
interface MonitorGeometry {
  width: number; height: number; monitor: Bounds; composer: Bounds; creature: Bounds; task: Bounds
  overflow: number; extraControls: number
}

export function monitorGeometry(pane: Locator, withTrack: true): Promise<MonitorGeometry & { track: Bounds }>
export function monitorGeometry(pane: Locator, withTrack?: false): Promise<MonitorGeometry>
export function monitorGeometry(pane: Locator, withTrack = false): Promise<MonitorGeometry & { track?: Bounds }> {
  return pane.evaluate((element, withTrack) => {
    const monitor = element.querySelector('.thread-monitor')!
    const composer = element.querySelector('.thread-prompt, .agent-composer')!
    const rect = (target: Element) => {
      const value = target.getBoundingClientRect()
      return { left: value.left, right: value.right, top: value.top, bottom: value.bottom }
    }
    return {
      width: innerWidth, height: innerHeight, monitor: rect(monitor), composer: rect(composer),
      creature: rect(monitor.querySelector('.thread-monitor__creature')!), task: rect(monitor.querySelector('.thread-monitor__task')!),
      overflow: element.scrollWidth - element.clientWidth,
      extraControls: monitor.querySelectorAll('button, input, textarea, select, a[href], [tabindex="0"]').length,
      ...(withTrack ? { track: rect(monitor.querySelector('.thread-monitor__track')!) } : {}),
    }
  }, withTrack)
}
