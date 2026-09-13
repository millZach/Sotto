import React, { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { RotateCcw } from 'lucide-react'

import type { SottoPlatform } from '../../../../shared/platform'
import type { AppSettings, SettingsPatch } from '../../../../shared/settings'
import { APPEARANCE_CONTRAST, GLASS_OPACITY, type ThemeDefinition } from '../../../../shared/themes/library'
import { Button } from '../../components/Button'
import { Card } from '../../components/Card'
import { appearancePreview, resolveAppearance, useAppearancePreviewVersion, useSystemPrefersDark, type AppearanceChoice } from '../../state/appearance'
import { ThemeImportDialog } from './themes/ThemeImportDialog'
import { ThemeGallery, themeExportFile } from './themes/ThemeGallery'
import { removeThemesPatch, ThemeLibraryWriter, type LibraryPatch, type ThemeMode } from './themes/themeLibrary'
import './themes/themes.css'

export interface AppearanceSettingsProps {
  readonly settings: AppSettings
  readonly platform: SottoPlatform
  readonly onSave: (patch: SettingsPatch, successText?: string) => Promise<boolean>
  readonly getSettings: () => AppSettings
}

/** How long a slider waits after the last movement before it saves. */
export const SLIDER_SAVE_DELAY_MS = 250

/**
 * The main window's colour scheme, themes, contrast and glass (ADR-0011). Every
 * choice becomes a pending edit that App paints before the save round-trip, so
 * the preview is immediate and overlapping edits combine; a failed save leaves
 * the saved look in force. The floating widget keeps following the system.
 */
export function AppearanceSettings({ settings, platform, onSave, getSettings }: AppearanceSettingsProps): ReactNode {
  useAppearancePreviewVersion()
  const systemDark = useSystemPrefersDark()
  const system = platform === 'darwin' ? 'macOS' : 'Windows'
  const shown = appearancePreview.effective(settings)
  const resolved = resolveAppearance(shown.appearance, systemDark)
  const [importing, setImporting] = useState(false)
  const [status, setStatus] = useState<{ text: string; error: boolean } | null>(null)
  const getSettingsRef = useRef(getSettings)
  getSettingsRef.current = getSettings
  const onSaveRef = useRef(onSave)
  onSaveRef.current = onSave
  const writer = useMemo(() => new ThemeLibraryWriter(patch => onSaveRef.current(patch, 'Theme saved.'), () => getSettingsRef.current()), [])

  const choose = async (patch: Partial<AppearanceChoice> & SettingsPatch, successText: string): Promise<boolean> => {
    const sequence = appearancePreview.choose(patch)
    const saved = await onSave(patch, successText).catch(() => false)
    appearancePreview.settle(sequence, saved, getSettings())
    return saved
  }

  const select = (patch: LibraryPatch): void => {
    void writer.run(() => ({ patch })).then(result => {
      if (!result.saved) setStatus({ text: 'That theme could not be saved. Your previous theme is still active.', error: true })
    })
  }

  const remove = async (ids: readonly string[]): Promise<boolean> => {
    const result = await writer.run(state => ({ patch: removeThemesPatch(state, ids) })).catch(() => null)
    if (result?.saved) setStatus({ text: ids.length === 1 ? 'Theme removed.' : `${ids.length} themes removed.`, error: false })
    return result?.saved ?? false
  }

  const exportTheme = async (theme: ThemeDefinition): Promise<void> => {
    const bridge = window.sotto?.themes
    if (!bridge) {
      setStatus({ text: 'Exporting is not available in this window.', error: true })
      return
    }
    const result = await bridge.exportTheme(themeExportFile(theme)).catch(() => null)
    if (result === null || !result.ok) setStatus({ text: result?.error.message ?? `${theme.label} could not be exported.`, error: true })
    else if (result.value.saved) setStatus({ text: `${theme.label} exported.`, error: false })
  }

  return (
    <Card className="settings-section theme-settings" id="settings-appearance">
      <div className="settings-section__heading">
        <h2>Appearance</h2>
        <p>Choose light, dark or system, then a theme for each. The floating widget always follows the {system} light or dark setting.</p>
      </div>

      <ThemeGallery
        shown={shown}
        resolved={resolved}
        onChooseMode={(mode: ThemeMode) => void choose({ appearance: mode }, 'Color scheme saved.')}
        onSelect={select}
        onRemove={remove}
        onExport={theme => void exportTheme(theme)}
        onAddTheme={() => setImporting(true)}
      />
      <p className={`theme-settings__status${status?.error ? ' theme-settings__status--error' : ''}`} role="status">{status?.text ?? ''}</p>

      <h3 className="theme-settings__subheading">Interface</h3>
      <div className="settings-rows">
        <AppearanceSlider
          label="Contrast"
          description="Adjust the contrast of colors and borders across the interface."
          bounds={APPEARANCE_CONTRAST}
          value={shown.appearanceContrast}
          onPreview={value => appearancePreview.choose({ appearanceContrast: value })}
          onCommit={(value, sequence) => void onSave({ appearanceContrast: value }, 'Contrast saved.').catch(() => false).then(saved => appearancePreview.settle(sequence, saved, getSettings()))}
        />
        <AppearanceSlider
          label="Glass opacity"
          description="Higher values make menus, dialogs, and the composer more solid."
          bounds={GLASS_OPACITY}
          value={shown.glassOpacity}
          onPreview={value => appearancePreview.choose({ glassOpacity: value })}
          onCommit={(value, sequence) => void onSave({ glassOpacity: value }, 'Glass opacity saved.').catch(() => false).then(saved => appearancePreview.settle(sequence, saved, getSettings()))}
        />
      </div>

      {importing
        ? <ThemeImportDialog writer={writer} onClose={() => setImporting(false)} onNotice={text => setStatus({ text, error: false })} />
        : null}
    </Card>
  )
}

interface SliderBounds { readonly min: number; readonly max: number; readonly step: number; readonly default: number }

/**
 * A range that paints on every step and saves once the hand settles: the save
 * waits for a pause, and releasing the pointer, leaving the control or closing
 * the page flushes it straight away. Only the newest sequence is saved.
 */
function AppearanceSlider({ label, description, bounds, value, onPreview, onCommit }: {
  readonly label: string
  readonly description: string
  readonly bounds: SliderBounds
  readonly value: number
  readonly onPreview: (value: number) => number
  readonly onCommit: (value: number, sequence: number) => void
}): ReactNode {
  const id = useId()
  const pending = useRef<{ value: number; sequence: number } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const commitRef = useRef(onCommit)
  commitRef.current = onCommit

  const flush = (): void => {
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = null
    const next = pending.current
    pending.current = null
    if (next) commitRef.current(next.value, next.sequence)
  }
  const flushRef = useRef(flush)
  flushRef.current = flush
  useEffect(() => () => flushRef.current(), [])

  const change = (raw: number): void => {
    const next = Math.min(bounds.max, Math.max(bounds.min, Math.round(raw / bounds.step) * bounds.step))
    if (!Number.isFinite(next)) return
    pending.current = { value: next, sequence: onPreview(next) }
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = setTimeout(flush, SLIDER_SAVE_DELAY_MS)
  }

  const percent = ((value - bounds.min) / (bounds.max - bounds.min)) * 100
  return (
    <div className="tt-field theme-slider">
      <div className="theme-slider__head">
        <label className="tt-field__label" htmlFor={id}>{label}</label>
        <span className="theme-slider__value">
          {value === bounds.default
            ? null
            : (
                <Button variant="ghost" iconOnly aria-label={`Reset ${label.toLowerCase()} to ${bounds.default}%`} onClick={() => { change(bounds.default); flush() }}>
                  <RotateCcw size={13} aria-hidden="true" />
                </Button>
              )}
          <output htmlFor={id}>{value}%</output>
        </span>
      </div>
      <p className="tt-field__description" id={`${id}-description`}>{description}</p>
      <input
        id={id}
        className="theme-slider__input tt-focusable"
        type="range"
        min={bounds.min}
        max={bounds.max}
        step={bounds.step}
        value={value}
        aria-describedby={`${id}-description`}
        style={{ '--theme-slider-fill': `${percent}%` } as React.CSSProperties}
        onChange={event => change(Number(event.currentTarget.value))}
        onPointerUp={flush}
        onKeyUp={flush}
        onBlur={flush}
      />
    </div>
  )
}
