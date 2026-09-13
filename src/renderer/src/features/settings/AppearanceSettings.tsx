import React, { type ReactNode } from 'react'
import { Check } from 'lucide-react'

import type { SottoPlatform } from '../../../../shared/platform'
import { ACCENTS, type Accent, type AppSettings, type Appearance, type SettingsPatch } from '../../../../shared/settings'
import { Card } from '../../components/Card'
import { Field } from '../../components/Field'
import { SegmentedControl } from '../../components/SegmentedControl'
import { appearancePreview, resolveAppearance, useAppearancePreviewVersion, useSystemPrefersDark } from '../../state/appearance'

export const ACCENT_LABELS: Readonly<Record<Accent, string>> = {
  teal: 'Teal',
  blue: 'Blue',
  violet: 'Violet',
  rose: 'Rose',
  amber: 'Amber',
  green: 'Green',
}

const MODE_OPTIONS = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
] as const satisfies ReadonlyArray<{ value: Appearance; label: string }>

export interface AppearanceSettingsProps {
  readonly settings: AppSettings
  readonly platform: SottoPlatform
  readonly onSave: (patch: SettingsPatch) => Promise<boolean>
  readonly getSettings: () => AppSettings
}

/**
 * Mode and accent for the main window. A choice becomes a pending edit that
 * App paints before the save round-trip, so the preview is immediate and
 * overlapping edits combine; a failed save leaves the setting still in force.
 */
export function AppearanceSettings({ settings, platform, onSave, getSettings }: AppearanceSettingsProps): ReactNode {
  useAppearancePreviewVersion()
  const systemDark = useSystemPrefersDark()
  const system = platform === 'darwin' ? 'macOS' : 'Windows'
  const shown = appearancePreview.effective(settings)
  const resolved = resolveAppearance(shown.appearance, systemDark)

  const choose = async (patch: Pick<SettingsPatch, 'appearance' | 'accent'>): Promise<void> => {
    const sequence = appearancePreview.choose(patch)
    const saved = await onSave(patch).catch(() => false)
    appearancePreview.settle(sequence, saved, getSettings())
  }

  return (
    <Card className="settings-section" id="settings-appearance">
      <div className="settings-section__heading">
        <h2>Appearance</h2>
        <p>{shown.appearance === 'system'
          ? <>Sotto follows {system}, <b>{resolved}</b> right now, with a <b>{ACCENT_LABELS[shown.accent].toLowerCase()}</b> accent.</>
          : <>Sotto is <b>{resolved}</b> with a <b>{ACCENT_LABELS[shown.accent].toLowerCase()}</b> accent.</>}</p>
      </div>
      <div className="settings-rows">
        <Field label="Mode" description={`System matches ${system}. The floating widget always does.`}>
          <SegmentedControl label="Mode" value={shown.appearance} options={MODE_OPTIONS} onChange={value => void choose({ appearance: value as Appearance })} />
        </Field>
        <Field label="Accent" description="Colors the dictation wave, focus rings and selections.">
          <AccentPicker value={shown.accent} onChange={accent => void choose({ accent })} />
        </Field>
      </div>
    </Card>
  )
}

function AccentPicker({ value, onChange }: { readonly value: Accent; readonly onChange: (accent: Accent) => void }): ReactNode {
  return (
    <div className="accent-picker" role="radiogroup" aria-label="Accent">
      {ACCENTS.map((accent, index) => (
        <button
          key={accent}
          type="button"
          role="radio"
          className="accent-picker__swatch"
          data-accent-swatch={accent}
          aria-checked={value === accent}
          aria-label={ACCENT_LABELS[accent]}
          title={ACCENT_LABELS[accent]}
          tabIndex={value === accent ? 0 : -1}
          onClick={() => onChange(accent)}
          onKeyDown={event => {
            const delta = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0
            if (delta === 0) return
            event.preventDefault()
            const next = (index + delta + ACCENTS.length) % ACCENTS.length
            onChange(ACCENTS[next]!)
            event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('button')[next]?.focus()
          }}
        >
          {value === accent ? <Check size={14} strokeWidth={2.75} aria-hidden="true" /> : null}
        </button>
      ))}
    </div>
  )
}
