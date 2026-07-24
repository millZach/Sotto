import React, { useMemo, useState, type ReactNode } from 'react'
import { ArrowRight, Mic, Square } from 'lucide-react'

import type { ModelStatus } from '../../../../shared/contracts'
import type { DictationState } from '../../../../shared/dictation'
import type { HistoryEntry } from '../../../../shared/history'
import type { AppSettings } from '../../../../shared/settings'
import { Button } from '../../components/Button'
import { Card } from '../../components/Card'
import { LevelMeter } from '../../components/LevelMeter'
import { ShortcutKey } from '../../components/ShortcutKey'
import type { HistoryStatus } from '../../state/AppContext'
import { computeWeeklyStats } from './weeklyStats'

export interface HomeViewProps {
  readonly settings: AppSettings
  readonly dictation: DictationState
  readonly modelStatus?: ModelStatus | undefined
  readonly entries: readonly HistoryEntry[]
  readonly historyStatus: HistoryStatus
  readonly onStart: () => Promise<void>
  readonly onStop: () => Promise<void>
  readonly onOpenHistory: () => void
  readonly onOpenSettings: () => void
}

function isModelReady(status: ModelStatus | undefined): boolean {
  return status?.state === 'bundled' || status?.state === 'ready'
}

function finiteError(code: string): string {
  switch (code) {
    case 'MIC_PERMISSION_DENIED': return 'Microphone access is off. Check Windows privacy settings, then try again.'
    case 'MIC_DEVICE_NOT_FOUND': return 'The selected microphone is unavailable. Choose another microphone in Settings.'
    case 'NO_SPEECH': return 'No speech was detected. Try again a little closer to the microphone.'
    case 'OUTPUT_FAILED':
    case 'OUTPUT_UNAVAILABLE': return 'Your text could not be delivered. Try again, then paste from the clipboard manually.'
    default: return 'Sotto could not transcribe that recording. Try again or choose a smaller model in Settings.'
  }
}

function statusCopy(state: DictationState): { label: string; detail: string; tone: 'normal' | 'error' | 'success' } {
  switch (state.status) {
    case 'requesting-permission': return { label: 'Connecting to your microphone', detail: 'Windows may ask for access.', tone: 'normal' }
    case 'listening': return { label: 'Listening', detail: 'Speak naturally, then stop when you are finished.', tone: 'normal' }
    case 'processing': return { label: 'Turning speech into text', detail: 'Everything is processing locally.', tone: 'normal' }
    case 'success': return { label: state.output === 'pasted' ? 'Text pasted' : 'Text copied', detail: 'Your recording is complete.', tone: 'success' }
    case 'cancelled': return { label: 'Recording cancelled', detail: 'Nothing was copied or saved.', tone: 'normal' }
    case 'error': return { label: 'Dictation needs attention', detail: finiteError(state.code), tone: 'error' }
    default: return { label: 'Ready when you are', detail: 'Start here or use your shortcut in any application.', tone: 'normal' }
  }
}

const SPARKLINE_WIDTH = 96
const SPARKLINE_HEIGHT = 28
const SPARKLINE_PAD = 2

function sparklinePoints(values: readonly number[]): string {
  const max = Math.max(...values, 1)
  const innerWidth = SPARKLINE_WIDTH - SPARKLINE_PAD * 2
  const innerHeight = SPARKLINE_HEIGHT - SPARKLINE_PAD * 2
  const step = values.length > 1 ? innerWidth / (values.length - 1) : 0
  return values
    .map((value, index) => {
      const x = SPARKLINE_PAD + index * step
      const y = SPARKLINE_HEIGHT - SPARKLINE_PAD - (value / max) * innerHeight
      return `${Math.round(x * 100) / 100},${Math.round(y * 100) / 100}`
    })
    .join(' ')
}

