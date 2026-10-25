import React, { type ReactNode } from 'react'
import { i18n, type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'

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
const FAILURE_COPY: Readonly<Record<SpeechModelFailure, { readonly what: MessageDescriptor; readonly next: MessageDescriptor }>> = Object.freeze({
  network: { what: msg`The download stopped: Sotto could not reach GitHub, or GitHub did not send the file.`, next: msg`Nothing is lost; Try again picks up where it stopped.` },
  checksum: { what: msg`A downloaded file did not match the published one, so Sotto deleted it.`, next: msg`Try again downloads that file again.` },
  disk: { what: msg`Sotto could not save the model on this computer.`, next: msg`Free up about 700 MB, then try again.` },
  engine: { what: msg`The model is downloaded, but the speech engine would not start on this computer.`, next: msg`Try again checks the files, downloads any that went bad, and starts it again.` },
  gone: { what: msg`The model’s files are no longer on this computer.`, next: msg`Nothing is lost. Choose another model, or reinstall it in the app that downloaded it.` },
})

/** A model Sotto did not download is never downloaded again: Try again only starts it. */
const ENGINE_COPY_NOT_DOWNLOADED = Object.freeze({ what: msg`The speech engine would not start this model on this computer.`, next: msg`Try again starts it again.` })

/** The footer's and the Dictate room's short form of each failure. */
const FAILURE_SUMMARY: Readonly<Record<SpeechModelFailure, MessageDescriptor>> = Object.freeze({
  network: msg`Speech model download stopped`,
  checksum: msg`Speech model download did not match`,
  disk: msg`Speech model could not be saved`,
  engine: msg`Speech model would not start`,
  gone: msg`Speech model is no longer on this computer`,
})

/** A model's size as people read file sizes: "670 MB", "2.4 GB". */
export function formatModelSize(bytes: number): string {
  return bytes >= 1_000_000_000 ? `${(bytes / 1_000_000_000).toFixed(1)} GB` : `${Math.round(bytes / 1_000_000)} MB`
}

/** What a refused choice means: usually the model went between the list being read and the press. */
export const SPEECH_MODEL_REFUSED = 'Sotto could not switch to that model, so nothing changed. It may no longer be on this computer; choose it again or another one.'

/** SPEECH_MODEL_REFUSED in the interface language. */
export function speechModelRefusedMessage(): string {
  return i18n._(msg`Sotto could not switch to that model, so nothing changed. It may no longer be on this computer; choose it again or another one.`)
}

/** One line of where the model stands, for the footer, the dictate room and the widget. */
export function speechModelSummary(status: SpeechModelStatus | null, modelName: string = PARAKEET_V3.name): string {
  if (status === null) return i18n._(msg`Checking the speech model`)
  switch (status.state) {
    case 'missing': return i18n._(msg`No speech model chosen`)
    case 'downloading': {
      const progress = describeSpeechModelProgress(status.receivedBytes, status.totalBytes)
      return i18n._(msg`Downloading the speech model · ${progress}`)
    }
    case 'loading': return i18n._(msg`Starting the speech model`)
    case 'ready': return i18n._(msg`${modelName} on this computer`)
    case 'failed': return i18n._(FAILURE_SUMMARY[status.reason])
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
  const { t, i18n: shown } = useLingui()
  const downloaded = model === null || model.source === 'sotto'
  if (status === null) return <p className="tt-field__description tt-paragraph speech-model-status"><Trans>Checking the speech model…</Trans></p>
  if (status.state === 'ready') {
    const size = formatModelSize(model?.bytes ?? speechModelBytes(PARAKEET_V3))
    return <p className="tt-field__description tt-paragraph speech-model-status"><Trans><strong className="speech-model-status__ready">Ready.</strong> {size} on this computer.</Trans></p>
  }
  if (status.state === 'loading') {
    return <p className="tt-field__description tt-paragraph speech-model-status" role="status">{downloaded ? t`Downloaded. Starting the speech model…` : t`Starting the speech model…`}</p>
  }
  // Nothing downloads by itself: until a model is chosen there is nothing to start.
  if (status.state === 'missing') {
    return <p className="tt-field__description tt-paragraph speech-model-status"><Trans>No speech model chosen yet. Choose one above.</Trans></p>
  }
  const percent = Math.round((status.receivedBytes / status.totalBytes) * 100)
  const progress = describeSpeechModelProgress(status.receivedBytes, status.totalBytes)
  const bar = (
    <div className="speech-model-status__bar" role="progressbar" aria-label={t`Speech model download`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
      <span style={{ width: `${percent}%` }} />
    </div>
  )
  if (status.state === 'downloading') {
    return (
      <div className="speech-model-status">
        {bar}
        <p className="tt-field__description tt-paragraph" role="status">{t`Downloading · ${progress}`}</p>
      </div>
    )
  }
  const copy = status.reason === 'engine' && !downloaded ? ENGINE_COPY_NOT_DOWNLOADED : FAILURE_COPY[status.reason]
  const stoppedAt = status.reason === 'network' && status.receivedBytes > 0
    ? ` ${t`It stopped at ${progress}.`}`
    : ''
  return (
    <div className="speech-model-status">
      {status.reason === 'network' && status.receivedBytes > 0 ? bar : null}
      <p className="tt-field__description tt-paragraph speech-model-status__error" role="alert">
        {shown._(copy.what)}{stoppedAt} {shown._(copy.next)}
      </p>
      <Button variant="secondary" onClick={onRetry}><Trans>Try again</Trans></Button>
    </div>
  )
}
