import React, { useEffect, useState, type ReactNode } from 'react'
import { CLOUD_IPHONE_PRICE_PER_MINUTE_USD, type CloudIphoneStatus } from '../../../../shared/cloudIphone'
import type { AppSettings, SettingsPatch } from '../../../../shared/settings'
import { Button } from '../../components/Button'
import { Card } from '../../components/Card'
import { Field } from '../../components/Field'
import { bridgeCloudIphone, cloudIphoneStore, useCloudStatus, type CloudIphoneBridgeLike, type CloudIphoneStore } from '../../tools/cloudIphoneStore'
import { CloudIphonePrototype, cloudIphonePrototypeEnabled } from './CloudIphoneSettings.prototype'
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

export type BoundedIntegerField = ReturnType<typeof useBoundedIntegerField>

/** "October" from a `YYYY-MM` month string. */
export function monthName(month: string): string {
  const [year, monthNumber] = month.split('-').map(Number)
  if (!year || !monthNumber) return month
  return new Date(year, monthNumber - 1, 1).toLocaleDateString('en-US', { month: 'long' })
}

/** "Oct 3" for a recent session's start. */
export function dateWords(iso: number): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export interface CloudIphoneSettingsProps {
  readonly settings: AppSettings
  readonly onUpdateSettings: (patch: SettingsPatch) => Promise<boolean>
  readonly bridge?: CloudIphoneBridgeLike
  readonly store?: CloudIphoneStore
}

/** Everything the page shows and does, read once so each layout draws the same state. */
export interface CloudIphoneModel {
  readonly status: CloudIphoneStatus | null
  readonly keySaved: boolean
  readonly key: string
  readonly editKey: (value: string) => void
  readonly savingKey: boolean
  readonly canSaveKey: boolean
  readonly keyNotice: { readonly text: string; readonly error: boolean } | null
  readonly saveKey: (value: string) => Promise<void>
  readonly cap: BoundedIntegerField
  readonly idle: BoundedIntegerField
  readonly monthMinutes: number
  readonly capMinutes: number
  readonly meterPercent: number
  readonly monthWords: string
  readonly price: string
}

function useCloudIphoneModel({ settings, onUpdateSettings, bridge, store }: Required<Pick<CloudIphoneSettingsProps, 'bridge' | 'store'>> & CloudIphoneSettingsProps): CloudIphoneModel {
  const status = useCloudStatus(store)
  useEffect(() => { void store.loadStatus(bridge) }, [store, bridge])

  const [key, setKey] = useState('')
  const [savingKey, setSavingKey] = useState(false)
  const [keyNotice, setKeyNotice] = useState<{ readonly text: string; readonly error: boolean } | null>(null)

  const saveKey = async (value: string): Promise<void> => {
    setSavingKey(true); setKeyNotice(null)
    const result = await store.setKey(bridge, value)
    if (result.saved || (!value && result.problem === null)) { setKey(''); setKeyNotice({ text: value ? 'Key saved.' : 'Key removed.', error: false }) }
    else setKeyNotice({ text: result.problem ?? 'The key could not be saved. Nothing was changed.', error: true })
    setSavingKey(false)
  }

  const monthlyCap = settings.cloudIphoneMonthlyMinutes
  const cap = useBoundedIntegerField(monthlyCap, 10, 100_000, 'Enter a whole number between 10 and 100000.',
    value => onUpdateSettings({ cloudIphoneMonthlyMinutes: value }))
  const idle = useBoundedIntegerField(settings.cloudIphoneIdleMinutes, 1, 60, 'Enter a whole number between 1 and 60.',
    value => onUpdateSettings({ cloudIphoneIdleMinutes: value }))

  const monthMinutes = status?.monthMinutes ?? 0
  const capMinutes = status?.capMinutes ?? monthlyCap
  return {
    status,
    keySaved: status?.keySaved ?? false,
    key,
    editKey: value => { setKey(value); setKeyNotice(null) },
    savingKey,
    canSaveKey: Boolean(bridge),
    keyNotice,
    saveKey,
    cap,
    idle,
    monthMinutes,
    capMinutes,
    meterPercent: capMinutes > 0 ? Math.min(100, Math.round((monthMinutes / capMinutes) * 100)) : 0,
    monthWords: status ? monthName(status.month) : 'this month',
    price: CLOUD_IPHONE_PRICE_PER_MINUTE_USD.toFixed(2),
  }
}

