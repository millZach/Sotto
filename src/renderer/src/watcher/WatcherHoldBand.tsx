import React, { useEffect, useId, useState, type ReactNode } from 'react'
import { Clock, Unplug } from 'lucide-react'
import { plural, t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'

import type { WatcherHold } from '../../../shared/watcherHold'
import { localeFormatter } from '../agents/localeFormat'
import { restartProviderName, restartWhen } from '../agents/restartWords'
import type { WatcherRoom } from './watcherRoom'

const clockTime = localeFormatter({ hour: 'numeric', minute: '2-digit' })
const clock = (at: string): string => clockTime(new Date(at)).toLocaleLowerCase()

/** The band's words, worked out from the hold main published, never guessed here. Exported for tests. */
export function holdBandWords(hold: WatcherHold, now: number): { readonly lead: string; readonly rest: string; readonly tryable: boolean } {
  const name = restartProviderName(hold.provider)
  const held = hold.held
  if (hold.kind === 'limited' && hold.resetsAt !== undefined) {
    const when = restartWhen(Date.parse(hold.resetsAt), now)
    return {
      lead: when === null
        ? t({ message: `Watcher’s ${name} limit has reset.`, comment: '{name} is a provider, such as Claude Code.' })
        : t({ message: `Watcher’s ${name} limit resets ${when}.`, comment: '{name} is a provider, such as Claude Code; {when} is "at 3:00 pm", "tomorrow at 3:00 pm" or "Monday at 3:00 pm".' }),
      rest: when === null
        ? t`Watcher gets what Sotto held in one message now.`
        : plural(held, { 0: 'Sotto holds news until then.', other: 'Sotto is holding # news until then.' }),
      tryable: false,
    }
  }
  const rest = held === 0 ? t`Sotto holds news and tries again every few minutes.`
    : plural(held, { other: 'Sotto holds news and tries again every few minutes. Holding # so far.' })
  return {
    lead: hold.kind === 'limited'
      ? t({ message: `Watcher’s ${name} limit is used up, and ${name} didn’t say when it resets.`, comment: '{name} is a provider, such as Devin.' })
      : t({ message: `${name} isn’t answering.`, comment: 'Watcher\'s provider fails every turn. {name} is a provider, such as Claude Code.' }),
    rest, tryable: true,
  }
}

/** What "What's held" opens to: where the held news came from, and when Watcher gets it. */
function heldWords(hold: WatcherHold): string {
  if (hold.held === 0) return t`Nothing yet. Watcher gets what comes in one message at the reset. A message you send goes first.`
  const threads = hold.held - hold.pullRequests
  const from = hold.pullRequests === 0 ? plural(threads, { other: 'All # from threads.' })
    : threads === 0 ? plural(hold.pullRequests, { other: 'All # from pull requests.' })
      : t({ message: `${hold.pullRequests} from pull requests, ${threads} from threads.`, comment: 'How the news Sotto holds for Watcher splits.' })
  return `${from} ${t`Watcher gets it in one message at the reset. A message you send goes first.`}`
}

/**
 * The band in Watcher's room while its own provider is limited or failing (ADR-0144, November 5, 2026 amendment, #2234;
 * Zach's pick A): one band under the strip, in the limit restart band's style. It is the one notice: the turn that met
 * the limit or the failure posts no reply, and the provider's error shows only under Details. The composer still takes
 * a message, which waits and goes first.
 */
export function WatcherHoldBand({ room, now }: { readonly room: WatcherRoom | null; readonly now?: number | undefined }): ReactNode {
  const hold = room?.state?.hold
  const [open, setOpen] = useState(false)
  const [trying, setTrying] = useState(false)
  const [refused, setRefused] = useState<string | null>(null)
  // A minute's clock, so "resets at 3:00 pm" becomes "has reset" without another update from main.
  const [tick, setTick] = useState(() => Date.now())
  useEffect(() => {
    if (hold === undefined) return
    const timer = setInterval(() => setTick(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [hold])
  const heldId = useId()
  if (hold === undefined) return null
  const words = holdBandWords(hold, now ?? tick)
  const limitedWithReset = hold.kind === 'limited' && hold.resetsAt !== undefined
  const tryNow = room?.tryNow ?? null
  const press = (): void => {
    if (trying || tryNow === null || room === null) return
    setTrying(true); setRefused(null)
    void tryNow().then(result => setRefused(room.settle(result)), () => setRefused(t`Sotto could not reach Watcher. Nothing was sent. Press Try now again.`))
      .finally(() => setTrying(false))
  }
  const Icon = hold.kind === 'failing' ? Unplug : Clock
  const since = clock(hold.since)
  // A group, as the limit restart band is: the room changing announces nothing unasked.
  return <section className="watcher-hold" role="group" aria-label={words.lead} data-kind={hold.kind}>
    <Icon size={14} aria-hidden="true" />
    <div className="watcher-hold__body">
      <p className="watcher-hold__words"><strong>{words.lead}</strong> {words.rest}</p>
      <div className="watcher-hold__acts">
        {limitedWithReset
          ? <button type="button" className="watcher-hold__link tt-focusable" aria-expanded={open} aria-controls={heldId} onClick={() => setOpen(value => !value)}>
            <Trans>What’s held</Trans>
          </button>
          : null}
        {words.tryable && tryNow !== null
          ? <button type="button" className="watcher-hold__link tt-focusable" aria-disabled={trying || undefined} onClick={press}><Trans>Try now</Trans></button>
          : null}
        {words.tryable && hold.lastTryAt !== undefined
          ? <span className="watcher-hold__meta">{t({ message: `Last try ${clock(hold.lastTryAt)}`, comment: 'When Sotto last tried Watcher\'s failing provider, as in "Last try 2:44 pm".' })}</span>
          : null}
      </div>
      {limitedWithReset && open ? <p id={heldId} className="watcher-hold__held">{heldWords(hold)}</p> : null}
      {refused !== null ? <p className="watcher-hold__error" role="alert">{refused}</p> : null}
      {!limitedWithReset && hold.detail !== undefined ? <details className="watcher-hold__details">
        <summary className="tt-focusable"><Trans>Details</Trans></summary>
        <pre>{hold.detail}</pre>
        <p className="watcher-hold__meta">{plural(hold.tries + 1, {
          1: `Failing since ${since}`,
          other: `Failing since ${since} · # tries`,
        })}</p>
      </details> : null}
    </div>
  </section>
}
