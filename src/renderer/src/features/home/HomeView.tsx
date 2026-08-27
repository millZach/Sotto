import React, { useMemo, useState, type ReactNode } from 'react'
import { ArrowRight, Check, CircleAlert, Mic, Square } from 'lucide-react'

import type { ModelStatus } from '../../../../shared/contracts'
import type { DictationState } from '../../../../shared/dictation'
import type { HistoryEntry } from '../../../../shared/history'
import type { SottoPlatform } from '../../../../shared/platform'
import type { AppSettings } from '../../../../shared/settings'
import { Button } from '../../components/Button'
import { Card } from '../../components/Card'
import { ShortcutKey } from '../../components/ShortcutKey'
import { platformCopy, type PlatformCopy } from '../../platformCopy'
import type { HistoryStatus } from '../../state/AppContext'
import { BreathLine, type BreathLineStage } from './BreathLine'
import { computeWeeklyStats } from './weeklyStats'

export interface HomeViewProps {
  readonly settings: AppSettings
  readonly platform: SottoPlatform
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

function finiteError(code: string, copy: PlatformCopy): string {
  switch (code) {
    case 'MIC_PERMISSION_DENIED': return copy.homeMicrophonePermissionDenied
    case 'MIC_DEVICE_NOT_FOUND': return 'The selected microphone is unavailable. Choose another microphone in Settings.'
    case 'NO_SPEECH': return 'No speech was detected. Try again a little closer to the microphone.'
    case 'OUTPUT_FAILED':
    case 'OUTPUT_UNAVAILABLE': return 'Your text could not be delivered. Try again, then paste from the clipboard manually.'
    default: return 'Sotto could not transcribe that recording. Try again or choose a smaller model in Settings.'
  }
}

function statusCopy(state: DictationState, copy: PlatformCopy): { label: string; detail: string; tone: 'normal' | 'error' | 'success' } {
  switch (state.status) {
    case 'requesting-permission': return { label: 'Connecting to your microphone', detail: copy.homeRequestingPermissionDetail, tone: 'normal' }
    case 'listening': return { label: 'Listening', detail: 'Speak naturally, then stop when you are finished.', tone: 'normal' }
    case 'processing': return { label: 'Turning speech into text', detail: 'Everything is processing locally.', tone: 'normal' }
    case 'success': return { label: state.output === 'pasted' ? 'Text pasted' : 'Text copied', detail: 'Your recording is complete.', tone: 'success' }
    case 'cancelled': return { label: 'Recording cancelled', detail: 'Nothing was copied or saved.', tone: 'normal' }
    case 'error': return { label: 'Dictation needs attention', detail: finiteError(state.code, copy), tone: 'error' }
    default: return { label: 'Ready when you are', detail: 'Start here or use your shortcut in any application.', tone: 'normal' }
  }
}

function statusGlyph(state: DictationState, tone: 'normal' | 'error' | 'success'): ReactNode {
  if (tone === 'success') return <Check />
  if (tone === 'error') return <CircleAlert />
  return state.status === 'listening' ? <Square /> : <Mic />
}

function breathStage(state: DictationState): BreathLineStage {
  if (state.status === 'listening') return 'listening'
  if (state.status === 'processing' || state.status === 'requesting-permission') return 'processing'
  return 'idle'
}

const TREND_HEIGHT = 16

function Trend({ values }: { readonly values: readonly number[] }): ReactNode {
  const max = Math.max(...values, 1)
  return (
    <div className="home-meter__trend" aria-hidden="true">
      {values.map((value, index) => (
        <span key={index} style={{ height: `${Math.max(2, Math.round((value / max) * TREND_HEIGHT))}px` }} />
      ))}
    </div>
  )
}

/**
 * Mono digits give the thousands separator a full character cell of its own,
 * which reads as "2 ,847". Wrapping the separator lets CSS give it a narrow
 * cell without disturbing the tabular rhythm of the digits themselves.
 */
function readout(value: number): ReactNode[] {
  return value.toLocaleString().split(/(\d+)/u).filter(Boolean).map((part, index) => (
    /\d/u.test(part)
      ? <React.Fragment key={index}>{part}</React.Fragment>
      : <span className="home-meter__separator" key={index}>{part}</span>
  ))
}

interface MeterProps {
  readonly label: string
  readonly value: number
  readonly unit?: string
  readonly trend?: readonly number[] | undefined
}

function Meter({ label, value, unit, trend }: MeterProps): ReactNode {
  return (
    <div className="home-meter">
      <p className="home-meter__label tt-instrument">{label}</p>
      <p className="home-meter__value tt-tabular">
        {readout(value)}
        {unit === undefined ? null : <span className="home-meter__unit">{unit}</span>}
      </p>
      {trend === undefined ? null : <Trend values={trend} />}
    </div>
  )
}

const DAY_MS = 86_400_000

/** Log timestamps: clock time today, "yest" yesterday, a short date before that. */
function logTime(createdAt: number, now: number): { dateTime?: string; label: string } {
  const date = new Date(createdAt)
  if (!Number.isFinite(date.valueOf())) return { label: 'saved' }
  const startOfToday = new Date(now)
  startOfToday.setHours(0, 0, 0, 0)
  const dateTime = date.toISOString()
  if (createdAt >= startOfToday.valueOf()) {
    return { dateTime, label: date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) }
  }
  if (createdAt >= startOfToday.valueOf() - DAY_MS) return { dateTime, label: 'yest' }
  return { dateTime, label: date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) }
}

