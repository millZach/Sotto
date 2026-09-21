import React, { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { AudioLines, Eye } from 'lucide-react'

import { themeBrand, widgetPaletteFor } from '../../../../../shared/themeBranding'
import { SottoMark } from '../../../components/SottoMark'
import { useThemeBrand } from '../../../components/useThemeBrand'
import type { AppearanceChoice } from '../../../state/appearance'
import { EffortColorSample } from './EffortColor'

/** Whether the operating system asks for reduced motion, updated live; the app's own setting is passed in beside it. */
function useSystemStill(): boolean {
  const [still, setStill] = useState(() => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false)
  useEffect(() => {
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    if (!media) return
    const update = (): void => setStill(media.matches)
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  return still
}

/** A passive appearance sample. Its widget uses the same palette projection as the real OS-following widget. */
export function ThemeLivePreview({ shown, systemDark, system, still = false }: {
  readonly shown: AppearanceChoice
  readonly systemDark: boolean
  readonly system: string
  /** The app's Reduced motion setting; the sample also follows the system's. */
  readonly still?: boolean
}): ReactNode {
  const brand = useThemeBrand()
  const systemStill = useSystemStill()
  const widgetMode = systemDark ? 'dark' : 'light'
  const widgetColors = widgetPaletteFor(shown)[widgetMode]
  const widgetBrand = themeBrand(widgetColors, widgetMode)
  return (
    <aside className="theme-live-preview" aria-label="Appearance preview">
      <h3><Eye size={14} aria-hidden="true" />Live appearance</h3>
      <div className="theme-live-preview__window">
        <div className="theme-live-preview__titlebar"><SottoMark /><strong>Sotto</strong><span>Dictate</span></div>
        <div className="theme-live-preview__body">
          <div className="theme-live-preview__orb" style={{ '--preview-orb-light': brand.orb[0], '--preview-orb-dark': brand.orb[1] } as CSSProperties} aria-hidden="true" />
          <strong>Ready when you are</strong>
          <div className="theme-live-preview__composer" aria-hidden="true"><AudioLines size={18} /><span /><span /></div>
        </div>
      </div>
      <div className="theme-live-preview__parts">
        <div><SottoMark className="theme-live-preview__app-icon" /><span>App icon</span></div>
        <div>
          <div className="theme-live-preview__widget" data-widget-mode={widgetMode} style={{ backgroundColor: widgetColors.surfaceRaised, color: widgetColors.text, borderColor: widgetColors.mutedForeground }}>
            <AudioLines size={18} style={{ color: widgetBrand.tile }} aria-hidden="true" /><strong>Ready</strong>
          </div>
          <span>Floating widget</span>
        </div>
      </div>
      <EffortColorSample effortColor={shown.effortColor} still={still || systemStill} />
      <p>The widget follows {system} light or dark mode.</p>
    </aside>
  )
}
