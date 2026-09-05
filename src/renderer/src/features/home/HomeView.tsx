import React, { useMemo, useState, type ReactNode } from 'react'
import { Clipboard } from 'lucide-react'

import type { ModelStatus } from '../../../../shared/contracts'
import type { HistoryEntry } from '../../../../shared/history'
import { MODEL_CATALOG } from '../../../../shared/modelCatalog'
import type { AppSettings } from '../../../../shared/settings'
import { Button } from '../../components/Button'
import { languageLabel } from '../../languages'
import type { HistoryStatus } from '../../state/AppContext'
import { computeWeeklyStats } from './weeklyStats'

export interface HomeViewProps {
  readonly settings: AppSettings
  readonly modelStatus?: ModelStatus | undefined
  readonly entries: readonly HistoryEntry[]
  readonly historyStatus: HistoryStatus
  /** The running version, when the main process has reported it. */
  readonly version?: string | undefined
  readonly onOpenHistory: () => void
  readonly onCopy: (text: string) => Promise<boolean>
}

const DAY_MS = 86_400_000
const CHART_HEIGHT = 116
const RECENT_COUNT = 5

/** Relative day labels keep the chart stable whatever weekday it is read on. */
const DAY_LABELS = ['6d', '5d', '4d', '3d', '2d', 'Yest', 'Today'] as const

const QUALITY_LABELS: Readonly<Record<AppSettings['llmQuality'], string>> = {
  low: 'Low',
  medium: 'Medium',
  value: 'Value',
  high: 'High',
}

function countWords(text: string): number {
  const trimmed = text.trim()
  return trimmed === '' ? 0 : trimmed.split(/\s+/u).length
}

function modelLine(settings: AppSettings, status: ModelStatus | undefined): string {
  const label = MODEL_CATALOG[settings.modelPreset].label
  if (status === undefined) return `${label}, checking`
  switch (status.state) {
    case 'bundled':
    case 'ready': return `${label}, ready`
    case 'downloading': return `${label}, downloading`
    case 'error': return `${label}, needs attention`
    default: return `${label}, not installed`
  }
}

function historyLine(settings: AppSettings, count: number): string {
  if (!settings.historyEnabled) return 'Off'
  if (settings.historyRetention === 'unlimited') return `${count} kept, no limit`
  return `${count} of ${settings.historyRetention} kept`
}

/** Log timestamps: clock time today, "Yest" plus clock yesterday, a short date before that. */
export function logTime(createdAt: number, now: number): { dateTime?: string; label: string } {
  const date = new Date(createdAt)
  if (!Number.isFinite(date.valueOf())) return { label: 'saved' }
  const startOfToday = new Date(now)
  startOfToday.setHours(0, 0, 0, 0)
  const dateTime = date.toISOString()
  const clock = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  if (createdAt >= startOfToday.valueOf()) return { dateTime, label: clock }
  if (createdAt >= startOfToday.valueOf() - DAY_MS) return { dateTime, label: `Yest ${clock}` }
  return { dateTime, label: date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) }
}

