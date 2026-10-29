import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { RotateCcw } from 'lucide-react'
import { i18n } from '@lingui/core'
import { msg, plural } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'

import type { SottoPlatform } from '../../../../shared/platform'
import type { InterfaceLanguageSetting } from '../../../../shared/interfaceLanguages'
import type { AppSettings, ReducedMotion, SettingsPatch } from '../../../../shared/settings'
import { APPEARANCE_CONTRAST, type ThemeDefinition } from '../../../../shared/themes/library'
import { Button } from '../../components/Button'
import { Card } from '../../components/Card'
import { Field } from '../../components/Field'
import { Select } from '../../components/Select'
import { platformCopy } from '../../platformCopy'
import { appearancePreview, glassPaints, resolveAppearance, useAppearancePreviewVersion, useSystemPrefersDark, type AppearanceChoice } from '../../state/appearance'
import { messageIn, useInterfaceLanguageState } from '../../state/interfaceLanguage'
import { useOwlFeature } from '../../state/owlFeature'
import { creatureShown, useLardoOffered } from '../../state/creature'
import { LanguagePicker } from './LanguagePicker'
import { shownWords, type LaterWords } from './laterWords'
import { MenuBarOwlSettings } from './MenuBarOwlSettings'
import { NightFallsSettings } from './NightFallsSettings'
import { AppearancePreview } from './themes/AppearancePreview'
import { CreatureChoice } from './themes/CreatureChoice'
import { EffortColorChoice } from './themes/EffortColor'
import { ThemeImportDialog } from './themes/ThemeImportDialog'
import { ThemeGallery, themeExportFile } from './themes/ThemeGallery'
import { WatcherSceneChoice } from './themes/WatcherSceneChoice'
import { removeThemesPatch, ThemeLibraryWriter, type LibraryPatch, type ThemeMode } from './themes/themeLibrary'
import './themes/themes.css'
import './themes/appearanceStudio.css'

export interface AppearanceSettingsProps {
  readonly settings: AppSettings
  readonly platform: SottoPlatform
  readonly onSave: (patch: SettingsPatch, successText?: LaterWords) => Promise<boolean>
  readonly getSettings: () => AppSettings
  /** Reduced motion's save, which Settings keeps: it paints the preference before the save and puts it back on failure. */
  readonly onSaveMotion?: (reducedMotion: ReducedMotion) => void
}

/** The page's width from which the cards and the preview stand side by side (appearanceStudio.css keys on the attribute this sets). */
export const STUDIO_COLUMNS_MIN_WIDTH = 760

/**
 * Whether the page is wide enough for two columns, measured on the page itself. The layout and the reading order both
 * follow it, so focus moves the way the eye does: the cards first where the preview stands beside them, the preview
 * first where it stands on top.
 */
