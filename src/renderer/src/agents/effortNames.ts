import { msg } from '@lingui/core/macro'
import { effortKey } from '../../../shared/reasoningEfforts'
import { wordsOf } from './interfaceWords'

/**
 * The one name of each reasoning effort level Sotto knows (#227), on the effort card, New thread, New terminal, Settings and
 * every other place a level is named. A level is found by its spelling-free key (`effortKey`), so `xhigh`, `x-high` and
 * `Extra_High` read the same; the provider's own id still goes back to it unchanged. Zach picked XHigh for `xhigh`
 * (November 9, 2026).
 */
const EFFORT_NAMES: Readonly<Record<string, string>> = wordsOf({
  none: msg({ message: 'None', comment: 'A reasoning effort level: no reasoning before the answer.' }),
  minimal: msg({ message: 'Minimal', comment: 'A reasoning effort level.' }),
  low: msg({ message: 'Low', comment: 'A reasoning effort level.' }),
  medium: msg({ message: 'Medium', comment: 'A reasoning effort level.' }),
  high: msg({ message: 'High', comment: 'A reasoning effort level.' }),
  xhigh: msg({ message: 'XHigh', comment: 'A reasoning effort level, one step above High. XHigh is its name; keep it as it is.' }),
  max: msg({ message: 'Max', comment: 'A reasoning effort level, the highest some models offer.' }),
  ultracode: msg({ message: 'Ultracode', comment: 'The effort level past Max on Claude models, where Claude Code plans the work and runs it as a team of agents. Ultracode is Claude Code’s own name; keep it as it is.' }),
})
/** Other spellings of a level Sotto knows, by key. */
const SAME_LEVEL: Readonly<Record<string, string>> = { extrahigh: 'xhigh' }

/** A level's name; a provider's level Sotto does not know shows as the provider names it, capitalised. */
export function effortLabel(value: string): string {
  const key = effortKey(value)
  const level = SAME_LEVEL[key] ?? key
  return Object.hasOwn(EFFORT_NAMES, level) ? EFFORT_NAMES[level]! : value.charAt(0).toUpperCase() + value.slice(1)
}
