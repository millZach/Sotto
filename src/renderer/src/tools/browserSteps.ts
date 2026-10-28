import { i18n } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import type { BrowserTask } from '../../../shared/browser'

type Step = BrowserTask['steps'][number]

/** A page's address as the pane shows it: its host and path, without the scheme or a lone slash. */
export function shortAddress(url: string): string {
  try {
    const parsed = new URL(url)
    const path = parsed.pathname === '/' ? '' : parsed.pathname
    return `${parsed.host}${path}${parsed.search}` || url
  } catch { return url }
}

/** The key a key step pressed, read from main's own detail ("Pressed Enter."), or null. */
function pressedKey(detail: string): string | null {
  return /^Pressed ([A-Za-z]+)\./u.exec(detail)?.[1] ?? null
}

/**
 * One browser step in plain words, as the agent's strip and the thread say it (ADR-0154). An action carries only
 * its kind and coordinates, never what was under them, so a click is "clicked in the page" rather than a guess at a
 * button's name. A failed step says it was tried.
 */
export function browserStepWords(step: Step): string {
  const failed = step.status === 'failed'
  const where = step.url ? shortAddress(step.url) : ''
  switch (step.action) {
    case 'inspect': return i18n._(failed ? msg`tried to look at the page` : msg`looked at the page`)
    case 'screenshot': return i18n._(failed ? msg`tried to take a picture of the page` : msg`took a picture of the page`)
    case 'navigate': return where
      ? i18n._(failed ? msg({ message: `tried to go to ${where}`, comment: '{where} is a page address, such as localhost:5173/notes.' }) : msg({ message: `went to ${where}`, comment: '{where} is a page address, such as localhost:5173/notes.' }))
      : i18n._(failed ? msg`tried to go to another page` : msg`went to another page`)
    case 'click': return i18n._(failed ? msg`tried to click in the page` : msg`clicked in the page`)
    case 'type': return i18n._(failed ? msg`tried to type into the page` : msg`typed into the page`)
    case 'scroll': return i18n._(failed ? msg`tried to scroll the page` : msg`scrolled the page`)
    case 'viewport': return i18n._(failed ? msg`tried to change the page size` : msg`changed the page size`)
    case 'tap': return i18n._(failed ? msg`tried to tap in the page` : msg`tapped in the page`)
    case 'swipe': return i18n._(failed ? msg`tried to swipe in the page` : msg`swiped in the page`)
    case 'key': {
      const key = pressedKey(step.detail)
      if (key === null) return i18n._(failed ? msg`tried to press a key` : msg`pressed a key`)
      return i18n._(failed ? msg({ message: `tried to press ${key}`, comment: '{key} is a key name, such as Enter.' }) : msg({ message: `pressed ${key}`, comment: '{key} is a key name, such as Enter.' }))
    }
    default: return i18n._(failed ? msg`tried to work in the page` : msg`worked in the page`)
  }
}

/** What the agent's strip says about a working or paused task: what it is doing, then its last step if it took one. */
export function browsingWords(task: BrowserTask, pageUrl: string | undefined): { readonly lead: string; readonly last: string } {
  const step = task.steps.at(-1)
  const host = pageUrl ? shortAddress(pageUrl) : ''
  const lead = task.status === 'paused' ? i18n._(msg`Browsing paused`) : i18n._(msg({ message: 'Agent is browsing', comment: 'Said at the foot of the browser while a thread\'s agent works on the page.' }))
  return { lead, last: step ? browserStepWords(step) : host }
}
