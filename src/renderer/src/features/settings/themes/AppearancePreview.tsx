import React, { useEffect, useId, useState, type CSSProperties, type ReactNode } from 'react'
import { ArrowUp, AudioLines } from 'lucide-react'
import { useLingui } from '@lingui/react/macro'

import type { Creature } from '../../../../../shared/settings'
import { themeBrand, widgetPaletteFor } from '../../../../../shared/themeBranding'
import { THEME_COLOR_ROLES, resolveThemeFor, type ThemeAppearance } from '../../../../../shared/themes/library'
import { OMARCHY_THEME_ID } from '../../../../../shared/themes/omarchy'
import { CreatureWalk } from '../../../agents/CreatureWalk'
import { SegmentedControl } from '../../../components/SegmentedControl'
import { SottoMark } from '../../../components/SottoMark'
import { resolveAppearance, themeColorVariable, type AppearanceChoice } from '../../../state/appearance'
import { useEffortArrival } from './EffortColor'
import { PreviewNightScene } from './PreviewNightScene'

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

export type PreviewRoom = 'threads' | 'watcher'
/** Which half the preview shows: the one the window is in, or either half without saving anything. */
export type PreviewHalf = 'set' | ThemeAppearance

/**
 * The Preview card on Settings → Appearance: a small passive window in the chosen theme, showing Threads or Watcher's
 * room, in the half the window is in or the other one. Showing the other half paints only this window, from that half's
 * resolved colours written to it as --theme-* roles under `data-theme-scope` (tokens.css re-derives every token there);
 * the main window is never repainted by it. The small widget beside it uses the same palette as the real widget, which
 * follows the system's mode.
 */
export function AppearancePreview({ shown, systemDark, system, still = false, creature, showCreature, watcher }: {
  readonly shown: AppearanceChoice
  readonly systemDark: boolean
  readonly system: string
  /** The app's Reduced motion setting; the preview also follows the system's. */
  readonly still?: boolean
  readonly creature: Creature
  readonly showCreature: boolean
  /** Whether Watcher's room exists here (the `watcher` Owl feature), so the preview offers it. */
  readonly watcher: boolean
}): ReactNode {
  const { t } = useLingui()
  const titleId = useId()
  const systemStill = useSystemStill()
  const [room, setRoom] = useState<PreviewRoom>('threads')
  const [half, setHalf] = useState<PreviewHalf>('set')
  const shownRoom = watcher ? room : 'threads'
  // A new color scheme is the window's to show: the preview goes back to the half the window is in.
  useEffect(() => setHalf('set'), [shown.appearance])

  const windowHalf = resolveAppearance(shown.appearance, systemDark, shown)
  const painted = half === 'set' ? windowHalf : half
  const { theme, colors } = resolveThemeFor(shown, painted)
  const scope = half === 'set' ? undefined : half
  const scoped = scope === undefined ? undefined : Object.fromEntries(THEME_COLOR_ROLES.map(role => [themeColorVariable(role), colors[role]])) as CSSProperties
  const motionless = still || systemStill
  const { arriving, run } = useEffortArrival(shown.effortColor, motionless)

  const widgetMode = resolveAppearance('system', systemDark, shown)
  const followsOmarchy = system === 'Linux' && shown.omarchyTheme &&
    (shown.omarchyTheme.appearance === 'dark' ? shown.darkTheme : shown.lightTheme) === OMARCHY_THEME_ID
  const widgetPalette = widgetPaletteFor(shown)
  const widgetColors = widgetPalette[widgetMode]
  const widgetBrand = themeBrand(widgetColors, widgetMode, { appIcon: widgetPalette.appIcon[widgetMode] })

  const name = theme.label
  const threads = t({ message: 'Threads', comment: 'A room of the main window, shown in the Appearance preview' })
  const watcherRoom = 'Watcher'
  const halfName = painted === 'light'
    ? t({ message: 'light', comment: 'The light color scheme, inside a sentence: "Threads in Sotto, light"' })
    : t({ message: 'dark', comment: 'The dark color scheme, inside a sentence: "Threads in Sotto, dark"' })
  const roomName = shownRoom === 'threads' ? threads : watcherRoom

  return (
    <aside className="appearance-preview" aria-labelledby={titleId}>
      <div className="appearance-preview__head">
        <h3 id={titleId}>{t({ message: 'Preview', comment: 'The card on Settings > Appearance that shows a small window in the chosen theme' })}</h3>
        <div className="appearance-preview__switches">
          {watcher
            ? <SegmentedControl label={t`Room the preview shows`} value={shownRoom} onChange={value => setRoom(value as PreviewRoom)}
                options={[{ value: 'threads', label: threads }, { value: 'watcher', label: watcherRoom }]} />
            : null}
          <SegmentedControl label={t`Color scheme the preview shows`} value={half} onChange={value => setHalf(value as PreviewHalf)}
            options={[
              { value: 'set', label: t({ message: 'As set', comment: 'Shows the preview in the color scheme the window is in now' }) },
              { value: 'light', label: t({ message: 'Light', comment: 'The light color scheme, or the themes that paint it' }) },
              { value: 'dark', label: t({ message: 'Dark', comment: 'The dark color scheme, or the themes that paint it' }) },
            ]} />
        </div>
      </div>

      <div className="appearance-preview__window" role="img" aria-label={t`${roomName} in ${name}, ${halfName}`}
        data-room={shownRoom} data-theme-scope={scope} data-effort-color={scope === undefined ? undefined : shown.effortColor} style={scoped}>
        <div className="studio-window" aria-hidden="true">
          <div className="studio-window__strip">
            <SottoMark className="appearance-preview__app-icon" />
            <strong>Sotto</strong>
            <span className="studio-window__rooms">
              <span>{t({ message: 'Dictate', comment: 'The Dictate room, named in the title bar' })}</span>
              {watcher ? <span data-on={shownRoom === 'watcher' || undefined}>{watcherRoom}</span> : null}
              <span data-on={shownRoom === 'threads' || undefined}>{threads}</span>
            </span>
          </div>
          {shownRoom === 'threads'
            ? <ThreadsSample creature={creature} showCreature={showCreature} arriving={arriving} run={run} />
            : <WatcherSample arriving={arriving} run={run} paint={`${painted}:${theme.id}:${JSON.stringify(colors.canvas)}:${shown.appearanceContrast}:${scope ?? ''}`} />}
        </div>
      </div>

      <div className="appearance-preview__widget">
        <div className="appearance-preview__widget-sample" data-widget-mode={widgetMode} aria-hidden="true" style={{ backgroundColor: widgetColors.surfaceRaised, color: widgetColors.text, borderColor: widgetColors.mutedForeground }}>
          <AudioLines size={15} style={{ color: widgetBrand.tile }} aria-hidden="true" /><strong>{t({ message: 'Ready', comment: 'The floating widget, waiting to dictate' })}</strong>
        </div>
        <p className="tt-paragraph">{followsOmarchy ? t`The widget follows the Omarchy theme’s mode.` : t`The widget follows ${system} light or dark mode.`}</p>
      </div>
    </aside>
  )
}

