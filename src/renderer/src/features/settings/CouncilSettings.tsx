import React, { useEffect, useState, type ReactNode } from 'react'
import { Clock, LayoutGrid, Users } from 'lucide-react'
import { useLingui } from '@lingui/react/macro'
import { COUNCIL_STAGE_DEADLINE, type CouncilLayout } from '../../../../shared/council'
import type { AppSettings, SettingsPatch } from '../../../../shared/settings'
import { useOptionalAgents } from '../../agents/AgentContext'
import { newThreadDefaultsCatalog } from '../../agents/newThread'
import { Field } from '../../components/Field'
import { SegmentedControl } from '../../components/SegmentedControl'
import { CouncilSeats } from '../council/CouncilSeats'
import { SettingsGroup } from './SettingsGroup'

/**
 * Settings → Council (ADR-0176 decision 7), directly below Watcher and there only while the Owl feature `council` is on:
 * who sits on a Council, how its chamber is laid out, and how long a stage waits for a thread. The Ask screen starts
 * from these and can change any seat for one Council.
 */
export function CouncilSettings({ settings, onUpdateSettings }: {
  readonly settings: AppSettings
  readonly onUpdateSettings: (patch: SettingsPatch) => Promise<boolean>
}): ReactNode {
  const { t } = useLingui()
  const agents = useOptionalAgents()
  const chosen = settings.councilPanelists.some(seat => seat !== null) || settings.councilChair !== null
  const layouts: { value: CouncilLayout; label: string }[] = [
    { value: 'long-table', label: t({ message: 'Long table', comment: 'A Council chamber layout: the panelists in a row behind a table, the chair at its centre.' }) },
    { value: 'half-circle', label: t({ message: 'Half circle', comment: 'A Council chamber layout: tiered seats round an altar, the chair at the back.' }) },
    { value: 'round-table', label: t({ message: 'Round table', comment: 'A Council chamber layout: seen from a little above, the chair at the far side.' }) },
  ]
  return <>
    <SettingsGroup title={t`Panel`} icon={Users} rows={false} setting="council-panel"
      note={t`Sotto fills an empty seat with the strongest model of each connected provider in turn, and the chair with one more. Each panelist’s effort is used for its answer, review and crux check, and the chair’s for its framing and verdict.`}>
      {agents?.state ? <CouncilSeats catalog={newThreadDefaultsCatalog(agents.state)} panel={{ panelists: settings.councilPanelists, chair: settings.councilChair }}
        onChange={panel => void onUpdateSettings({ councilPanelists: [...panel.panelists], councilChair: panel.chair })} />
        : <p className="council-seats__note tt-paragraph">{t`Preparing the panel…`}</p>}
      {chosen ? <button type="button" className="council-link tt-focusable" onClick={() => void onUpdateSettings({ councilPanelists: settings.councilPanelists.map(() => null), councilChair: null })}>
        {t`Reset seats to Sotto’s choice`}</button> : null}
    </SettingsGroup>
    <SettingsGroup title={t`Layout`} icon={LayoutGrid} setting="council-layout">
      <SegmentedControl label={t`How the Council’s chamber is laid out`} value={settings.councilLayout} options={layouts}
        onChange={value => void onUpdateSettings({ councilLayout: value as CouncilLayout })} />
    </SettingsGroup>
    <SettingsGroup title={t`Stage deadline`} icon={Clock}>
      <DeadlineField value={settings.councilStageDeadline} onSave={minutes => onUpdateSettings({ councilStageDeadline: minutes })} />
    </SettingsGroup>
  </>
}

/** Minutes a stage waits for a thread, saved when it is left or Enter is pressed; anything off the range changes nothing. */
function DeadlineField({ value, onSave }: { readonly value: number; readonly onSave: (minutes: number) => Promise<boolean> }): ReactNode {
  const { t } = useLingui()
  const [draft, setDraft] = useState(String(value))
  const [error, setError] = useState(false)
  useEffect(() => setDraft(String(value)), [value])
  const commit = (): void => {
    const minutes = /^\d+$/u.test(draft.trim()) ? Number(draft.trim()) : Number.NaN
    const valid = Number.isInteger(minutes) && minutes >= COUNCIL_STAGE_DEADLINE.min && minutes <= COUNCIL_STAGE_DEADLINE.max
    setError(!valid)
    if (!valid || minutes === value) return
    void onSave(minutes).then(saved => { if (!saved) setDraft(String(value)) })
  }
  const min = COUNCIL_STAGE_DEADLINE.min, max = COUNCIL_STAGE_DEADLINE.max
  return <Field label={t`Minutes`} setting="council-deadline"
    description={t`How long a stage waits for a thread before its row offers Retry, Use another model and Go on without it. Nothing is left out on its own.`}
    {...error ? { error: t`Enter a whole number of minutes from ${min} to ${max}. Nothing was changed.` } : {}}>
    <input className="tt-input" inputMode="numeric" value={draft} autoComplete="off"
      onChange={event => { setDraft(event.currentTarget.value); setError(false) }} onBlur={commit} onKeyDown={event => { if (event.key === 'Enter') commit() }} />
  </Field>
}
