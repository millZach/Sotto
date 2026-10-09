import { createHash, randomBytes } from 'node:crypto'
import { closeSync, fchmodSync, lstatSync, openSync, renameSync, unlinkSync, writeFileSync, type Stats } from 'node:fs'
import { dirname, join } from 'node:path'
import { WIDGET_ERROR_CODES, type WidgetErrorCode, type WidgetSnapshot } from '../../shared/dictation'
import type { WidgetEdge } from '../windows/widgetPlacementMath'
import { dictationSocketPath } from './dictationCommand'
import { validateDictationFolder } from './dictationEndpoint'
import { assertDictationDirectories, validateDictationRuntime, type DictationDirectory } from './dictationRuntime'

export interface ShellDictationState {
  readonly version: 1
  readonly pid: number
  readonly pidStart?: number
  readonly dictation: string | null
  readonly state: 'idle' | 'starting' | 'listening' | 'transcribing' | 'delivered' | 'copied' | 'failed'
  readonly since: number
  readonly updatedAt: number
  readonly detail: string | null
  readonly kept: boolean
  readonly edge: WidgetEdge
}

// Only reviewed copy can reach the file. Neither a renderer error message nor
// a provider's response is accepted, even if a caller carries extra fields.
const nothingRecordedDetail = {
  MIC_PERMISSION_DENIED: 'Microphone access was denied. Allow it, then try again.',
  MIC_DEVICE_NOT_FOUND: 'No microphone was found. Connect one, then try again.',
  MIC_START_FAILED: 'The microphone could not start. Try again.',
  MIC_NOT_SET_UP: 'Set up your microphone in Settings.',
  NO_SPEECH: 'No speech was heard. Dictate again.',
  SETTINGS_UNAVAILABLE: 'Settings could not be read. Open Sotto and try again.',
} as const satisfies Partial<Record<WidgetErrorCode, string>>

// These failures follow captured audio. Say it was lost, or where the completed
// text remains. Output recovery in Dictate exists even when history is off.
const capturedDetail: Readonly<Record<Exclude<WidgetErrorCode, keyof typeof nothingRecordedDetail>, string>> = {
  RECORDING_FAILED: 'Recording stopped and was lost. Dictate again.',
  TRANSCRIPTION_UNCONFIGURED: 'No OpenRouter key. Recording lost. Add it in Settings.',
  TRANSCRIPTION_UNAUTHORIZED: 'OpenRouter key rejected. Recording lost. Check Settings.',
  TRANSCRIPTION_OFFLINE: 'OpenRouter unreachable. Recording lost. Check connection.',
  TRANSCRIPTION_BILLING: 'OpenRouter has no credit. Recording lost. Add credit.',
  TRANSCRIPTION_RATE_LIMITED: 'Transcription busy. Recording lost. Dictate again later.',
  TRANSCRIPTION_SERVICE_ERROR: 'OpenRouter error. Recording lost. Dictate again.',
  TRANSCRIPTION_FAILED: 'No usable text returned. Recording lost. Dictate again.',
  OUTPUT_UNAVAILABLE: 'Text kept in Sotto. Open Dictate to copy it.',
  OUTPUT_FAILED: 'Text kept in Sotto. Open Dictate to copy it.',
  DESKTOP_CLIPBOARD_UNAVAILABLE: 'Text kept in Sotto. Open Dictate to copy it.',
  HISTORY_FAILED: 'Text delivered and on the clipboard. History not saved.',
}
const failureDetail: Readonly<Record<WidgetErrorCode, string>> = { ...nothingRecordedDetail, ...capturedDetail }

// The shell pill displays detail directly; its buttons supply Try again and
// Discard. Keep the reason and recording outcome in every kept failure.
const keptFailureDetail: Readonly<Record<WidgetErrorCode, string>> = {
  MIC_PERMISSION_DENIED: 'Microphone access denied. Recording kept.',
  MIC_DEVICE_NOT_FOUND: 'No microphone found. Recording kept.',
  MIC_START_FAILED: 'Microphone could not start. Recording kept.',
  MIC_NOT_SET_UP: 'No microphone set up. Recording kept. Check Settings.',
  RECORDING_FAILED: 'Recording stopped unexpectedly. Recording kept.',
  NO_SPEECH: 'No speech was heard. Recording kept.',
  TRANSCRIPTION_UNCONFIGURED: 'No OpenRouter key. Recording kept. Add it in Settings.',
  TRANSCRIPTION_UNAUTHORIZED: 'OpenRouter key rejected. Recording kept. Check Settings.',
  TRANSCRIPTION_OFFLINE: 'Sotto could not reach OpenRouter. Recording kept.',
  TRANSCRIPTION_BILLING: 'OpenRouter has no credit. Recording kept. Add credit.',
  TRANSCRIPTION_RATE_LIMITED: 'The transcription service is busy. Recording kept.',
  TRANSCRIPTION_SERVICE_ERROR: 'OpenRouter returned an error. Recording kept.',
  TRANSCRIPTION_FAILED: 'Sotto did not get usable text back. Recording kept.',
  OUTPUT_UNAVAILABLE: 'Text could not be delivered. Recording kept. Open Sotto.',
  OUTPUT_FAILED: 'Text could not be delivered. Recording kept. Open Sotto.',
  DESKTOP_CLIPBOARD_UNAVAILABLE: 'Clipboard unavailable. Recording kept. Open Dictate.',
  HISTORY_FAILED: 'Text delivered; history failed. Recording kept.',
  SETTINGS_UNAVAILABLE: 'Settings could not be read. Recording kept. Open Sotto.',
}