/** The composer's chips: the model, the effort at its highest level in the chosen colourway, and the permission. */
function Chips({ run }: { readonly run: number }): ReactNode {
  const { t } = useLingui()
  // The words are the composer's own.
  const max = t({ message: 'Max', comment: 'The highest reasoning effort level, as the effort card names it' })
  const letters = Array.from(max, (letter, index) => <span key={index} style={{ '--effort-letter': index } as CSSProperties}>{letter}</span>)
  return (
    <div className="studio-composer__chips">
      <span>{t({ message: 'Model', comment: 'A composer chip standing for the model' })}</span>
      <span className="studio-composer__word" key={run}>{letters}</span>
      <span>{t({ message: 'Auto', comment: 'A composer chip: the Auto permission' })}</span>
      <i className="studio-composer__send"><ArrowUp size={11} strokeWidth={2.6} /></i>
    </div>
  )
}

/** The composer: a fill one step off the room with no edge, and the effort's arrival washing up through it. */
function Composer({ placeholder, arriving, run, className = '' }: { readonly placeholder: string; readonly arriving: boolean; readonly run: number; readonly className?: string }): ReactNode {
  return (
    <div className={`studio-composer ${className}`.trim()} data-arriving={arriving || undefined}>
      <div className="studio-composer__wash" key={run} />
      <span className="studio-composer__placeholder">{placeholder}</span>
      <Chips run={run} />
    </div>
  )
}

function ThreadsSample({ creature, showCreature, arriving, run }: { readonly creature: Creature; readonly showCreature: boolean; readonly arriving: boolean; readonly run: number }): ReactNode {
  const { t } = useLingui()
  const selected = t({ message: 'Shorten the settings page', comment: 'A sample thread title in the Appearance preview' })
  return (
    <div className="studio-threads">
      <div className="studio-threads__sidebar">
        <span className="studio-threads__search">{t`Search threads`}</span>
        <span className="studio-threads__project">sotto</span>
        <span className="studio-threads__row" data-selected="true"><i data-status="working" /><b>{selected}</b></span>
        <span className="studio-threads__row"><i data-status="waiting" /><b>{t({ message: 'Fix the login test', comment: 'A sample thread title in the Appearance preview' })}</b></span>
        <span className="studio-threads__row"><i /><b>{t({ message: 'Update the guide', comment: 'A sample thread title in the Appearance preview' })}</b></span>
      </div>
      <div className="studio-threads__main">
        <div className="studio-threads__head"><b>{selected}</b></div>
        <div className="studio-threads__transcript">
          <p className="studio-bubble">{t({ message: 'Can you make the settings page shorter?', comment: 'A sample message from the user in the Appearance preview' })}</p>
          <p className="studio-reply">{t({ message: 'Yes. The controls now sit in three short cards, beside a preview.', comment: 'A sample reply from a thread in the Appearance preview' })}</p>
          <code className="studio-code"><i>+</i>{' <ThemeTiles />'}</code>
        </div>
        {showCreature ? <div className="studio-threads__creature"><CreatureWalk creature={creature} /></div> : null}
        <Composer placeholder={t`What would you like to do next?`} arriving={arriving} run={run} />
      </div>
    </div>
  )
}

function WatcherSample({ arriving, run, paint }: { readonly arriving: boolean; readonly run: number; readonly paint: string }): ReactNode {
  const { t } = useLingui()
  return (
    <div className="studio-watcher">
      <PreviewNightScene paint={paint} />
      <div className="studio-watcher__head">
        <b>Watcher</b>
        <span data-on="true">{t({ message: 'Conversation', comment: 'The tab that shows Watcher’s own conversation' })}</span>
        <span>{t({ message: 'Watched', comment: 'The tab that lists the threads Watcher watches, in the Appearance preview' })}</span>
      </div>
      <div className="studio-watcher__column">
        <p className="studio-bubble">{t({ message: 'How are my threads doing?', comment: 'A sample message to Watcher in the Appearance preview' })}</p>
        <p className="studio-reply">{t({ message: 'Fix the login test is waiting on you. The other two are working.', comment: 'A sample reply from Watcher in the Appearance preview' })}</p>
      </div>
      <Composer className="studio-watcher__composer" placeholder={t`Ask about your threads, or say what to start or send`} arriving={arriving} run={run} />
    </div>
  )
}