function Sparkline({ values }: { readonly values: readonly number[] }): ReactNode {
  return (
    <svg
      className="home-stat__sparkline"
      viewBox={`0 0 ${SPARKLINE_WIDTH} ${SPARKLINE_HEIGHT}`}
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
    >
      <polyline
        points={sparklinePoints(values)}
        fill="none"
        stroke="var(--tt-primary)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

interface StatTileProps {
  readonly label: string
  readonly value: number
  readonly sparkline?: readonly number[] | undefined
}

function StatTile({ label, value, sparkline }: StatTileProps): ReactNode {
  return (
    <Card className="home-stat">
      <p className="home-stat__label">{label}</p>
      <p className="home-stat__value tt-tabular">{value}</p>
      <p className="home-stat__note">this week</p>
      {sparkline === undefined ? null : <Sparkline values={sparkline} />}
    </Card>
  )
}

export function HomeView({
  settings,
  dictation,
  modelStatus,
  entries,
  historyStatus,
  onStart,
  onStop,
  onOpenHistory,
  onOpenSettings,
}: HomeViewProps): ReactNode {
  const [submitting, setSubmitting] = useState(false)
  const modelReady = isModelReady(modelStatus)
  const copy = statusCopy(dictation)
  const stats = useMemo(() => computeWeeklyStats(entries, Date.now()), [entries])
  const recent = useMemo(
    () => [...entries].sort((first, second) => second.createdAt - first.createdAt).slice(0, 3),
    [entries],
  )
  const active = dictation.status === 'requesting-permission' || dictation.status === 'listening' || dictation.status === 'processing'

  const invoke = async (operation: () => Promise<void>): Promise<void> => {
    if (submitting) return
    setSubmitting(true)
    try { await operation() } finally { setSubmitting(false) }
  }

  let actionLabel = 'Start dictation'
  let actionDisabled = submitting || !modelReady
  let action = onStart
  if (!modelReady) actionLabel = 'Model required'
  if (dictation.status === 'requesting-permission') {
    actionLabel = 'Connecting...'
    actionDisabled = true
  }
  if (dictation.status === 'listening') {
    actionLabel = 'Stop and transcribe'
    actionDisabled = submitting
    action = onStop
  }
  if (dictation.status === 'processing') {
    actionLabel = 'Transcribing...'
    actionDisabled = true
  }

  return (
    <div className="management-view home-view">
      <h1 className="tt-visually-hidden">Home</h1>

      <div className="home-stats">
        <StatTile label="Words" value={stats.words} sparkline={stats.dailyWords} />
        <StatTile label="Avg WPM" value={stats.avgWpm} />
        <StatTile label="Minutes dictated" value={stats.minutes} sparkline={stats.dailyMinutes} />
      </div>

      <Card className="home-dictation-bar" data-active={active} data-tone={copy.tone}>
        <div className="home-dictation-bar__icon" aria-hidden="true">{dictation.status === 'listening' ? <Square /> : <Mic />}</div>
        <div className="home-dictation-bar__copy" role={copy.tone === 'error' ? 'alert' : 'status'} aria-live={copy.tone === 'error' ? 'assertive' : 'polite'}>
          <h2>{copy.label}</h2>
          <p>{copy.detail}</p>
        </div>
        {dictation.status === 'listening' ? <LevelMeter value={dictation.level} label="Microphone activity" /> : null}
        <div className="home-dictation-bar__action">
          <div className="home-dictation-bar__buttons">
            <Button disabled={actionDisabled} onClick={() => void invoke(action)}>{actionLabel}</Button>
            {modelReady ? null : <Button variant="secondary" onClick={onOpenSettings}>Open Settings <ArrowRight size={16} /></Button>}
          </div>
          <div className="home-dictation-bar__shortcut"><span>Global shortcut</span><ShortcutKey accelerator={settings.hotkey} /></div>
        </div>
      </Card>

      <section className="home-recent">
        <h2 className="home-recent__label">Recent</h2>
        {!settings.historyEnabled ? <p>History is off. New transcripts are not saved.</p>
          : historyStatus === 'loading' ? <p>Loading recent transcripts...</p>
            : historyStatus === 'degraded' ? <p>Recent transcripts are unavailable. Dictation is still ready.</p>
              : recent.length === 0 ? <p>No saved transcripts yet.</p>
                : <ul>{recent.map((entry) => <li key={entry.id}>{entry.text}</li>)}</ul>}
        {settings.historyEnabled && historyStatus === 'ready' && recent.length > 0
          ? <Button variant="ghost" onClick={onOpenHistory}>View all history <ArrowRight size={16} /></Button>
          : null}
      </section>
    </div>
  )
}