export function shellDictationFields(snapshot: WidgetSnapshot): Pick<ShellDictationState, 'dictation' | 'state' | 'detail' | 'kept'> {
  // Cancel ends the dictation and maps to idle. All other session states retain
  // one opaque identity, including kept failures and their retries. Hash only
  // Sotto's session identifier, never text, audio or provider data.
  const dictation = snapshot.status === 'idle' || snapshot.status === 'cancelled' || snapshot.sessionId === undefined
    ? null : createHash('sha256').update(snapshot.sessionId).digest('hex')
  switch (snapshot.status) {
    case 'idle': case 'cancelled': return { dictation, state: 'idle', detail: null, kept: false }
    case 'requesting-permission': return { dictation, state: 'starting', detail: null, kept: false }
    case 'listening': return { dictation, state: 'listening', detail: null, kept: false }
    case 'processing': return { dictation, state: 'transcribing', detail: null, kept: false }
    case 'success': return { dictation, state: snapshot.output === 'pasted' ? 'delivered' : 'copied', detail: snapshot.output === 'pasted' ? null : 'Copied — paste with Super+V', kept: false }
    case 'error': return {
      dictation,
      state: 'failed',
      detail: (WIDGET_ERROR_CODES as readonly string[]).includes(snapshot.code)
        ? (snapshot.kept === true ? keptFailureDetail : failureDetail)[snapshot.code]
        : snapshot.kept === true ? 'Dictation failed. Recording kept.' : 'Dictation failed. Recording lost. Dictate again.',
      kept: snapshot.kept === true,
    }
  }
}

/** Linux main starts this only after owning the socket in the same validated folder. */
export class DictationStateFile {
  readonly path: string
  private readonly directories: DictationDirectory[]
  private state: ShellDictationState
  private timer: ReturnType<typeof setTimeout> | null = null
  private ownedFile: Stats | null = null
  private disposed = false

  constructor(runtimeDirectory: string | undefined, edge: WidgetEdge, private readonly onFailure: () => void, pidStart?: number) {
    this.path = join(dirname(dictationSocketPath(runtimeDirectory)), 'dictation-state.json')
    this.directories = [...validateDictationRuntime(runtimeDirectory), validateDictationFolder(dirname(this.path))]
    const now = Date.now()
    this.state = { version: 1, pid: process.pid, ...(pidStart === undefined ? {} : { pidStart }), dictation: null, state: 'idle', since: now, updatedAt: now, detail: null, kept: false, edge }
    this.flush()
  }

  publish(snapshot: WidgetSnapshot): void {
    this.update(shellDictationFields(snapshot))
  }

  place(edge: WidgetEdge): void {
    this.update({ edge })
  }

  private update(fields: Partial<Pick<ShellDictationState, 'dictation' | 'state' | 'detail' | 'kept' | 'edge'>>): void {
    if (this.disposed || Object.entries(fields).every(([key, value]) => this.state[key as keyof ShellDictationState] === value)) return
    const now = Date.now()
    this.state = { ...this.state, ...fields, since: fields.state !== undefined && fields.state !== this.state.state ? now : this.state.since, updatedAt: now }
    // A bounded publish window: write the first change now, then the latest at
    // the end. Level/progress bursts never write, and a final state is retained.
    if (this.timer === null) this.flush()
  }

  private flush(): void {
    if (this.disposed) return
    const published = this.state
    const temp = `${this.path}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`
    let fd: number | null = null
    let tempOwned = false
    try {
      assertDictationDirectories(this.directories)
      fd = openSync(temp, 'wx', 0o600)
      tempOwned = true
      fchmodSync(fd, 0o600)
      writeFileSync(fd, `${JSON.stringify(published)}\n`, 'utf8')
      closeSync(fd)
      fd = null
      assertDictationDirectories(this.directories)
      renameSync(temp, this.path)
      this.ownedFile = lstatSync(this.path)
    } catch {
      this.onFailure()
    } finally {
      if (fd !== null) closeSync(fd)
      if (tempOwned) {
        try { assertDictationDirectories(this.directories); unlinkSync(temp) } catch { /* No published temp remains. */ }
      }
    }
    this.timer = setTimeout(() => {
      this.timer = null
      if (this.state !== published) this.flush()
    }, 50)
    this.timer.unref()
  }

  dispose(): void {
    this.disposed = true
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    try {
      assertDictationDirectories(this.directories)
      const current = lstatSync(this.path)
      if (current.dev === this.ownedFile?.dev && current.ino === this.ownedFile.ino) unlinkSync(this.path)
    } catch { /* Quitting still works after runtime removal or replacement. */ }
  }
}