/**
 * Settings > Cloud iPhone (ADR-0047): the run.cloud key, the monthly spending cap, the idle timeout, this month's
 * minutes against the cap, and recent sessions. Nothing here starts a session; that is the thread's own request card.
 */
export function CloudIphoneSettings({ bridge = bridgeCloudIphone(), store = cloudIphoneStore, ...props }: CloudIphoneSettingsProps): ReactNode {
  const model = useCloudIphoneModel({ ...props, bridge, store })
  if (cloudIphonePrototypeEnabled()) return <CloudIphonePrototype model={model} current={<CurrentLayout model={model} />} />
  return <CurrentLayout model={model} />
}

function CurrentLayout({ model }: { readonly model: CloudIphoneModel }): ReactNode {
  const { status, keySaved, key, editKey, savingKey, canSaveKey, keyNotice, saveKey, cap, idle, monthMinutes, capMinutes, meterPercent, monthWords, price } = model
  return <div className="settings-rows cloud-iphone-settings">
    <p className="cloud-iphone-intro">Agents test native iOS builds on a run.cloud simulator. Each session asks you first.</p>

    <Card as="section" className="cloud-iphone-card" aria-labelledby="cloud-iphone-runcloud">
      <h3 id="cloud-iphone-runcloud">run.cloud</h3>
      <p>The build is uploaded to run.cloud, in the EU, and deleted when the session ends. About ${price} a minute; your first $15 each month is free.</p>
      <div className="settings-input-action">
        <Field label="Key" description="Checked with run.cloud before it is saved.">
          <input className="tt-input" type="password" autoComplete="off" spellCheck={false} value={key}
            placeholder={keySaved ? 'Saved securely · enter to replace' : 'Paste your run.cloud key'}
            onChange={event => editKey(event.target.value)} />
        </Field>
      </div>
      <div className="cloud-iphone-actions">
        <Button variant="secondary" disabled={savingKey || !key.trim() || !canSaveKey} onClick={() => void saveKey(key.trim())}>{savingKey ? 'Checking…' : keySaved ? 'Replace key' : 'Save key'}</Button>
        {keySaved ? <Button variant="ghost" disabled={savingKey} onClick={() => void saveKey('')}>Remove key</Button> : null}
      </div>
      {keyNotice ? <p className={keyNotice.error ? 'tt-field__error' : 'settings-disclosure'} role={keyNotice.error ? 'alert' : 'status'}>{keyNotice.text}</p> : null}
    </Card>

    <Card as="section" className="cloud-iphone-card" aria-labelledby="cloud-iphone-spending">
      <h3 id="cloud-iphone-spending">Spending</h3>
      <div className="settings-input-action">
        <Field label="Monthly cap" description="Minutes a month, 10 to 100000." {...(cap.error === undefined ? {} : { error: cap.error })}>
          <input className="tt-input" inputMode="numeric" value={cap.draft} onBlur={() => void cap.commit()} onChange={event => cap.setDraft(event.target.value)} />
        </Field>
      </div>
      <div className="cloud-iphone-usage">
        <span>Used in {monthWords}</span>
        <span>{monthMinutes} of {capMinutes} minutes</span>
        <div className="cloud-iphone-meter" role="meter" aria-label="Cloud iPhone minutes used this month" aria-valuenow={monthMinutes} aria-valuemin={0} aria-valuemax={capMinutes}>
          <i style={{ width: `${meterPercent}%` }} />
        </div>
      </div>
      <div className="settings-input-action">
        <Field label="Idle sessions end after" description="Minutes with no tap, typing or agent action, 1 to 60." {...(idle.error === undefined ? {} : { error: idle.error })}>
          <input className="tt-input" inputMode="numeric" value={idle.draft} onBlur={() => void idle.commit()} onChange={event => idle.setDraft(event.target.value)} />
        </Field>
      </div>
    </Card>

    <Card as="section" className="cloud-iphone-card" aria-labelledby="cloud-iphone-recent">
      <h3 id="cloud-iphone-recent">Recent sessions</h3>
      {status && status.recent.length > 0
        ? <ul className="cloud-iphone-recent">{status.recent.map(item => <li key={`${item.threadId}-${item.startedAt}`}>
          <span>{item.threadTitle}</span><span>{dateWords(item.startedAt)}</span><span>{item.minutes} min</span></li>)}</ul>
        : <p>No sessions yet.</p>}
    </Card>
  </div>
}
