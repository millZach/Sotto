import React, { useEffect, useState, type ReactNode } from 'react'
import { Check, CircleAlert, Gauge, History, KeyRound } from 'lucide-react'
import { msg, plural } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import { shownCount } from '../../state/interfaceNumbers'
import { CLOUD_IPHONE_PRICE_PER_MINUTE_USD } from '../../../../shared/cloudIphone'
import type { AppSettings, SettingsPatch } from '../../../../shared/settings'
import { Button } from '../../components/Button'
import { Field } from '../../components/Field'
import { bridgeCloudIphone, cloudIphoneStore, useCloudStatus, type CloudIphoneBridgeLike, type CloudIphoneStore } from '../../tools/cloudIphoneStore'
import { SettingsGroup } from './SettingsGroup'
import { shownWords, type LaterWords } from './laterWords'
import './cloudIphone.css'

function parseBoundedInteger(value: string, minimum: number, maximum: number): number | null {
  if (!/^\d+$/u.test(value.trim())) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null
}

/** A text field that commits a whole number in range on blur, reverting on an invalid entry or a failed save. */
function useBoundedIntegerField(value: number, minimum: number, maximum: number, outOfRangeText: LaterWords, save: (value: number) => Promise<boolean>) {
  const [draft, setDraft] = useState(String(value))
  const [error, setError] = useState<LaterWords | undefined>(undefined)
  useEffect(() => { setDraft(String(value)) }, [value])
  const commit = async (): Promise<void> => {
    const parsed = parseBoundedInteger(draft, minimum, maximum)
    if (parsed === null) { setError(outOfRangeText); return }
    setError(undefined)
    if (parsed === value) return
    const saved = await save(parsed)
    if (!saved) setDraft(String(value))
  }
  return { draft, setDraft, error, commit }
}

/** "October" from a `YYYY-MM` month string. */
function monthName(month: string): string {
  const [year, monthNumber] = month.split('-').map(Number)
  if (!year || !monthNumber) return month
  return new Date(year, monthNumber - 1, 1).toLocaleDateString('en-US', { month: 'long' })
}

/** "Oct 3" for a recent session's start. */
function dateWords(iso: number): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export interface CloudIphoneSettingsProps {
  readonly settings: AppSettings
  readonly onUpdateSettings: (patch: SettingsPatch) => Promise<boolean>
  readonly bridge?: CloudIphoneBridgeLike
  readonly store?: CloudIphoneStore
}

/**
 * Settings > Cloud iPhone (ADR-0047): the run.cloud key, the monthly spending cap, this month's minutes against it,
 * the idle timeout, and recent sessions, in groups under small headings as Git's are (Zach's pick A, October 11,
 * 2026). Nothing here starts a session; that is the thread's own request card.
 */
