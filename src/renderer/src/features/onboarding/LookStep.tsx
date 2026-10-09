import React, { useRef, type KeyboardEvent, type ReactNode } from 'react'

import type { SottoPlatform } from '../../../../shared/platform'
import type { AppSettings, SettingsPatch } from '../../../../shared/settings'
import { themeBrand, wearsAppIcon } from '../../../../shared/themeBranding'
import { BUILT_IN_THEMES, resolveThemeFor } from '../../../../shared/themes/library'
import { SottoMark } from '../../components/SottoMark'
import { appearancePreview, resolveAppearance, useAppearancePreviewVersion, useSystemPrefersDark, type AppearanceChoice } from '../../state/appearance'

export interface LookStepProps {
  readonly settings: AppSettings
  readonly platform: SottoPlatform
  readonly onUpdateSettings: (patch: SettingsPatch) => Promise<boolean>
  readonly heading: ReactNode
}

/** Arrow keys move through a radio group and choose as they go, the way the app's segmented controls do. */
function onRadioKey(event: KeyboardEvent<HTMLElement>): void {
  const forward = event.key === 'ArrowRight' || event.key === 'ArrowDown'
  if (!forward && event.key !== 'ArrowLeft' && event.key !== 'ArrowUp') return
  const radios = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
  const index = radios.findIndex(radio => radio === document.activeElement)
  if (index < 0) return
  event.preventDefault()
  const next = radios[(index + (forward ? 1 : radios.length - 1)) % radios.length]!
  next.focus()
  next.click()
}

/**
 * Setup's look: light, dark or the system's, and one of the built-in themes for
 * both halves. A choice paints at once, as it does in Settings › Appearance, and
 * the mark in the strip follows it.
 */
export function LookStep({ settings, platform, onUpdateSettings, heading }: LookStepProps): ReactNode {
  useAppearancePreviewVersion()
  const systemDark = useSystemPrefersDark()
  const shown = appearancePreview.effective(settings)
  const resolved = resolveAppearance(shown.appearance, systemDark)
  const settingsRef = useRef(settings)
  settingsRef.current = settings

  const choose = async (patch: Partial<AppearanceChoice> & SettingsPatch): Promise<void> => {
    const sequence = appearancePreview.choose(patch)
    const saved = await onUpdateSettings(patch).catch(() => false)
    appearancePreview.settle(sequence, saved, settingsRef.current)
  }

  const system = platform === 'darwin' ? 'macOS' : platform === 'linux' ? 'Linux' : 'Windows'
  const modes = [['light', 'Light'], ['system', `Match ${system}`], ['dark', 'Dark']] as const
  const shownTheme = resolved === 'dark' ? shown.darkTheme : shown.lightTheme

  return (
    <section aria-labelledby="onboarding-heading">
      {heading}
      <div className="onboarding-look__modes" role="radiogroup" aria-label="Appearance" onKeyDown={onRadioKey}>
        {modes.map(([mode, label]) => (
          <button
            key={mode}
            type="button"
            role="radio"
            aria-checked={shown.appearance === mode}
            tabIndex={shown.appearance === mode ? 0 : -1}
            className="onboarding-look__mode tt-focusable"
            onClick={() => void choose({ appearance: mode })}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="onboarding-look__themes" role="radiogroup" aria-label="Theme" onKeyDown={onRadioKey}>
        {BUILT_IN_THEMES.map(theme => {
          const { colors } = resolveThemeFor({ lightTheme: theme.id, darkTheme: theme.id, customThemes: [] }, resolved)
          const brand = themeBrand(colors, resolved, { appIcon: wearsAppIcon(theme.id) })
          const checked = shownTheme === theme.id
          return (
            <button
              key={theme.id}
              type="button"
              role="radio"
              aria-checked={checked}
              tabIndex={checked ? 0 : -1}
              className="onboarding-look__theme tt-focusable"
              onClick={() => void choose({ lightTheme: theme.id, darkTheme: theme.id })}
            >
              <span className="onboarding-look__preview" aria-hidden="true" style={{ background: colors.canvas, borderColor: colors.border }}>
                <span className="onboarding-look__side" style={{ background: colors.sidebar }} />
                <SottoMark className="onboarding-look__mark" brand={brand} />
                <span className="onboarding-look__line" style={{ background: colors.text }} />
                <span className="onboarding-look__line onboarding-look__line--short" style={{ background: colors.mutedForeground }} />
                <span className="onboarding-look__button" style={{ background: colors.accent }} />
              </span>
              <span className="onboarding-look__name">{theme.label}</span>
            </button>
          )
        })}
      </div>
      <p className="onboarding-aside">Change it any time, or make your own theme, in Settings › Appearance.</p>
    </section>
  )
}
