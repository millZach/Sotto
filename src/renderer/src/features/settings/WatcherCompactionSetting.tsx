import React, { useEffect, useId, useState, type ReactNode } from 'react'
import { useLingui } from '@lingui/react/macro'
import { WATCHER_COMPACT_AT, type SettingsPatch } from '../../../../shared/settings'
import { formatTokenCount } from '../../../../shared/threadUsage'
import { useWatcherRoom } from '../../watcher/watcherRoom'
import './watcherCompaction.css'

/**
 * A token count as the interface language writes it. English keeps "400k" and "1M", as Watcher's room shows its point;
 * another language writes the compact form it uses (ADR-0123).
 */
export function tokensIn(tokens: number, locale: string): string {
  return locale === 'en' ? formatTokenCount(tokens) : new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(tokens)
}

/** Where a point sits along the dial, from 0 at 200k to 1 at 1M; Watcher's size past either end stops at it. */
function along(tokens: number): number {
  return Math.min(1, Math.max(0, (tokens - WATCHER_COMPACT_AT.min) / (WATCHER_COMPACT_AT.max - WATCHER_COMPACT_AT.min)))
}

/**
 * Compact Watcher at (Zach's pick C, October 24, 2026, tag `prototype/watcher-compaction-target`): a bar that is Watcher's
 * conversation as it is now, and a line on it, the point past which Watcher compacts, that is dragged or moved with the
 * arrow keys. Underneath is a range input, so the keyboard and screen readers have the slider they expect. It saves when
 * it is let go, as Night falls speed does.
 */
export function WatcherCompactionDial({ value, tokens, onSave }: {
  readonly value: number
  /** Watcher's conversation in tokens as its provider last reported it, or null before a reading or without Watcher. */
  readonly tokens: number | null
  readonly onSave: (patch: SettingsPatch) => unknown
}): ReactNode {
  const { t, i18n } = useLingui()
  const id = useId()
  const [point, setPoint] = useState(value)
  useEffect(() => setPoint(value), [value])
  // A save that fails or is refused leaves the point in force where it was, so the dial goes back to it.
  const commit = (): void => {
    if (point === value) return
    void Promise.resolve(onSave({ watcherCompactAtTokens: point })).catch(() => false).then(saved => { if (saved === false) setPoint(value) })
  }
  const shown = tokensIn(point, i18n.locale), size = tokens === null ? null : tokensIn(tokens, i18n.locale)
  const past = tokens !== null && tokens > point
  const low = tokensIn(WATCHER_COMPACT_AT.min, i18n.locale), high = tokensIn(WATCHER_COMPACT_AT.max, i18n.locale)
  const range = t({ message: `${low} to ${high}`, comment: 'The ends of the Compact Watcher at slider, such as 200k to 1M' })
  return <div className="tt-field watcher-compaction">
    <label className="tt-field__label" htmlFor={id}>{t`Compact Watcher at`}</label>
    <p className="tt-field__description tt-paragraph" id={`${id}-description`}>
      {t`Watcher compacts its conversation at its next rest once it passes this size. Lower costs less on every turn; higher keeps more of it word for word.`}
    </p>
    {/* The window keeps its left-to-right layout in every language (ADR-0123), and so does the dial. */}
    <div className="watcher-compaction__dial" dir="ltr" style={{ '--watcher-compaction-at': along(point), '--watcher-compaction-size': along(tokens ?? 0) } as React.CSSProperties}>
      <div className="watcher-compaction__bar" aria-hidden="true">{tokens === null || tokens <= WATCHER_COMPACT_AT.min ? null : <div className="watcher-compaction__size" data-past={past ? 'true' : undefined} />}</div>
      <div className="watcher-compaction__line" aria-hidden="true" />
      <output className="watcher-compaction__flag" htmlFor={id}>{shown}</output>
      <input id={id} data-setting="watcher-compact-at" className="watcher-compaction__input" type="range"
        min={WATCHER_COMPACT_AT.min} max={WATCHER_COMPACT_AT.max} step={WATCHER_COMPACT_AT.step} value={point}
        aria-describedby={`${id}-description ${id}-now`} aria-valuetext={t`${shown} tokens`}
        onChange={event => { const next = Number(event.currentTarget.value); if (Number.isFinite(next)) setPoint(next) }}
        onPointerUp={commit} onKeyUp={commit} onBlur={commit} />
    </div>
    <p className="watcher-compaction__foot" id={`${id}-now`}>
      <span className="tt-paragraph">{size === null ? null : past ? t`Watcher is at ${size}: it compacts at its next rest.` : t`Watcher is at ${size}.`}</span>
      <span className="watcher-compaction__range">{range}</span>
    </p>
  </div>
}

/** The dial in Settings, Watcher, with Watcher's conversation read from its room as the room last showed it. */
export function WatcherCompactionSetting({ value, onSave }: { readonly value: number; readonly onSave: (patch: SettingsPatch) => unknown }): ReactNode {
  const room = useWatcherRoom()
  return <WatcherCompactionDial value={value} tokens={room?.state?.context?.tokens ?? null} onSave={onSave} />
}