export function CloudIphoneSettings({ settings, onUpdateSettings, bridge = bridgeCloudIphone(), store = cloudIphoneStore }: CloudIphoneSettingsProps): ReactNode {
  const { t } = useLingui()
  const status = useCloudStatus(store)
  useEffect(() => { void store.loadStatus(bridge) }, [store, bridge])

  const [key, setKey] = useState('')
  const [savingKey, setSavingKey] = useState(false)
  const [keyNotice, setKeyNotice] = useState<{ readonly text: LaterWords; readonly error: boolean } | null>(null)
  const keySaved = status?.keySaved ?? false

  const saveKey = async (value: string): Promise<void> => {
    setSavingKey(true); setKeyNotice(null)
    const result = await store.setKey(bridge, value)
    if (result.saved || (!value && result.problem === null)) { setKey(''); setKeyNotice({ text: value ? msg`Key saved.` : msg`Key removed.`, error: false }) }
    else setKeyNotice({ text: result.problem ?? msg`The key could not be saved. Nothing was changed.`, error: true })
    setSavingKey(false)
  }

  const monthlyCap = settings.cloudIphoneMonthlyMinutes
  const idleMinutes = settings.cloudIphoneIdleMinutes
  const cap = useBoundedIntegerField(monthlyCap, 10, 100_000, msg`Enter a whole number between 10 and 100000.`,
    value => onUpdateSettings({ cloudIphoneMonthlyMinutes: value }))
  const idle = useBoundedIntegerField(idleMinutes, 1, 60, msg`Enter a whole number between 1 and 60.`,
    value => onUpdateSettings({ cloudIphoneIdleMinutes: value }))

  const monthMinutes = status?.monthMinutes ?? 0
  const capMinutes = status?.capMinutes ?? monthlyCap
  const meterPercent = capMinutes > 0 ? Math.min(100, Math.round((monthMinutes / capMinutes) * 100)) : 0
  // Both numbers in the interface language, English ungrouped as before ("1234 of 2000 minutes"); the cap picks the plural.
  const usedMinutes = shownCount(monthMinutes), allowance = shownCount(capMinutes)
  const used = plural(capMinutes, { other: `${usedMinutes} of ${allowance} minutes` })
  const price = `$${CLOUD_IPHONE_PRICE_PER_MINUTE_USD.toFixed(2)}`
  const month = status ? monthName(status.month) : ''

  return <div className="cloud-iphone-settings">
    <SettingsGroup title="run.cloud" icon={KeyRound} note={t`Agents test iOS builds on a run.cloud simulator, and ask you before each session. Builds go to run.cloud in the EU and are deleted afterwards.`}>
      {/* The key and its verdict are one row, its buttons at the right under the field as Verify key sits on Cleanup. */}
      <div className="key-field">
        <Field setting="cloud-iphone-key" label={t({ message: 'Key', comment: 'The run.cloud key, a secret that lets Sotto use the service.' })} description={t`Checked with run.cloud before it is saved.`}>
          <input className="tt-input" type="password" autoComplete="off" spellCheck={false} value={key}
            placeholder={keySaved ? t`Key saved` : t`Paste your run.cloud key`}
            onChange={event => { setKey(event.target.value); setKeyNotice(null) }} />
        </Field>
        <div className="cloud-iphone-key__actions">
          {keySaved ? <Button variant="ghost" disabled={savingKey} onClick={() => void saveKey('')}>{t`Remove key`}</Button> : null}
          <Button variant="secondary" disabled={savingKey || !key.trim() || !bridge} onClick={() => void saveKey(key.trim())}>{savingKey ? t`Checking…` : keySaved ? t`Replace key` : t`Save key`}</Button>
        </div>
        {keyNotice ? <p className={`settings-remote-status${keyNotice.error ? ' settings-remote-status--error' : ''}${typeof keyNotice.text === 'string' ? '' : ' tt-paragraph'}`} role={keyNotice.error ? 'alert' : 'status'}>
          {keyNotice.error ? <CircleAlert size={16} aria-hidden="true" /> : <Check size={16} aria-hidden="true" />}{shownWords(keyNotice.text)}
        </p> : null}
      </div>
    </SettingsGroup>

    <SettingsGroup title={t`Spending`} icon={Gauge} note={t({ message: `About ${price} a minute; your first $15 each month is free.`, comment: '{price} is a price in US dollars, such as $0.05.' })}>
      <Field setting="cloud-iphone-cap" label={t`Monthly cap`} description={t`Minutes a month, 10 to 100000.`} {...(cap.error === undefined ? {} : { error: shownWords(cap.error) })}>
        <input className="tt-input" inputMode="numeric" value={cap.draft} onBlur={() => void cap.commit()} onChange={event => cap.setDraft(event.target.value)} />
      </Field>
      {/* This month's minutes as a row: the words where a label goes, the meter where a control goes. */}
      <div className="cloud-iphone-usage">
        <p className="cloud-iphone-usage__label">{status ? t({ message: `Used in ${month}`, comment: '{month} is the name of a month, such as October.' }) : t`Used in this month`}</p>
        <p className="cloud-iphone-usage__text">{used}</p>
        <div className="cloud-iphone-meter" role="meter" aria-label={t`Cloud iPhone minutes used this month`} aria-valuenow={monthMinutes} aria-valuemin={0} aria-valuemax={capMinutes} aria-valuetext={used}>
          <i style={{ width: `${meterPercent}%` }} />
        </div>
      </div>
      <Field setting="cloud-iphone-idle" label={t`Idle sessions end after`} description={t`Minutes without any activity, 1 to 60.`} {...(idle.error === undefined ? {} : { error: shownWords(idle.error) })}>
        <input className="tt-input" inputMode="numeric" value={idle.draft} onBlur={() => void idle.commit()} onChange={event => idle.setDraft(event.target.value)} />
      </Field>
    </SettingsGroup>

    <SettingsGroup title={t`Recent sessions`} icon={History}>
      {status && status.recent.length > 0
        ? <ul className="cloud-iphone-recent">{status.recent.map(item => { const minutes = item.minutes, sessionMinutes = shownCount(minutes); return <li key={`${item.threadId}-${item.startedAt}`}>
          <span>{item.threadTitle}</span><span>{dateWords(item.startedAt)}</span><span>{plural(minutes, { other: `${sessionMinutes} min` })}</span></li> })}</ul>
        : <p className="cloud-iphone-recent__empty tt-paragraph"><Trans>No sessions yet.</Trans></p>}
    </SettingsGroup>
  </div>
}
