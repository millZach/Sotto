import React, { useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowRight, Check, CircleAlert, Mic, Square } from 'lucide-react'

import type { ModelStatus } from '../../../../shared/contracts'
import type { DictationState } from '../../../../shared/dictation'
import { MODEL_CATALOG } from '../../../../shared/modelCatalog'
import type { SottoPlatform } from '../../../../shared/platform'
import type { AppSettings } from '../../../../shared/settings'
import { Button } from '../../components/Button'
import { ShortcutKey } from '../../components/ShortcutKey'
import { VoiceWave, type VoiceWaveStage } from '../../components/VoiceWave'
import { languageLabel } from '../../languages'
import { platformCopy, type PlatformCopy } from '../../platformCopy'

export interface DictationStripProps {
  readonly settings: AppSettings
  readonly platform: SottoPlatform
  readonly dictation: DictationState
  readonly modelStatus?: ModelStatus | undefined
  readonly onStart: () => Promise<void>
  readonly onStop: () => Promise<void>
  readonly onOpenSettings: () => void
}

export type DictationTone = 'normal' | 'success' | 'error'

export function isModelReady(status: ModelStatus | undefined): boolean {
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

function readyDetail(settings: AppSettings): string {
  const model = MODEL_CATALOG[settings.modelPreset].label
  const where = settings.remoteAsr && settings.remoteAsrUrl.trim().length > 0
    ? 'via your transcription server'
    : 'on this device'
  return `${model} model, ${languageLabel(settings.language)}, ${where}.`
}

export function dictationCopy(
  state: DictationState,
  settings: AppSettings,
  copy: PlatformCopy,
): { label: string; detail: string; tone: DictationTone } {
  switch (state.status) {
    case 'requesting-permission': return { label: 'Connecting to your microphone', detail: copy.homeRequestingPermissionDetail, tone: 'normal' }
    case 'listening': return { label: 'Listening', detail: 'Speak naturally. Press the shortcut again or Stop to finish.', tone: 'normal' }
    case 'processing': return { label: 'Turning speech into text', detail: 'Everything is processing locally.', tone: 'normal' }
    case 'success': return { label: state.output === 'pasted' ? 'Text pasted' : 'Text copied', detail: 'Your recording is complete.', tone: 'success' }
    case 'cancelled': return { label: 'Recording cancelled', detail: 'Nothing was copied or saved.', tone: 'normal' }
    case 'error': return { label: 'Dictation needs attention', detail: finiteError(state.code, copy), tone: 'error' }
    default: return { label: 'Ready', detail: readyDetail(settings), tone: 'normal' }
  }
}

function statusGlyph(state: DictationState, tone: DictationTone): ReactNode {
  if (tone === 'success') return <Check />
  if (tone === 'error') return <CircleAlert />
  return state.status === 'listening' ? <Square /> : <Mic />
}

function waveStage(state: DictationState): VoiceWaveStage {
  if (state.status === 'listening') return 'listening'
  if (state.status === 'processing' || state.status === 'requesting-permission') return 'processing'
  return 'idle'
}

export function formatElapsed(milliseconds: number): string {
  const totalSeconds = Number.isFinite(milliseconds) ? Math.max(0, Math.floor(milliseconds / 1_000)) : 0
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

const TIMER_TICK_MS = 250

/**
 * The deck: one strip pinned under the titlebar on every tab, holding the
 * start/stop control, the widget's seven-bar wave, the session clock, the
 * shortcut, and one line saying what the machine is doing.
 */
export function DictationStrip({
  settings,
  platform,
  dictation,
  modelStatus,
  onStart,
  onStop,
  onOpenSettings,
}: DictationStripProps): ReactNode {
  const [submitting, setSubmitting] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const lastElapsedRef = useRef(0)
  const modelReady = isModelReady(modelStatus)
  const copy = dictationCopy(dictation, settings, platformCopy(platform))
  const stage = waveStage(dictation)
  const active = dictation.status === 'requesting-permission' || dictation.status === 'listening' || dictation.status === 'processing'
  const listening = dictation.status === 'listening'
  const sessionId = 'sessionId' in dictation ? dictation.sessionId : undefined

  useEffect(() => {
    if (!listening) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), TIMER_TICK_MS)
    return () => clearInterval(timer)
  }, [listening, sessionId])

  let elapsed = 0
  if (dictation.status === 'listening') {
    elapsed = now - dictation.startedAt
    lastElapsedRef.current = elapsed
  } else if (dictation.status === 'processing') {
    // The clock stops where the recording stopped and stays until the result lands.
    elapsed = lastElapsedRef.current
  } else {
    lastElapsedRef.current = 0
  }

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

  const liveProps = copy.tone === 'error'
    ? { role: 'alert' as const, 'aria-live': 'assertive' as const }
    : { 'aria-live': 'polite' as const }

  return (
    <section className="dictation-strip" aria-label="Dictation" data-stage={stage} data-active={active} data-tone={copy.tone}>
      <div className="dictation-strip__buttons">
        <Button disabled={actionDisabled} onClick={() => void invoke(action)}>
          {listening ? <Square size={14} aria-hidden="true" /> : <Mic size={14} aria-hidden="true" />}
          {actionLabel}
        </Button>
        {modelReady ? null : <Button variant="secondary" onClick={onOpenSettings}>Open Settings <ArrowRight size={14} aria-hidden="true" /></Button>}
      </div>
      <VoiceWave
        stage={stage}
        value={dictation.status === 'listening' ? dictation.level : 0}
        label="Microphone activity"
        size="deck"
      />
      <span className="dictation-strip__timer tt-tabular" aria-label={`Recording time ${formatElapsed(elapsed)}`}>{formatElapsed(elapsed)}</span>
      <ShortcutKey accelerator={settings.hotkey} platform={platform} />
      <div className="dictation-strip__state" aria-atomic="true" {...liveProps}>
        <span className="dictation-strip__icon" aria-hidden="true">{statusGlyph(dictation, copy.tone)}</span>
        <span className="dictation-strip__copy" title={`${copy.label}. ${copy.detail}`}><h2>{copy.label}</h2> <p>{copy.detail}</p></span>
      </div>
    </section>
  )
}
