import React, { useEffect, useState, type ReactNode } from 'react'
import { ph, plural } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import { CLOUD_IPHONE_PRICE_PER_MINUTE_USD } from '../../../../shared/cloudIphone'
import { Button } from '../../components/Button'
import { useOptionalApp } from '../../state/AppContext'
import { bridgeCloudIphone, cloudIphoneStore, useCloudSession, useCloudStatus, type CloudIphoneBridgeLike, type CloudIphoneStore } from '../../tools/cloudIphoneStore'
import { shownCount } from '../interfaceWords'
import './requests.css'

/** "41 MB", "1.2 GB": the build's size in the units a person reads, not bytes. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1 }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

export interface CloudIphoneRequestProps {
  readonly threadId: string
  readonly threadTitle: string
  readonly bridge?: CloudIphoneBridgeLike
  /** Moves focus somewhere sensible once the user's answer has taken, as the permission cards beside this one do. */
  readonly onAnswer: () => void
  readonly store?: CloudIphoneStore
}

/**
 * The thread's cloud iPhone request (ADR-0047), in the transcript right after its permission requests: asking,
 * starting, or why it was refused or failed. A session that is active, ended or denied shows no card here; the
 * phone player and Tools > iPhone carry it from there.
 */
export function CloudIphoneRequest({ threadId, threadTitle, bridge = bridgeCloudIphone(), onAnswer, store = cloudIphoneStore }: CloudIphoneRequestProps): ReactNode {
  const { t } = useLingui()
  useEffect(() => { store.watch(bridge, threadId); void store.loadStatus(bridge) }, [store, bridge, threadId])
  const session = useCloudSession(threadId, store)
  const status = useCloudStatus(store)
  const app = useOptionalApp()
  const [answering, setAnswering] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => { setProblem(null) }, [session?.id])
  const expiresAt = session?.status === 'asking' ? session.expiresAt : null
  // The time left shows only in the request's last minute; until then the card waits without a ticking clock.
  useEffect(() => {
    if (expiresAt === null) return
    let interval: ReturnType<typeof setInterval> | undefined
    const begin = (): void => { setNow(Date.now()); interval = setInterval(() => setNow(Date.now()), 1000) }
    const wait = expiresAt - 60_000 - Date.now()
    const timeout = wait > 0 ? setTimeout(begin, wait) : undefined
    if (wait <= 0) begin()
    return () => { if (timeout) clearTimeout(timeout); if (interval) clearInterval(interval) }
  }, [expiresAt])

  if (!session) return null

  const answer = (allow: boolean): void => {
    setAnswering(true); setProblem(null)
    void store.answer(bridge, session, allow).then(error => { if (error) setProblem(error); else onAnswer() }).finally(() => setAnswering(false))
  }

  if (session.status === 'asking') {
    const left = expiresAt === null ? null : expiresAt - now
    const monthMinutes = status?.monthMinutes ?? 0
    const capMinutes = status?.capMinutes ?? 0
    const buildPath = session.buildPath
    const size = formatBytes(session.buildBytes)
    const price = CLOUD_IPHONE_PRICE_PER_MINUTE_USD.toFixed(2)
    const secondsLeft = left === null ? 0 : Math.max(0, Math.ceil(left / 1000))
    return <section className="agent-request" aria-label={t`Cloud iPhone request for ${threadTitle}`}>
      <div className="agent-request__head"><strong><Trans>{threadTitle} wants to start a cloud iPhone.</Trans></strong></div>
      {session.description ? <p className="agent-request__text">{session.description}</p> : null}
      <p className="agent-request__text tt-paragraph"><Trans comment="{price} is US dollars a minute; run.cloud is the service's name.">Uploads <code dir="ltr">{buildPath}</code> ({size}) to run.cloud and starts an iPhone simulator. About ${price} a minute. {ph({ monthMinutes: shownCount(monthMinutes) })} of {ph({ capMinutes: shownCount(capMinutes) })} minutes used this month.</Trans></p>
      <div className="agent-request__actions">
        <Button disabled={answering} onClick={() => answer(true)}><Trans>Start cloud iPhone</Trans></Button>
        <Button variant="secondary" disabled={answering} onClick={() => answer(false)}>{t({ message: 'Deny', comment: 'Answers an agent’s permission request.' })}</Button>
      </div>
      {left !== null && left <= 60_000 ? <p className="agent-request__status tt-paragraph" role="status">{plural(secondsLeft, { other: '# seconds left to answer' })}</p> : null}
      {problem ? <p className="agent-request__error tt-paragraph" role="alert">{problem}</p> : null}
    </section>
  }

  if (session.status === 'starting') {
    const buildPath = session.buildPath
    return <section className="agent-request" aria-label={t`Starting the cloud iPhone`}>
      <div className="agent-request__head"><strong><Trans>Starting the cloud iPhone…</Trans></strong></div>
      <p className="agent-request__status tt-paragraph" role="status"><Trans>Uploading {buildPath} to run.cloud and starting the simulator.</Trans></p>
    </section>
  }

  if (session.status === 'refused' || session.status === 'failed') {
    const couldNot = t`${threadTitle} could not start a cloud iPhone.`
    const text = session.problem ?? couldNot
    const mentionsSettings = /settings/iu.test(text)
    return <section className="agent-request" aria-label={t`Cloud iPhone problem`}>
      <div className="agent-request__head"><strong>{couldNot}</strong></div>
      <p className="agent-request__error tt-paragraph" role="status">{text}</p>
      {mentionsSettings ? <div className="agent-request__actions">
        <Button variant="ghost" onClick={() => app?.actions.navigate('settings', 'settings-cloud-iphone')}><Trans>Open Settings</Trans></Button>
      </div> : null}
    </section>
  }

  return null
}