function useTwoColumns(): [React.RefObject<HTMLDivElement | null>, boolean] {
  const ref = useRef<HTMLDivElement | null>(null)
  const [wide, setWide] = useState(false)
  useLayoutEffect(() => {
    const element = ref.current
    if (element === null) return
    const measure = (width: number): void => { if (width > 0) setWide(width >= STUDIO_COLUMNS_MIN_WIDTH) }
    measure(element.getBoundingClientRect().width)
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(entries => { const last = entries[entries.length - 1]; if (last) measure(last.contentRect.width) })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  return [ref, wide]
}

/** How long a slider waits after the last movement before it saves. */
const SLIDER_SAVE_DELAY_MS = 250

/**
 * Settings → Appearance as a studio (ADR-0011, ADR-0019): the controls in three short cards, Theme, Details and Motion,
 * beside a preview card that stays in view as the page scrolls. Every palette choice becomes a pending edit that App
 * paints before the save round-trip, so the whole window repaints at once and overlapping edits combine; a failed save
 * leaves the saved look in force. The floating widget keeps following the system.
 */
export function AppearanceSettings({ settings, platform, onSave, getSettings, onSaveMotion }: AppearanceSettingsProps): ReactNode {
  useAppearancePreviewVersion()
  const { t } = useLingui()
  const systemDark = useSystemPrefersDark()
  const menuBarOwl = useOwlFeature('menu-bar-owl') && platform === 'darwin'
  const creatureToggle = useOwlFeature('creature-toggle')
  // A creature this build holds (Lardo, outside Owl) shows and is marked as Sotto's own; the saved choice stays as it was.
  const creature = creatureShown(settings.creature, useLardoOffered())
  const interfaceLanguage = useOwlFeature('interface-language')
  const watcherOn = useOwlFeature('watcher')
  const nightFalls = useOwlFeature('night-falls') && watcherOn
  const { system: computerLanguage } = useInterfaceLanguageState()
  const copy = platformCopy(platform)
  const system = platform === 'darwin' ? 'macOS' : platform === 'linux' ? 'Linux' : 'Windows'
  const shown = appearancePreview.effective(settings)
  const resolved = resolveAppearance(shown.appearance, systemDark, shown)
  const [importing, setImporting] = useState(false)
  const [status, setStatus] = useState<{ text: LaterWords; error: boolean } | null>(null)
  const themeId = useId(), detailsId = useId(), motionId = useId()
  const [pageRef, twoColumns] = useTwoColumns()
  const getSettingsRef = useRef(getSettings)
  getSettingsRef.current = getSettings
  const onSaveRef = useRef(onSave)
  onSaveRef.current = onSave
  const writer = useMemo(() => new ThemeLibraryWriter(patch => onSaveRef.current(patch, msg`Theme saved.`), () => getSettingsRef.current()), [])

  const choose = async (patch: Partial<AppearanceChoice> & SettingsPatch, successText: LaterWords): Promise<boolean> => {
    const sequence = appearancePreview.choose(patch)
    const saved = await onSave(patch, successText).catch(() => false)
    appearancePreview.settle(sequence, saved, getSettings())
    return saved
  }

  const select = (patch: LibraryPatch): Promise<boolean> => writer.run(() => ({ patch })).then(result => {
    if (!result.saved) setStatus({ text: msg`That theme could not be saved. Your previous theme is still active.`, error: true })
    return result.saved
  }, () => {
    setStatus({ text: msg`That theme could not be saved. Your previous theme is still active.`, error: true })
    return false
  })

  const remove = async (ids: readonly string[]): Promise<boolean> => {
    const result = await writer.run(state => ({ patch: removeThemesPatch(state, ids) })).catch(() => null)
    const count = ids.length
    if (result?.saved) setStatus({ text: msg`${plural(count, { one: 'Theme removed.', other: '# themes removed.' })}`, error: false })
    return result?.saved ?? false
  }

  // The window changes language once the choice is saved, so the confirmation is written in the language chosen.
  const chooseLanguage = async (choice: InterfaceLanguageSetting): Promise<void> => {
    const saved = msg`Language saved.`
    const text = await messageIn(choice === 'system' ? computerLanguage : choice, saved).catch(() => i18n._(saved))
    await onSave({ interfaceLanguage: choice }, text).catch(() => false)
  }

  const exportTheme = async (theme: ThemeDefinition): Promise<void> => {
    const bridge = window.sotto?.themes
    if (!bridge) {
      setStatus({ text: msg`Exporting is not available in this window.`, error: true })
      return
    }
    const result = await bridge.exportTheme(themeExportFile(theme)).catch(() => null)
    const name = theme.label
    if (result === null || !result.ok) setStatus({ text: result?.error.message ?? msg`${name} could not be exported.`, error: true })
    else if (result.value.saved) setStatus({ text: msg`${name} exported.`, error: false })
  }

  const saveMotion = (reducedMotion: ReducedMotion): void => {
    if (onSaveMotion) onSaveMotion(reducedMotion)
    else void onSave({ reducedMotion }).catch(() => false)
  }

  // Where the page is narrow the preview stands above the cards, so it comes first; beside them, it comes after.
  const preview = <AppearancePreview key="preview" shown={shown} systemDark={systemDark} system={system} still={settings.reducedMotion === 'on'}
    creature={creature} showCreature={!creatureToggle || settings.showCreature} watcher={watcherOn} place={settings.watcherScene} />

  const cards = (
    <div className="appearance-studio__cards" key="cards">
      <section className="appearance-card" aria-labelledby={themeId}>
        <h3 id={themeId}>{t({ message: 'Theme', comment: 'A card on Settings > Appearance: the color scheme and the themes' })}</h3>
        <ThemeGallery
          shown={shown}
          resolved={resolved}
          system={system}
          onChooseMode={(mode: ThemeMode) => void choose({ appearance: mode }, msg`Color scheme saved.`)}
          onSelect={select}
          onRemove={remove}
          onExport={theme => void exportTheme(theme)}
          onAddTheme={() => setImporting(true)}
        />
        <p className={`tt-paragraph theme-settings__status${status?.error ? ' theme-settings__status--error' : ''}`} role="status">{shownWords(status?.text) ?? ''}</p>
      </section>

      <section className="appearance-card" aria-labelledby={detailsId}>
        <h3 id={detailsId}>{t({ message: 'Details', comment: 'A card on Settings > Appearance: effort color, creature, contrast and language' })}</h3>
        <div className="settings-rows">
          <EffortColorChoice value={shown.effortColor} onChoose={effortColor => void choose({ effortColor }, msg`Effort color saved.`)} />
          <CreatureChoice value={creature} shown={!creatureToggle || settings.showCreature} onShow={creatureToggle ? showCreature => void onSave({ showCreature }, showCreature ? msg`Creature shown.` : msg`Creature hidden.`).catch(() => false) : undefined} onChoose={creature => void onSave({ creature }, msg`Creature saved.`).catch(() => false)} />
          <WatcherSceneChoice value={settings.watcherScene} onChoose={watcherScene => onSave({ watcherScene }, msg`Watcher scene saved.`).catch(() => false)} />
          <AppearanceSlider
            label={t`Contrast`}
            resetLabel={amount => t`Reset contrast to ${amount}`}
            description={glassPaints(shown, resolved) ? t`Color and border intensity. Glass keeps text at 100% or stronger, so it stays readable over any desktop.` : t`Color and border intensity.`}
            bounds={APPEARANCE_CONTRAST}
            value={shown.appearanceContrast}
            onPreview={value => appearancePreview.choose({ appearanceContrast: value })}
            onCommit={(value, sequence) => void onSave({ appearanceContrast: value }, msg`Contrast saved.`).catch(() => false).then(saved => appearancePreview.settle(sequence, saved, getSettings()))}
          />
          {interfaceLanguage
            ? <LanguagePicker value={settings.interfaceLanguage} onChoose={choice => void chooseLanguage(choice)} />
            : null}
          {menuBarOwl ? <MenuBarOwlSettings body={settings.menuBarOwlBody} eyes={settings.menuBarOwlEyes} onChoose={(patch, text) => void onSave(patch, text).catch(() => false)} /> : null}
        </div>
      </section>

      <section className="appearance-card" aria-labelledby={motionId}>
        <h3 id={motionId}>{t({ message: 'Motion', comment: 'A card on Settings > Appearance: reduced motion and night falls' })}</h3>
        <div className="settings-rows">
          <Field setting="reduced-motion" label={t`Reduced motion`} description={copy.settingsReducedMotionDescription}>
            <Select value={settings.reducedMotion} onChange={event => saveMotion(event.currentTarget.value as ReducedMotion)}>
              <option value="system">{t`Follow system`}</option>
              <option value="on">{t`Reduce motion`}</option>
            </Select>
          </Field>
          {nightFalls ? <NightFallsSettings settings={settings} onSave={patch => onSave(patch).catch(() => false)} /> : null}
        </div>
      </section>
    </div>
  )

  return (
    <Card className="settings-section theme-settings" id="settings-appearance">
      <div className="settings-section__heading">
        <h2><Trans>Appearance</Trans></h2>
        <p className="tt-paragraph"><Trans>Theme, details &amp; motion</Trans></p>
      </div>

      <div className="appearance-studio" ref={pageRef} data-columns={twoColumns ? 'two' : 'one'}>
        {/* An array of keyed parts, so a change of layout moves the preview rather than mounting it again: its night scene
            keeps its frame. */}
        {twoColumns ? [cards, preview] : [preview, cards]}
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
function AppearanceSlider({ label, resetLabel, description, bounds, value, onPreview, onCommit }: {
  readonly label: string
  /** The reset button's name, given the default as a percentage. */
  readonly resetLabel: (amount: string) => string
  readonly description: string
  readonly bounds: SliderBounds
  readonly value: number
  readonly onPreview: (value: number) => number
  readonly onCommit: (value: number, sequence: number) => void
}): ReactNode {
  const id = useId()
  const { i18n: { locale } } = useLingui()
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
  const percentOf = (amount: number): string => new Intl.NumberFormat(locale, { style: 'percent' }).format(amount / 100)
  const defaultPercent = percentOf(bounds.default)
  return (
    <div className="tt-field theme-slider">
      <div className="theme-slider__head">
        <label className="tt-field__label" htmlFor={id}>{label}</label>
        <span className="theme-slider__value">
          {value === bounds.default
            ? null
            : (
                <Button variant="ghost" iconOnly aria-label={resetLabel(defaultPercent)} onClick={() => { change(bounds.default); flush() }}>
                  <RotateCcw size={13} aria-hidden="true" />
                </Button>
              )}
          <output htmlFor={id}>{percentOf(value)}</output>
        </span>
      </div>
      <p className="tt-field__description tt-paragraph" id={`${id}-description`}>{description}</p>
      <input
        id={id}
        data-setting="contrast"
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