export function HomeView({
  settings,
  platform,
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
  const copy = statusCopy(dictation, platformCopy(platform))
  const now = Date.now()
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

  const showRecentList = settings.historyEnabled && historyStatus === 'ready' && recent.length > 0

  return (
    <div className="management-view home-view">
      <h1 className="tt-visually-hidden">Home</h1>

      <div className="home-meters">
        <Meter label="Words / wk" value={stats.words} trend={stats.dailyWords} />
        <Meter label="Avg WPM" value={stats.avgWpm} />
        <Meter label="Time / wk" value={stats.minutes} unit="min" trend={stats.dailyMinutes} />
      </div>

      <Card className="home-dictation-bar" data-active={active} data-tone={copy.tone}>
        <div className="home-dictation-bar__copy" role={copy.tone === 'error' ? 'alert' : 'status'} aria-live={copy.tone === 'error' ? 'assertive' : 'polite'}>
          <h2><span className="home-dictation-bar__icon" aria-hidden="true">{statusGlyph(dictation, copy.tone)}</span>{copy.label}</h2>
          <p>{copy.detail}</p>
        </div>
        <BreathLine
          stage={breathStage(dictation)}
          value={dictation.status === 'listening' ? dictation.level : 0}
          label="Microphone activity"
        />
        <div className="home-dictation-bar__action">
          <div className="home-dictation-bar__buttons">
            <Button disabled={actionDisabled} onClick={() => void invoke(action)}>{actionLabel}</Button>
            {modelReady ? null : <Button variant="secondary" onClick={onOpenSettings}>Open Settings <ArrowRight size={16} /></Button>}
          </div>
          <div className="home-dictation-bar__shortcut"><span>Global shortcut</span><ShortcutKey accelerator={settings.hotkey} platform={platform} /></div>
        </div>
      </Card>

      <section className="home-recent">
        <div className="home-recent__header">
          <h2 className="home-recent__label tt-instrument">Recent</h2>
          {showRecentList
            ? <Button variant="ghost" onClick={onOpenHistory}>View all history <ArrowRight size={14} /></Button>
            : null}
        </div>
        {!settings.historyEnabled ? <p>History is off. New transcripts are not saved.</p>
          : historyStatus === 'loading' ? <p>Loading recent transcripts...</p>
            : historyStatus === 'degraded' ? <p>Recent transcripts are unavailable. Dictation is still ready.</p>
              : recent.length === 0 ? <p>No saved transcripts yet.</p>
                : <ul>{recent.map((entry) => {
                  const stamp = logTime(entry.createdAt, now)
                  return (
                    <li key={entry.id}>
                      <time {...(stamp.dateTime === undefined ? {} : { dateTime: stamp.dateTime })}>{stamp.label}</time>
                      <p>{entry.text}</p>
                    </li>
                  )
                })}</ul>}
      </section>
    </div>
  )
}
