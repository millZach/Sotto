// PROTOTYPE — throwaway. Three ways to lay Settings > Cloud iPhone out the way the other Settings pages are, beside
// today's, switchable from the floating bar or with ← and →. Only the winner is folded into CloudIphoneSettings.
import React, { useId, useState, type ComponentType, type ReactNode } from 'react'
import { Check, CircleAlert, Gauge, History, KeyRound } from 'lucide-react'
import type { CloudIphoneStatus } from '../../../../shared/cloudIphone'
import { Button } from '../../components/Button'
import { Field } from '../../components/Field'
import { PrototypeSwitcher, prototypesEnabled, usePrototypeVariant } from '../../components/PrototypeSwitcher'
import { dateWords, monthName, type CloudIphoneModel } from './CloudIphoneSettings'
import './cloudIphonePrototype.css'

export const cloudIphonePrototypeEnabled = prototypesEnabled

const VARIANTS = [
  { key: 'A', name: 'Groups, like Git' },
  { key: 'B', name: 'One list, like Output' },
  { key: 'C', name: 'Usage first, like Transcription' },
  { key: 'Now', name: 'Today’s layout' },
] as const

/** A key saved, a third of the month's minutes used and three sessions, so the meter and the list have something in them. */
const SAMPLE: CloudIphoneStatus = {
  keySaved: true, month: '2026-10', monthMinutes: 212, capMinutes: 750,
  recent: [
    { threadId: 'workshop', threadTitle: 'Workshop', startedAt: Date.parse('2026-10-09T15:00:00'), minutes: 11 },
    { threadId: 'daybook', threadTitle: 'Daybook habit list on a native build', startedAt: Date.parse('2026-10-06T10:00:00'), minutes: 38 },
    { threadId: 'onboarding', threadTitle: 'Onboarding on iOS 18', startedAt: Date.parse('2026-10-02T09:00:00'), minutes: 4 },
  ],
}

function withSample(model: CloudIphoneModel): CloudIphoneModel {
  return {
    ...model, status: SAMPLE, keySaved: true, monthMinutes: SAMPLE.monthMinutes, capMinutes: SAMPLE.capMinutes,
    meterPercent: Math.round((SAMPLE.monthMinutes / SAMPLE.capMinutes) * 100), monthWords: monthName(SAMPLE.month),
  }
}

export function CloudIphonePrototype({ model: live, current }: { readonly model: CloudIphoneModel; readonly current: ReactNode }): ReactNode {
  const [variant, choose] = usePrototypeVariant(VARIANTS, 'cloud-iphone-settings')
  const [sample, setSample] = useState(true)
  const model = sample ? withSample(live) : live
  return <>
    {variant === 'A' ? <VariantA model={model} /> : null}
    {variant === 'B' ? <VariantB model={model} /> : null}
    {variant === 'C' ? <VariantC model={model} /> : null}
    {variant === 'Now' ? current : null}
    <PrototypeSwitcher variants={VARIANTS} current={variant} onChoose={choose}>
      <label className="prototype-switcher__option"><input type="checkbox" checked={sample} onChange={event => setSample(event.target.checked)} /> Sample data</label>
    </PrototypeSwitcher>
  </>
}

// ---- Pieces the three proposals share. Each layout arranges them its own way. ----

/** The key, its two buttons at the right under the field, as Verify key sits on Cleanup, and the verdict under them. */
function KeyRow({ model, label, description }: { readonly model: CloudIphoneModel; readonly label: string; readonly description: string }): ReactNode {
  const { keySaved, key, editKey, savingKey, canSaveKey, keyNotice, saveKey } = model
  return <div className="key-field cloud-proto__key">
    <Field label={label} description={description}>
      <input className="tt-input" type="password" autoComplete="off" spellCheck={false} value={key}
        placeholder={keySaved ? 'Key saved' : 'Paste your run.cloud key'}
        onChange={event => editKey(event.target.value)} />
    </Field>
    <div className="cloud-proto__actions">
      {keySaved ? <Button variant="ghost" disabled={savingKey} onClick={() => void saveKey('')}>Remove key</Button> : null}
      <Button variant="secondary" disabled={savingKey || !key.trim() || !canSaveKey} onClick={() => void saveKey(key.trim())}>{savingKey ? 'Checking…' : keySaved ? 'Replace key' : 'Save key'}</Button>
    </div>
    {keyNotice ? <p className={`settings-remote-status${keyNotice.error ? ' settings-remote-status--error' : ''}`} role={keyNotice.error ? 'alert' : 'status'}>
      {keyNotice.error ? <CircleAlert size={16} aria-hidden="true" /> : <Check size={16} aria-hidden="true" />}{keyNotice.text}
    </p> : null}
  </div>
}

function CapField({ model }: { readonly model: CloudIphoneModel }): ReactNode {
  const { cap } = model
  return <Field label="Monthly cap" description="Minutes a month, 10 to 100000." {...(cap.error === undefined ? {} : { error: cap.error })}>
    <input className="tt-input" inputMode="numeric" value={cap.draft} onBlur={() => void cap.commit()} onChange={event => cap.setDraft(event.target.value)} />
  </Field>
}