export function HomeView({
  settings,
  modelStatus,
  entries,
  historyStatus,
  version,
  onOpenHistory,
  onCopy,
}: HomeViewProps): ReactNode {
  const [copyingId, setCopyingId] = useState<string | null>(null)
  const now = Date.now()
  const stats = useMemo(() => computeWeeklyStats(entries, Date.now()), [entries])
  const recent = useMemo(
    () => [...entries].sort((first, second) => second.createdAt - first.createdAt).slice(0, RECENT_COUNT),
    [entries],
  )
  const chartMax = Math.max(...stats.dailyWords, 1)
  const showRecentList = settings.historyEnabled && historyStatus === 'ready' && recent.length > 0

  const copy = async (entry: HistoryEntry): Promise<void> => {
    if (copyingId !== null) return
    setCopyingId(entry.id)
    try { await onCopy(entry.text) } catch { /* the toast or notice belongs to the caller */ } finally { setCopyingId(null) }
  }

  return (
    <div className="management-view home-view">
      <h1 className="tt-visually-hidden">Home</h1>

      <div className="home-grid">
        <section className="tt-panel home-week">
          <div className="tt-panel__header">
            <h2>This week</h2>
            <div className="home-figures">
              <span><b className="tt-tabular">{stats.words.toLocaleString()}</b>words</span>
              <span><b className="tt-tabular">{stats.avgWpm.toLocaleString()}</b>wpm</span>
              <span><b className="tt-tabular">{stats.minutes.toLocaleString()}</b>min</span>
            </div>
          </div>
          <div
            className="home-chart"
            role="img"
            aria-label={`Words dictated per day over the last seven days: ${stats.dailyWords.map((value, index) => `${DAY_LABELS[index]} ${value}`).join(', ')}.`}
          >
            {stats.dailyWords.map((value, index) => (
              <div className="home-chart__day" key={DAY_LABELS[index]}>
                <i className="home-chart__bar" style={{ height: `${Math.max(3, Math.round((value / chartMax) * CHART_HEIGHT))}px` }} />
                <span className="home-chart__label">{DAY_LABELS[index]}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="tt-panel">
          <div className="tt-panel__header"><h2>Status</h2></div>
          <dl className="home-status">
            <div><dt>Model</dt><dd>{modelLine(settings, modelStatus)}</dd></div>
            <div><dt>Language</dt><dd>{languageLabel(settings.language)}</dd></div>
            <div><dt>Paste</dt><dd>{settings.autoPaste ? `Automatic, ${settings.pasteDelayMs} ms` : 'Clipboard only'}</dd></div>
            <div><dt>AI formatting</dt><dd>{settings.llmFormatting ? `On, ${QUALITY_LABELS[settings.llmQuality]}` : 'Off'}</dd></div>
            <div><dt>History</dt><dd>{historyLine(settings, entries.length)}</dd></div>
            {version === undefined ? null : <div><dt>Version</dt><dd>Sotto {version}</dd></div>}
          </dl>
        </section>
      </div>

      <section className="tt-panel home-recent">
        <div className="tt-panel__header">
          <h2>Recent</h2>
          {showRecentList ? <Button variant="ghost" onClick={onOpenHistory}>Open history</Button> : null}
        </div>
        {!settings.historyEnabled ? <p>History is off. New transcripts are not saved.</p>
          : historyStatus === 'loading' ? <p>Loading recent transcripts...</p>
            : historyStatus === 'degraded' ? <p>Recent transcripts are unavailable. Dictation is still ready.</p>
              : recent.length === 0 ? <p>No saved transcripts yet.</p>
                : (
                  <table>
                    <colgroup>
                      <col style={{ width: '110px' }} />
                      <col />
                      <col style={{ width: '80px' }} />
                      <col style={{ width: '80px' }} />
                      <col style={{ width: '100px' }} />
                    </colgroup>
                    <thead>
                      <tr>
                        <th scope="col">Time</th>
                        <th scope="col">Transcript</th>
                        <th scope="col" className="tt-numeric">Words</th>
                        <th scope="col" className="tt-numeric">Length</th>
                        <th scope="col"><span className="tt-visually-hidden">Actions</span></th>
                      </tr>
                    </thead>
                    <tbody>
                      {recent.map((entry) => {
                        const stamp = logTime(entry.createdAt, now)
                        return (
                          <tr key={entry.id}>
                            <td><time {...(stamp.dateTime === undefined ? {} : { dateTime: stamp.dateTime })}>{stamp.label}</time></td>
                            <td className="home-recent__text">{entry.text}</td>
                            <td className="tt-numeric tt-tabular">{countWords(entry.text)}</td>
                            <td className="tt-numeric tt-tabular">{Math.round(entry.durationMs / 1_000)} s</td>
                            <td className="home-recent__action">
                              <Button variant="secondary" disabled={copyingId !== null} aria-label="Copy transcript" onClick={() => void copy(entry)}>
                                <Clipboard size={13} aria-hidden="true" />Copy
                              </Button>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                )}
      </section>
    </div>
  )
}
