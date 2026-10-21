import React, { type ReactNode } from 'react'

import { Button } from './Button'
import {
  describeSpeechModelProgress,
  PARAKEET_V3,
  speechModelBytes,
  type SpeechModelFailure,
  type SpeechModelOption,
  type SpeechModelStatus,
} from '../../../shared/speechModel'

/** What stopped the speech model, and what Try again does about it. Nothing is ever lost. */
const FAILURE_COPY: Readonly<Record<SpeechModelFailure, { readonly what: string; readonly next: string }>> = Object.freeze({
  network: { what: 'The download stopped: Sotto could not reach GitHub, or GitHub did not send the file.', next: 'Nothing is lost; Try again picks up where it stopped.' },
  checksum: { what: 'A downloaded file did not match the published one, so Sotto deleted it.', next: 'Try again downloads that file again.' },
  disk: { what: 'Sotto could not save the model on this computer.', next: 'Free up about 700 MB, then try again.' },
  engine: { what: 'The model is downloaded, but the speech engine would not start on this computer.', next: 'Try again checks the files, downloads any that went bad, and starts it again.' },
  gone: { what: 'The model\u2019s files are no longer on this computer.', next: 'Nothing is lost. Choose another model, or reinstall it in the app that downloaded it.' },
})

/** A model Sotto did not download is never downloaded again: Try again only starts it. */
const ENGINE_COPY_NOT_DOWNLOADED = Object.freeze({ what: 'The speech engine would not start this model on this computer.', next: 'Try again starts it again.' })

/** The footer's and the Dictate room's short form of each failure. */
const FAILURE_SUMMARY: Readonly<Record<SpeechModelFailure, string>> = Object.freeze({
  network: 'Speech model download stopped',
  checksum: 'Speech model download did not match',
  disk: 'Speech model could not be saved',
  engine: 'Speech model would not start',
  gone: 'Speech model is no longer on this computer',
})

/** A model's size as people read file sizes: "670 MB", "2.4 GB". */
export function formatModelSize(bytes: number): string {
  return bytes >= 1_000_000_000 ? `${(bytes / 1_000_000_000).toFixed(1)} GB` : `${Math.round(bytes / 1_000_000)} MB`
}

/** What a refused choice means: usually the model went between the list being read and the press. */
export const SPEECH_MODEL_REFUSED = 'Sotto could not switch to that model, so nothing changed. It may no longer be on this computer; choose it again or another one.'

/** One line of where the model stands, for the footer, the dictate room and the widget. */
export function speechModelSummary(status: SpeechModelStatus | null, modelName: string = PARAKEET_V3.name): string {
  if (status === null) return 'Checking the speech model'
  switch (status.state) {
    case 'missing': return 'No speech model chosen'
    case 'downloading': return `Downloading the speech model · ${describeSpeechModelProgress(status.receivedBytes, status.totalBytes)}`
    case 'loading': return 'Starting the speech model'
    case 'ready': return `${modelName} on this computer`
    case 'failed': return FAILURE_SUMMARY[status.reason]
  }
}

export interface SpeechModelStatusProps {
  readonly status: SpeechModelStatus | null
  readonly onRetry: () => void
  /** The chosen model, for its size and where it came from; Parakeet v3 when left out. */
  readonly model?: SpeechModelOption | null
}

/**
 * The speech model's progress and outcome (ADR-0071): a bar while it downloads, Ready once it runs,
 * and on failure what happened, that nothing is lost, and Try again. Shared by Settings →
 * Transcription and the setup step that starts the download.
 */
export function SpeechModelStatus({ status, onRetry, model = null }: SpeechModelStatusProps): ReactNode {
  const downloaded = model === null || model.source === 'sotto'
  if (status === null) return <p className="tt-field__description speech-model-status">Checking the speech model…</p>
  if (status.state === 'ready') {
    return <p className="tt-field__description speech-model-status"><strong className="speech-model-status__ready">Ready.</strong> {formatModelSize(model?.bytes ?? speechModelBytes(PARAKEET_V3))} on this computer.</p>
  }
  if (status.state === 'loading') {
    return <p className="tt-field__description speech-model-status" role="status">{downloaded ? 'Downloaded. ' : ''}Starting the speech model…</p>
  }
  // Nothing downloads by itself: until a model is chosen there is nothing to start.
  if (status.state === 'missing') {
    return <p className="tt-field__description speech-model-status">No speech model chosen yet. Choose one above.</p>
  }
  const percent = Math.round((status.receivedBytes / status.totalBytes) * 100)
  const bar = (
    <div className="speech-model-status__bar" role="progressbar" aria-label="Speech model download" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
      <span style={{ width: `${percent}%` }} />
    </div>
  )
  if (status.state === 'downloading') {
    return (
      <div className="speech-model-status">
        {bar}
        <p className="tt-field__description" role="status">Downloading · {describeSpeechModelProgress(status.receivedBytes, status.totalBytes)}</p>
      </div>
    )
  }
  const copy = status.reason === 'engine' && !downloaded ? ENGINE_COPY_NOT_DOWNLOADED : FAILURE_COPY[status.reason]
  const stoppedAt = status.reason === 'network' && status.receivedBytes > 0
    ? ` It stopped at ${describeSpeechModelProgress(status.receivedBytes, status.totalBytes)}.`
    : ''
  return (
    <div className="speech-model-status">
      {status.reason === 'network' && status.receivedBytes > 0 ? bar : null}
      <p className="tt-field__description speech-model-status__error" role="alert">
        {copy.what}{stoppedAt} {copy.next}
      </p>
      <Button variant="secondary" onClick={onRetry}>Try again</Button>
    </div>
  )
}
