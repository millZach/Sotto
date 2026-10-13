import React, { useEffect, useState, type ReactNode } from 'react'
import { Check, CircleAlert, Gauge, History, KeyRound } from 'lucide-react'
import { CLOUD_IPHONE_PRICE_PER_MINUTE_USD } from '../../../../shared/cloudIphone'
import type { AppSettings, SettingsPatch } from '../../../../shared/settings'
import { Button } from '../../components/Button'
import { Field } from '../../components/Field'
import { bridgeCloudIphone, cloudIphoneStore, useCloudStatus, type CloudIphoneBridgeLike, type CloudIphoneStore } from '../../tools/cloudIphoneStore'
import { SettingsGroup } from './SettingsGroup'
import './cloudIphone.css'

function parseBoundedInteger(value: string, minimum: number, maximum: number): number | null {
  if (!/^\d+$/u.test(value.trim())) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null
}

/** A text field that commits a whole number in range on blur, reverting on an invalid entry or a failed save. */
function useBoundedIntegerField(value: number, minimum: number, maximum: number, outOfRangeText: string, save: (value: number) => Promise<boolean>) {
  const [draft, setDraft] = useState(String(value))
  const [error, setError] = useState<string | undefined>(undefined)
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
  const status = useCloudStatus(store)
  useEffect(() => { void store.loadStatus(bridge) }, [store, bridge])

  const [key, setKey] = useState('')
  const [savingKey, setSavingKey] = useState(false)
  const [keyNotice, setKeyNotice] = useState<{ readonly text: string; readonly error: boolean } | null>(null)
  const keySaved = status?.keySaved ?? false

  const saveKey = async (value: string): Promise<void> => {
    setSavingKey(true); setKeyNotice(null)
    const result = await store.setKey(bridge, value)
    if (result.saved || (!value && result.problem === null)) { setKey(''); setKeyNotice({ text: value ? 'Key saved.' : 'Key removed.', error: false }) }
    else setKeyNotice({ text: result.problem ?? 'The key could not be saved. Nothing was changed.', error: true })
    setSavingKey(false)
  }

  const monthlyCap = settings.cloudIphoneMonthlyMinutes
  const idleMinutes = settings.cloudIphoneIdleMinutes
  const cap = useBoundedIntegerField(monthlyCap, 10, 100_000, 'Enter a whole number between 10 and 100000.',
    value => onUpdateSettings({ cloudIphoneMonthlyMinutes: value }))
  const idle = useBoundedIntegerField(idleMinutes, 1, 60, 'Enter a whole number between 1 and 60.',
    value => onUpdateSettings({ cloudIphoneIdleMinutes: value }))

  const monthMinutes = status?.monthMinutes ?? 0
  const capMinutes = status?.capMinutes ?? monthlyCap
  const meterPercent = capMinutes > 0 ? Math.min(100, Math.round((monthMinutes / capMinutes) * 100)) : 0
  const used = `${monthMinutes} of ${capMinutes} minutes`

  return <div className="cloud-iphone-settings">
    <SettingsGroup title="run.cloud" icon={KeyRound} note="Agents test iOS builds on a run.cloud simulator, and ask you before each session. Builds go to run.cloud in the EU and are deleted afterwards.">
      {/* The key and its verdict are one row, its buttons at the right under the field as Verify key sits on Cleanup. */}
      <div className="key-field">
        <Field label="Key" description="Checked with run.cloud before it is saved.">
          <input className="tt-input" type="password" autoComplete="off" spellCheck={false} value={key}
            placeholder={keySaved ? 'Key saved' : 'Paste your run.cloud key'}
            onChange={event => { setKey(event.target.value); setKeyNotice(null) }} />
        </Field>
        <div className="cloud-iphone-key__actions">
          {keySaved ? <Button variant="ghost" disabled={savingKey} onClick={() => void saveKey('')}>Remove key</Button> : null}
          <Button variant="secondary" disabled={savingKey || !key.trim() || !bridge} onClick={() => void saveKey(key.trim())}>{savingKey ? 'Checking…' : keySaved ? 'Replace key' : 'Save key'}</Button>
        </div>
        {keyNotice ? <p className={`settings-remote-status${keyNotice.error ? ' settings-remote-status--error' : ''}`} role={keyNotice.error ? 'alert' : 'status'}>
          {keyNotice.error ? <CircleAlert size={16} aria-hidden="true" /> : <Check size={16} aria-hidden="true" />}{keyNotice.text}
        </p> : null}
      </div>
    </SettingsGroup>

    <SettingsGroup title="Spending" icon={Gauge} note={`About $${CLOUD_IPHONE_PRICE_PER_MINUTE_USD.toFixed(2)} a minute; your first $15 each month is free.`}>
      <Field label="Monthly cap" description="Minutes a month, 10 to 100000." {...(cap.error === undefined ? {} : { error: cap.error })}>
        <input className="tt-input" inputMode="numeric" value={cap.draft} onBlur={() => void cap.commit()} onChange={event => cap.setDraft(event.target.value)} />
      </Field>
      {/* This month's minutes as a row: the words where a label goes, the meter where a control goes. */}
      <div className="cloud-iphone-usage">
        <p className="cloud-iphone-usage__label">Used in {status ? monthName(status.month) : 'this month'}</p>
        <p className="cloud-iphone-usage__text">{used}</p>
        <div className="cloud-iphone-meter" role="meter" aria-label="Cloud iPhone minutes used this month" aria-valuenow={monthMinutes} aria-valuemin={0} aria-valuemax={capMinutes} aria-valuetext={used}>
          <i style={{ width: `${meterPercent}%` }} />
        </div>
      </div>
      <Field label="Idle sessions end after" description="Minutes without any activity, 1 to 60." {...(idle.error === undefined ? {} : { error: idle.error })}>
        <input className="tt-input" inputMode="numeric" value={idle.draft} onBlur={() => void idle.commit()} onChange={event => idle.setDraft(event.target.value)} />
      </Field>
    </SettingsGroup>

    <SettingsGroup title="Recent sessions" icon={History}>
      {status && status.recent.length > 0
        ? <ul className="cloud-iphone-recent">{status.recent.map(item => <li key={`${item.threadId}-${item.startedAt}`}>
          <span>{item.threadTitle}</span><span>{dateWords(item.startedAt)}</span><span>{item.minutes} min</span></li>)}</ul>
        : <p className="cloud-iphone-recent__empty">No sessions yet.</p>}
    </SettingsGroup>
  </div>
}
