import React, { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { plural } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import { PROVIDER_LABELS, providerIdSchema, type ProviderId } from '../../../../shared/agents'
import { DYNAMIC_EFFORTS, DYNAMIC_NOTE_MAX_CHARACTERS, dynamicEffortSchema, WORKERS_AT_ONCE_MAX, workersAtOnceSchema, type DynamicThreadSettings } from '../../../../shared/dynamicThreads'
import type { SettingsPatch } from '../../../../shared/settings'
import { reportsUsageLimits, type UsageQuotaRead } from '../../../../shared/usageDashboard'
import { useOptionalAgents } from '../../agents/AgentContext'
import { companyWords, firstAllowedProviders } from '../../agents/DynamicSwitch'
import { effortLabel } from '../../agents/EffortPicker'
import { ProviderMark } from '../../agents/ProviderMark'
import { Field } from '../../components/Field'
import { Select } from '../../components/Select'
import './dynamicThreads.css'

/** The first window Usage has a percent for, in a few words, or nothing when it has none. */
function limitWords(quota: UsageQuotaRead | undefined): { readonly label: string; readonly used: number } | undefined {
  const window = quota?.status === 'available' ? quota.windows.find(item => item.usedPercent !== undefined) : undefined
  return window ? { label: window.label, used: Math.round(window.usedPercent!) } : undefined
}

/** How long typing in **Your note** pauses before it saves, as Custom instructions does. */
const NOTE_SAVE_DELAY_MS = 600

/**
 * Settings › Threads › Dynamic threads (ADR-0191; Owl only): the limits every Dynamic thread on this computer works inside.
 * Which providers it may use, each with its company, since that is who the code goes to, and what is left of its limits as
 * Usage reads them; then the highest effort and how many workers at once. Until the user has seen a list there is none.
 */
export function DynamicThreadsSettings({ settings, onSave }: { readonly settings: DynamicThreadSettings; readonly onSave: (patch: SettingsPatch) => unknown }): ReactNode {
  const { t } = useLingui()
  const state = useOptionalAgents()?.state
  const here = state?.connections?.find(item => item.kind === 'local')?.hostId
  const [quotas, setQuotas] = useState<readonly UsageQuotaRead[]>([])
  useEffect(() => {
    let current = true
    // A refresh rather than a read: nothing has been read until something asks, and this answers from a recent reading where a provider's read is costly.
    void window.sotto?.usage?.refresh({ background: true, ...here ? { hostIds: [here] } : {} }).then(read => { if (current) setQuotas(read.hosts[0]?.quotas ?? []) }).catch(() => undefined)
    return () => { current = false }
  }, [here])
  const connected = useMemo(() => providerIdSchema.options.filter(provider => state?.host.models.some(model => model.ready && model.providerId === provider)), [state?.host.models])
  // A press shows at once, ahead of the save that holds it. Each save sends the whole setting, built on the one before it
  // rather than on what has come back, so a quick second change can't put the first back. What was saved takes over once
  // none is on its way.
  const [draft, setDraft] = useState(settings)
  const latest = useRef(settings), saving = useRef(0), held = useRef(settings)
  held.current = settings
  useEffect(() => { if (saving.current === 0) { latest.current = settings; setDraft(settings) } }, [settings])
  // `failed` hears a save that did not land before what was saved takes over, so typed words can wait to be tried again.
  const save = (next: Partial<DynamicThreadSettings>, failed?: () => void): void => {
    const whole = { ...latest.current, ...next }
    latest.current = whole
    setDraft(whole)
    saving.current++
    void Promise.resolve(onSave({ dynamicThreads: whole })).catch(() => false).then(saved => {
      if (saved === false) failed?.()
      saving.current--
      if (saving.current === 0) { latest.current = held.current; setDraft(held.current) }
    })
  }
  // Until the user makes it, the list is only what it would start as: a limit's change leaves it unmade, so the first-use question still asks.
  const allowed = useMemo(() => new Set(draft.providers ?? (state ? firstAllowedProviders(state) : [])), [draft.providers, state])
  // The count saves when it is left or Enter is pressed, so it can be cleared on the way to a new number; anything but a whole number in range puts the saved one back.
  const [count, setCount] = useState(String(draft.workersAtOnce))
  useEffect(() => { setCount(String(draft.workersAtOnce)) }, [draft.workersAtOnce])
  const commitCount = (text: string): void => {
    const next = workersAtOnceSchema.safeParse(/^\d+$/u.test(text.trim()) ? Number(text) : Number.NaN)
    if (!next.success) { setCount(String(draft.workersAtOnce)); return }
    setCount(String(next.data))
    if (next.data !== draft.workersAtOnce) save({ workersAtOnce: next.data })
  }
  // Your note saves once typing pauses, on leaving the field and when Settings closes, so nothing typed is lost
  // mid-sentence. A saved value from elsewhere shows only while nothing typed here waits to be saved.
  const [note, setNote] = useState(draft.note ?? '')
  const pendingNote = useRef<string | null>(null)
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const saveRef = useRef(save)
  saveRef.current = save
  /** Counts the note's saves sent, so a failed older one never brings back words a newer one replaced. */
  const noteSends = useRef(0)
  const flushNote = useCallback(() => {
    if (noteTimer.current) { clearTimeout(noteTimer.current); noteTimer.current = null }
    const value = pendingNote.current
    pendingNote.current = null
    if (value === null || value === (latest.current.note ?? '')) return
    // A save that did not land keeps the words waiting for the next pause or leaving the field, but only while it is the
    // latest sent and nothing newer waits.
    const sequence = ++noteSends.current
    saveRef.current({ note: value }, () => { if (sequence === noteSends.current && pendingNote.current === null) pendingNote.current = value })
  }, [])
  useEffect(() => { if (pendingNote.current === null) setNote(draft.note ?? '') }, [draft.note])
  useEffect(() => flushNote, [flushNote])
  const noteId = useId(), noteAboutId = useId()
  const toggle = (provider: ProviderId, on: boolean): void => {
    const list = new Set(allowed)
    if (on) list.add(provider); else list.delete(provider)
    save({ providers: [...list] })
  }
  return <div className="dynamic-threads" data-setting="dynamic-threads">
    <p className="dynamic-threads__lead tt-paragraph"><Trans>A Dynamic thread's model oversees and chooses a model for each piece of work, inside these limits. Turn it on for a thread at the foot of its model menu.</Trans></p>
    <fieldset className="dynamic-threads__providers">
      <legend><Trans>What it may use</Trans></legend>
      <p className="dynamic-threads__note tt-paragraph"><Trans>Your code goes to the company behind each provider ticked here. A provider off this list is never used, even if your message names it.</Trans></p>
      {connected.map(provider => {
        const quota = quotas.find(item => item.providerId === provider), limit = limitWords(quota)
        const name = PROVIDER_LABELS[provider], company = companyWords(provider)
        const used = limit?.used, window = limit?.label
        return <label key={provider} className="dynamic-threads__provider">
          <input type="checkbox" checked={allowed.has(provider)} onChange={event => toggle(provider, event.target.checked)} />
          <ProviderMark provider={provider} name={name} size={14} />
          <span className="dynamic-threads__name">{name} <small>{company}</small></span>
          <span className="dynamic-threads__limit">{limit ? <Trans>{used}% of {window} used</Trans>
            : reportsUsageLimits(provider) ? <Trans>Not read yet</Trans> : <Trans>Reports no limits, so it would be chosen blind</Trans>}</span>
        </label>
      })}
      {connected.length === 0 ? <p className="dynamic-threads__note tt-paragraph"><Trans>No provider is connected yet.</Trans></p> : null}
    </fieldset>
    <Field label={t`Highest effort`} description={t`For any worker. Ultracode is only ever yours to choose, on your own thread.`}>
      <Select value={draft.highestEffort} onChange={event => { const next = dynamicEffortSchema.safeParse(event.target.value); if (next.success) save({ highestEffort: next.data }) }}>
        {DYNAMIC_EFFORTS.map(effort => <option key={effort} value={effort}>{effortLabel(effort)}</option>)}
      </Select>
    </Field>
    <Field label={t`Workers at once`} description={t`The overseer starts the next as one returns. Your ceiling for this computer still applies.`}>
      <input className="dynamic-threads__count tt-focusable" type="number" inputMode="numeric" min={1} max={WORKERS_AT_ONCE_MAX} step={1} value={count}
        onChange={event => setCount(event.currentTarget.value)} onBlur={event => commitCount(event.currentTarget.value)}
        onKeyDown={event => { if (event.key === 'Enter') commitCount(event.currentTarget.value) }} />
    </Field>
    <div className="dynamic-threads__your-note">
      <label htmlFor={noteId}><Trans>Your note</Trans></label>
      <p id={noteAboutId} className="dynamic-threads__note tt-paragraph"><Trans>Advice in your own words. A Dynamic thread reads it when it starts, and once more after you change it. It can be ignored, so a provider you must not use belongs off the list above.</Trans> {plural(DYNAMIC_NOTE_MAX_CHARACTERS, { one: 'Up to # character.', other: 'Up to # characters.' })}</p>
      <textarea id={noteId} data-setting="dynamic-threads-note" className="tt-input tt-focusable" rows={3} maxLength={DYNAMIC_NOTE_MAX_CHARACTERS} value={note} aria-label={t`Your note to the overseer`} aria-describedby={noteAboutId}
        placeholder={t`Sol for reviews. Save Opus for the hard debugging.`}
        onChange={event => {
          const value = event.currentTarget.value
          setNote(value)
          pendingNote.current = value
          if (noteTimer.current) clearTimeout(noteTimer.current)
          noteTimer.current = setTimeout(flushNote, NOTE_SAVE_DELAY_MS)
        }}
        onBlur={flushNote} />
    </div>
  </div>
}
