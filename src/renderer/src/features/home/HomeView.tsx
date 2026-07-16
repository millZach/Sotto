import React, { useMemo, useState, type ReactNode } from 'react'
import { ArrowRight, Clock3, LockKeyhole, Mic, Square, WandSparkles } from 'lucide-react'

import type { ModelStatus } from '../../../../shared/contracts'
import type { DictationState } from '../../../../shared/dictation'
import type { HistoryEntry } from '../../../../shared/history'
import { MODEL_CATALOG } from '../../../../shared/modelCatalog'
import type { AppSettings } from '../../../../shared/settings'
import { Button } from '../../components/Button'
import { Card } from '../../components/Card'
import { LevelMeter } from '../../components/LevelMeter'
import { ShortcutKey } from '../../components/ShortcutKey'
import type { HistoryStatus } from '../../state/AppContext'

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
    default: return 'TalkType could not transcribe that recording. Try again or choose a smaller model in Settings.'
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
  const recent = useMemo(
    () => [...entries].sort((first, second) => second.createdAt - first.createdAt).slice(0, 5),
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
      <header className="management-view__header">
        <div><p className="management-eyebrow">Dashboard</p><h1>Home</h1></div>
        <div className="privacy-badge"><LockKeyhole size={16} aria-hidden="true" />Speech stays on this computer</div>
      </header>

      <Card className="home-record-card" data-active={active}>
        <div className="home-record-card__icon" aria-hidden="true">{dictation.status === 'listening' ? <Square /> : <Mic />}</div>
        <div className="home-record-card__copy" role={copy.tone === 'error' ? 'alert' : 'status'} aria-live={copy.tone === 'error' ? 'assertive' : 'polite'}>
          <p className="home-record-card__label">Private dictation</p>
          <h2>{copy.label}</h2>
          <p>{copy.detail}</p>
        </div>
        {dictation.status === 'listening' ? <LevelMeter value={dictation.level} label="Microphone activity" /> : null}
        <div className="home-record-card__action">
          <Button disabled={actionDisabled} onClick={() => void invoke(action)}>{actionLabel}</Button>
          <div className="home-record-card__shortcut"><span>Global shortcut</span><ShortcutKey accelerator={settings.hotkey} /></div>
        </div>
      </Card>

      <div className="home-grid">
        <Card className="home-model-card">
          <div className="section-heading"><WandSparkles size={19} aria-hidden="true" /><h2>Transcription model</h2></div>
          <strong>{MODEL_CATALOG[settings.modelPreset].label}</strong>
          <p>{modelReady
            ? `${MODEL_CATALOG[settings.modelPreset].label} is ready for local transcription.`
            : modelStatus?.state === 'downloading'
              ? `Preparing locally - ${Math.round((modelStatus.progress ?? 0) * 100)}%.`
              : 'The selected model is not ready yet.'}</p>
          <Button variant="secondary" onClick={onOpenSettings}>Open Settings <ArrowRight size={16} /></Button>
        </Card>

        <Card className="home-recent-card">
          <div className="section-heading"><Clock3 size={19} aria-hidden="true" /><h2>Recent transcripts</h2></div>
          {!settings.historyEnabled ? <p>History is off. New transcripts are not saved.</p>
            : historyStatus === 'loading' ? <p>Loading recent transcripts...</p>
              : historyStatus === 'degraded' ? <p>Recent transcripts are unavailable. Dictation is still ready.</p>
                : recent.length === 0 ? <p>No saved transcripts yet.</p>
                  : <ul>{recent.map((entry) => <li key={entry.id}>{entry.text}</li>)}</ul>}
          {settings.historyEnabled && historyStatus === 'ready' && recent.length > 0
            ? <Button variant="ghost" onClick={onOpenHistory}>View all history <ArrowRight size={16} /></Button>
            : null}
        </Card>
      </div>
    </div>
  )
}