function IdleField({ model }: { readonly model: CloudIphoneModel }): ReactNode {
  const { idle } = model
  return <Field label="Idle sessions end after" description="Minutes with no tap, typing or agent action, 1 to 60." {...(idle.error === undefined ? {} : { error: idle.error })}>
    <input className="tt-input" inputMode="numeric" value={idle.draft} onBlur={() => void idle.commit()} onChange={event => idle.setDraft(event.target.value)} />
  </Field>
}

function Meter({ model }: { readonly model: CloudIphoneModel }): ReactNode {
  return <div className="cloud-proto__meter" role="meter" aria-label="Cloud iPhone minutes used this month" aria-valuenow={model.monthMinutes} aria-valuemin={0} aria-valuemax={model.capMinutes}>
    <i style={{ width: `${model.meterPercent}%` }} />
  </div>
}

/** This month's minutes as a row: words on the left, the meter where a control sits. */
function UsageRow({ model, note }: { readonly model: CloudIphoneModel; readonly note?: string }): ReactNode {
  return <div className="cloud-proto__usage">
    <p className="cloud-proto__label">Used in {model.monthWords}</p>
    <p className="cloud-proto__description">{model.monthMinutes} of {model.capMinutes} minutes.{note ? ` ${note}` : ''}</p>
    <Meter model={model} />
  </div>
}

function Sessions({ model }: { readonly model: CloudIphoneModel }): ReactNode {
  const recent = model.status?.recent ?? []
  return recent.length > 0
    ? <ul className="cloud-proto__sessions">{recent.map(item => <li key={`${item.threadId}-${item.startedAt}`}>
      <span>{item.threadTitle}</span><span>{dateWords(item.startedAt)}</span><span>{item.minutes} min</span></li>)}</ul>
    : <p className="cloud-proto__empty">No sessions yet.</p>
}

type GroupIcon = ComponentType<{ size?: number; strokeWidth?: number; 'aria-hidden'?: 'true' }>

/** Git's group: a small heading with its icon, an optional note, and hairline rows. */
function Group({ title, icon: Icon, note, children }: { readonly title: string; readonly icon: GroupIcon; readonly note?: string; readonly children: ReactNode }): ReactNode {
  const id = useId()
  return <section className="git-settings__group" aria-labelledby={id}>
    <h3 id={id}><Icon size={16} strokeWidth={1.7} aria-hidden="true" />{title}</h3>
    {note ? <p className="git-settings__group-note">{note}</p> : null}
    <div className="settings-rows">{children}</div>
  </section>
}

// ---- A: three groups under small headings, as Git groups its settings. ----

function VariantA({ model }: { readonly model: CloudIphoneModel }): ReactNode {
  return <div className="cloud-proto cloud-proto--a">
    <Group title="run.cloud" icon={KeyRound} note="Agents test native iOS builds on a run.cloud simulator, and each session asks you first. The build is uploaded to run.cloud, in the EU, and deleted when the session ends.">
      <KeyRow model={model} label="Key" description="Checked with run.cloud before it is saved." />
    </Group>
    <Group title="Spending" icon={Gauge} note={`About $${model.price} a minute; your first $15 each month is free.`}>
      <CapField model={model} />
      <UsageRow model={model} />
      <IdleField model={model} />
    </Group>
    <Group title="Recent sessions" icon={History}>
      <Sessions model={model} />
    </Group>
  </div>
}

// ---- B: one run of rows with no subheadings, as Output and Cleanup are, closed by the privacy line. ----

function VariantB({ model }: { readonly model: CloudIphoneModel }): ReactNode {
  return <div className="settings-rows cloud-proto cloud-proto--b">
    <KeyRow model={model} label="run.cloud key" description="Agents test native iOS builds on a run.cloud simulator, and each session asks you first. Checked with run.cloud before it is saved." />
    <CapField model={model} />
    <UsageRow model={model} note={`About $${model.price} a minute; your first $15 each month is free.`} />
    <IdleField model={model} />
    <div className="cloud-proto__recent">
      <p className="cloud-proto__label">Recent sessions</p>
      <Sessions model={model} />
    </div>
    <p className="settings-disclosure">When a session starts, its build is uploaded to run.cloud, in the EU, and deleted when the session ends.</p>
  </div>
}

// ---- C: the month's minutes lead as a statement, as the speech model leads Transcription, then rows, then sessions. ----

function VariantC({ model }: { readonly model: CloudIphoneModel }): ReactNode {
  return <div className="cloud-proto cloud-proto--c">
    <div className="settings-rows">
      <div className="settings-model-statement cloud-proto__statement">
        <h3>{model.monthMinutes} of {model.capMinutes} minutes used in {model.monthWords}</h3>
        <p>About ${model.price} a minute; your first $15 each month is free. Agents test native iOS builds on a run.cloud simulator, and each session asks you first.</p>
        <Meter model={model} />
      </div>
      <KeyRow model={model} label="run.cloud key" description="Checked with run.cloud before it is saved." />
      <CapField model={model} />
      <IdleField model={model} />
      <p className="settings-disclosure">When a session starts, its build is uploaded to run.cloud, in the EU, and deleted when the session ends.</p>
    </div>
    <div className="settings-updates">
      <div className="settings-section__heading"><h2>Recent sessions</h2><p>The last sessions agents ran, newest first.</p></div>
      <Sessions model={model} />
    </div>
  </div>
}
