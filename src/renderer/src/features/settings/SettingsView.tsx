import React, { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Check, CircleAlert, Gauge, HardDrive, Keyboard, MonitorCog, Sparkles, Trash2 } from 'lucide-react'

import {
  REMOTE_ASR_PRIVACY_NOTICE,
  type CommandResult,
  type HotkeyChangeResult,
  type ModelDisclosure,
  type ModelDisclosureCatalog,
  type ModelInstallRequest,
  type ModelStatus,
  type RemoteAsrHealth,
  type StartupState,
  type UnavailableResult,
} from '../../../../shared/contracts'
import { formatAccelerator, parseAccelerator } from '../../../../shared/accelerator'
import { MODEL_CATALOG } from '../../../../shared/modelCatalog'
import type { SottoPlatform } from '../../../../shared/platform'
import type {
  AppSettings,
  HistoryRetention,
  LlmQuality,
  ModelPreset,
  ReducedMotion,
  SettingsPatch,
  Theme,
} from '../../../../shared/settings'
import { Button } from '../../components/Button'
import { Card } from '../../components/Card'
import { ConfirmationDialog } from '../../components/ConfirmationDialog'
import { Field } from '../../components/Field'
import { Select } from '../../components/Select'
import { Toggle } from '../../components/Toggle'
import { platformCopy } from '../../platformCopy'

type MediaDevicesAdapter = Pick<MediaDevices, 'enumerateDevices' | 'addEventListener' | 'removeEventListener'>

interface DraftSubmission<T> {
  readonly token: number
  readonly submitted: T
  readonly authoritativeAtSubmit: T
  readonly editVersion: number
}

export interface SettingsViewProps {
  readonly settings: AppSettings
  readonly platform: SottoPlatform
  readonly modelStatuses: Readonly<Partial<Record<ModelPreset, ModelStatus>>>
  readonly mediaDevices?: MediaDevicesAdapter | undefined
  readonly onUpdateSettings: (patch: SettingsPatch) => Promise<boolean>
  readonly onReplaceHotkey: (accelerator: string) => Promise<HotkeyChangeResult>
  readonly onSetStartup: (enabled: boolean) => Promise<StartupState | null>
  readonly onResetSettings: () => Promise<boolean>
  readonly onClearHistory: () => Promise<boolean>
  readonly onGetModelStatus: (preset: ModelPreset) => Promise<ModelStatus | UnavailableResult>
  readonly onListModelDisclosures: () => Promise<ModelDisclosureCatalog | UnavailableResult>
  readonly onInstallModel: (request: ModelInstallRequest) => Promise<CommandResult>
  readonly onRemoveModel: (preset: ModelPreset) => Promise<CommandResult>
  readonly onCheckRemoteAsr: () => Promise<RemoteAsrHealth>
}

const knownLanguages = [
  { value: 'auto', label: 'Automatic (English default)' },
  { value: 'en', label: 'English' },
  { value: 'es', label: 'Spanish' },
  { value: 'fr', label: 'French' },
  { value: 'de', label: 'German' },
  { value: 'it', label: 'Italian' },
  { value: 'pt', label: 'Portuguese' },
  { value: 'ja', label: 'Japanese' },
  { value: 'zh', label: 'Chinese' },
] as const

function bytesLabel(bytes: number): string {
  return `${Math.round(bytes / 1_000_000)} MB`
}

function modelReady(status: ModelStatus | undefined): boolean {
  return status?.state === 'bundled' || status?.state === 'ready'
}

function modelStateCopy(status: ModelStatus | undefined): string {
  if (status === undefined) return 'Checking local files...'
  switch (status.state) {
    case 'bundled': return 'Included and ready offline'
    case 'ready': return 'Downloaded and ready offline'
    case 'downloading': return `Downloading locally - ${Math.round((status.progress ?? 0) * 100)}%`
    case 'error': return `${MODEL_CATALOG[status.preset].label} model could not be prepared. Retry the download.`
    default: return 'Not installed'
  }
}

function remoteAsrHealthCopy(health: RemoteAsrHealth): string {
  if (health.ok) return 'Connected. Sotto can reach this server.'
  switch (health.reason) {
    case 'unconfigured': return 'That is not a valid http or https server address.'
    case 'timeout': return 'The server did not answer. Check that it is running and reachable.'
    case 'http': return 'The server answered, but not with a healthy status.'
    default: return 'Sotto could not reach that server.'
  }
}

function parseBoundedInteger(value: string, minimum: number, maximum: number): number | null {
  if (!/^\d+$/u.test(value.trim())) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null
}

function applyThemePreference(theme: Theme): void {
  if (typeof document === 'undefined') return
  if (theme === 'system') delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = theme
}

function applyMotionPreference(reducedMotion: ReducedMotion): void {
  if (typeof document === 'undefined') return
  if (reducedMotion === 'system') delete document.documentElement.dataset.reducedMotion
  else document.documentElement.dataset.reducedMotion = 'on'
}

// The editing form is the one the shortcut input holds, so canonicalization
// round-trips exactly what the user can type.
function canonicalAccelerator(value: string, platform: SottoPlatform): string {
  return parseAccelerator(formatAccelerator(value, platform, 'editing'), platform) ?? value.trim()
}

export function SettingsView({
  settings,
  platform,
  modelStatuses,
  mediaDevices = typeof navigator === 'undefined' ? undefined : navigator.mediaDevices,
  onUpdateSettings,
  onReplaceHotkey,
  onSetStartup,
  onResetSettings,
  onClearHistory,
  onGetModelStatus,
  onListModelDisclosures,
  onInstallModel,
  onRemoveModel,
  onCheckRemoteAsr,
}: SettingsViewProps): ReactNode {
  const [microphones, setMicrophones] = useState<readonly MediaDeviceInfo[]>([])
  const [deviceState, setDeviceState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [hotkeyDraft, setHotkeyDraft] = useState(() => formatAccelerator(settings.hotkey, platform, 'editing'))
  const [pasteDelayDraft, setPasteDelayDraft] = useState(String(settings.pasteDelayMs))
  const [successDurationDraft, setSuccessDurationDraft] = useState(String(settings.successDisplayMs))
  const [pasteDelayError, setPasteDelayError] = useState<string | undefined>()
  const [successDurationError, setSuccessDurationError] = useState<string | undefined>()
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null)
  const [llmApiKeyDraft, setLlmApiKeyDraft] = useState(settings.llmApiKey)
  const [llmDictionaryDraft, setLlmDictionaryDraft] = useState(settings.llmDictionary)
  const [remoteAsrUrlDraft, setRemoteAsrUrlDraft] = useState(settings.remoteAsrUrl)
  const [remoteAsrStatus, setRemoteAsrStatus] = useState<{ text: string; error: boolean } | null>(null)
  const [remoteAsrTesting, setRemoteAsrTesting] = useState(false)
  const [disclosures, setDisclosures] = useState<ModelDisclosureCatalog | null>(null)
  const [disclosureState, setDisclosureState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [installPreset, setInstallPreset] = useState<Exclude<ModelPreset, 'instant'> | null>(null)
  const [installConsent, setInstallConsent] = useState(false)
  const [removePreset, setRemovePreset] = useState<Exclude<ModelPreset, 'instant'> | null>(null)
  const [installFailure, setInstallFailure] = useState<string | null>(null)
  const [removeFailure, setRemoveFailure] = useState<string | null>(null)
  const [clearFailure, setClearFailure] = useState<string | null>(null)
  const [resetFailure, setResetFailure] = useState<string | null>(null)
  const [resetOpen, setResetOpen] = useState(false)
  const [clearOpen, setClearOpen] = useState(false)
  const saveSequenceRef = useRef(0)
  const remoteAsrSequenceRef = useRef(0)
  const themeSequenceRef = useRef(0)
  const motionSequenceRef = useRef(0)
  const settingsRef = useRef(settings)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const hotkeyDraftRef = useRef(hotkeyDraft)
  const hotkeyEditVersionRef = useRef(0)
  const hotkeySubmissionRef = useRef<DraftSubmission<string> | null>(null)
  const hotkeyTokenRef = useRef(0)
  const pasteDelayDraftRef = useRef(pasteDelayDraft)
  const pasteDelayEditVersionRef = useRef(0)
  const pasteDelaySubmissionRef = useRef<DraftSubmission<number> | null>(null)
  const pasteDelayTokenRef = useRef(0)
  const successDurationDraftRef = useRef(successDurationDraft)
  const successDurationEditVersionRef = useRef(0)
  const successDurationSubmissionRef = useRef<DraftSubmission<number> | null>(null)
  const successDurationTokenRef = useRef(0)

  settingsRef.current = settings

  useEffect(() => {
    const submission = hotkeySubmissionRef.current
    if (submission === null) {
      const display = formatAccelerator(settings.hotkey, platform, 'editing')
      hotkeyDraftRef.current = display
      setHotkeyDraft(display)
      return
    }
    const authoritative = canonicalAccelerator(settings.hotkey, platform)
    if (authoritative === submission.submitted) {
      if (hotkeyEditVersionRef.current === submission.editVersion) {
        const display = formatAccelerator(settings.hotkey, platform, 'editing')
        hotkeyDraftRef.current = display
        setHotkeyDraft(display)
      }
      hotkeySubmissionRef.current = null
    } else if (authoritative !== submission.authoritativeAtSubmit) {
      hotkeySubmissionRef.current = null
      const display = formatAccelerator(settings.hotkey, platform, 'editing')
      hotkeyDraftRef.current = display
      setHotkeyDraft(display)
    }
  }, [platform, settings.hotkey])
  useEffect(() => {
    const submission = pasteDelaySubmissionRef.current
    if (submission === null || settings.pasteDelayMs !== submission.authoritativeAtSubmit) {
      if (submission === null || settings.pasteDelayMs !== submission.submitted || pasteDelayEditVersionRef.current === submission.editVersion) {
        const value = String(settings.pasteDelayMs)
        pasteDelayDraftRef.current = value
        setPasteDelayDraft(value)
        setPasteDelayError(undefined)
      }
      if (submission !== null) pasteDelaySubmissionRef.current = null
    }
  }, [settings.pasteDelayMs])
  useEffect(() => {
    const submission = successDurationSubmissionRef.current
    if (submission === null || settings.successDisplayMs !== submission.authoritativeAtSubmit) {
      if (submission === null || settings.successDisplayMs !== submission.submitted || successDurationEditVersionRef.current === submission.editVersion) {
        const value = String(settings.successDisplayMs)
        successDurationDraftRef.current = value
        setSuccessDurationDraft(value)
        setSuccessDurationError(undefined)
      }
      if (submission !== null) successDurationSubmissionRef.current = null
    }
  }, [settings.successDisplayMs])

  useEffect(() => {
    setLlmApiKeyDraft(settings.llmApiKey)
  }, [settings.llmApiKey])
  useEffect(() => {
    setLlmDictionaryDraft(settings.llmDictionary)
  }, [settings.llmDictionary])
  useEffect(() => {
    setRemoteAsrUrlDraft(settings.remoteAsrUrl)
  }, [settings.remoteAsrUrl])

  useEffect(() => {
    if (mediaDevices === undefined) {
      setDeviceState('error')
      return
    }
    let current = true
    let refreshVersion = 0
    const refresh = async (): Promise<void> => {
      const version = ++refreshVersion
      try {
        const devices = await mediaDevices.enumerateDevices()
        if (!current || version !== refreshVersion) return
        setMicrophones(devices.filter((candidate) => candidate.kind === 'audioinput'))
        setDeviceState('ready')
      } catch {
        if (current && version === refreshVersion) setDeviceState('error')
      }
    }
    const onDeviceChange = (): void => { void refresh() }
    void refresh()
    try {
      mediaDevices.addEventListener('devicechange', onDeviceChange)
    } catch {
      // Enumeration still works when device-change observation is unavailable.
    }
    return () => {
      current = false
      try { mediaDevices.removeEventListener('devicechange', onDeviceChange) } catch {
        // Enumeration remains disposable even on older media-device implementations.
      }
    }
  }, [mediaDevices])

  useEffect(() => {
    let current = true
    setDisclosureState('loading')
    void onListModelDisclosures().then(
      (result) => {
        if (!current) return
        if ('models' in result) {
          setDisclosures(result)
          setDisclosureState('ready')
        } else setDisclosureState('error')
      },
      () => { if (current) setDisclosureState('error') },
    )
    for (const preset of ['instant', 'fast'] as const) void onGetModelStatus(preset)
    return () => { current = false }
  }, [onGetModelStatus, onListModelDisclosures])

  const save = useCallback(async (patch: SettingsPatch, successText = 'Setting saved.'): Promise<boolean> => {
    const sequence = ++saveSequenceRef.current
    const saved = await onUpdateSettings(patch).catch(() => false)
    if (sequence === saveSequenceRef.current) setNotice(saved
      ? { text: successText, error: false }
      : { text: 'That setting could not be saved. Your previous setting is still active.', error: true })
    return saved
  }, [onUpdateSettings])

  const savePasteDelay = async (): Promise<void> => {
    const value = parseBoundedInteger(pasteDelayDraftRef.current, 50, 1_000)
    if (value === null) {
      setPasteDelayError('Enter a whole number between 50 and 1000.')
      return
    }
    setPasteDelayError(undefined)
    const submission: DraftSubmission<number> = {
      token: ++pasteDelayTokenRef.current,
      submitted: value,
      authoritativeAtSubmit: settingsRef.current.pasteDelayMs,
      editVersion: pasteDelayEditVersionRef.current,
    }
    pasteDelaySubmissionRef.current = submission
    const saved = await save({ pasteDelayMs: value }, 'Paste delay saved.')
    if (!saved && pasteDelaySubmissionRef.current?.token === submission.token) {
      pasteDelaySubmissionRef.current = null
      if (pasteDelayEditVersionRef.current === submission.editVersion) {
        const authoritative = String(settingsRef.current.pasteDelayMs)
        pasteDelayDraftRef.current = authoritative
        setPasteDelayDraft(authoritative)
      }
    }
  }

  const saveSuccessDuration = async (): Promise<void> => {
    const value = parseBoundedInteger(successDurationDraftRef.current, 500, 5_000)
    if (value === null) {
      setSuccessDurationError('Enter a whole number between 500 and 5000.')
      return
    }
    setSuccessDurationError(undefined)
    const submission: DraftSubmission<number> = {
      token: ++successDurationTokenRef.current,
      submitted: value,
      authoritativeAtSubmit: settingsRef.current.successDisplayMs,
      editVersion: successDurationEditVersionRef.current,
    }
    successDurationSubmissionRef.current = submission
    const saved = await save({ successDisplayMs: value }, 'Success duration saved.')
    if (!saved && successDurationSubmissionRef.current?.token === submission.token) {
      successDurationSubmissionRef.current = null
      if (successDurationEditVersionRef.current === submission.editVersion) {
        const authoritative = String(settingsRef.current.successDisplayMs)
        successDurationDraftRef.current = authoritative
        setSuccessDurationDraft(authoritative)
      }
    }
  }

  // One affordance rather than separate save and test buttons: the address is
  // only useful once it has been saved, and the probe runs against the saved
  // value in the main process.
  const saveAndTestRemoteAsr = async (): Promise<void> => {
    const sequence = ++remoteAsrSequenceRef.current
    const url = remoteAsrUrlDraft.trim()
    setRemoteAsrStatus(null)
    if (url.length === 0) {
      setRemoteAsrStatus({ text: 'Enter a server address first.', error: true })
      return
    }

    setRemoteAsrTesting(true)
    try {
      const saved = url === settingsRef.current.remoteAsrUrl
        || await onUpdateSettings({ remoteAsrUrl: url }).catch(() => false)
      if (sequence !== remoteAsrSequenceRef.current) return
      if (!saved) {
        setRemoteAsrStatus({ text: 'The server address could not be saved.', error: true })
        return
      }
      const health = await onCheckRemoteAsr().catch((): RemoteAsrHealth => ({ ok: false, reason: 'network' }))
      if (sequence !== remoteAsrSequenceRef.current) return
      setRemoteAsrStatus({ text: remoteAsrHealthCopy(health), error: !health.ok })
    } finally {
      if (sequence === remoteAsrSequenceRef.current) setRemoteAsrTesting(false)
    }
  }

  const optionalDisclosure = useCallback((preset: Exclude<ModelPreset, 'instant'>): ModelDisclosure | undefined => (
    disclosures?.models.find((model) => model.preset === preset && !model.bundled)
  ), [disclosures])

  const copy = platformCopy(platform)
  const languageKnown = knownLanguages.some(({ value }) => value === settings.language)
  const microphoneKnown = settings.microphoneId === null || microphones.some(({ deviceId }) => deviceId === settings.microphoneId)

  const saveTheme = async (theme: Theme): Promise<void> => {
    const sequence = ++themeSequenceRef.current
    applyThemePreference(theme)
    const saved = await save({ theme })
    if (sequence === themeSequenceRef.current && !saved) {
      applyThemePreference(settingsRef.current.theme)
    }
  }

  const saveMotion = async (reducedMotion: ReducedMotion): Promise<void> => {
    const sequence = ++motionSequenceRef.current
    applyMotionPreference(reducedMotion)
    const saved = await save({ reducedMotion })
    if (sequence === motionSequenceRef.current && !saved) {
      applyMotionPreference(settingsRef.current.reducedMotion)
    }
  }

  const modelCards = useMemo(() => (['instant', 'fast'] as const).map((preset) => {
    const status = modelStatuses[preset]
    const optional = preset !== 'instant'
    const disclosure = optional ? optionalDisclosure(preset) : undefined
    const selected = settings.modelPreset === preset
    const canInstall = status?.state === 'missing' || status?.state === 'error'
    return (
      <article className="settings-model-card" key={preset} data-selected={selected}>
        <div className="settings-model-card__heading">
          <div><h3>{MODEL_CATALOG[preset].label}</h3><p>{preset === 'instant' ? 'Included, near-instant, English only' : 'Whisper model for non-English speech'}</p></div>
          {selected ? <span className="settings-selected-badge"><Check size={14} />Selected</span> : null}
        </div>
        <p className="settings-model-card__status" aria-live="polite">{modelStateCopy(status)}</p>
        {disclosure === undefined ? null : <p>{bytesLabel(disclosure.totalBytes)} / {disclosure.license}</p>}
        <div className="settings-model-card__actions">
          <Button variant={selected ? 'ghost' : 'secondary'} disabled={!modelReady(status) || selected} onClick={() => void save({ modelPreset: preset }, `${MODEL_CATALOG[preset].label} selected.`)}>Use {MODEL_CATALOG[preset].label}</Button>
          {optional && status?.state !== 'ready' ? <Button disabled={disclosure === undefined || !canInstall} onClick={() => { setInstallFailure(null); setInstallConsent(false); setInstallPreset(preset) }}>Install {MODEL_CATALOG[preset].label}</Button> : null}
          {optional && status?.state === 'ready' ? <Button variant="ghost" onClick={() => { setRemoveFailure(null); setRemovePreset(preset) }}><Trash2 size={15} />Remove {MODEL_CATALOG[preset].label}</Button> : null}
        </div>
      </article>
    )
  }), [modelStatuses, optionalDisclosure, save, settings.modelPreset])

  return (
    <div className="management-view settings-view">
      <h1 className="tt-visually-hidden" ref={headingRef} tabIndex={-1}>Settings</h1>
      {notice === null ? null : <p className="settings-notice" role={notice.error ? 'alert' : 'status'}>{notice.text}</p>}

      <Card className="settings-section">
        <div className="settings-section__heading"><MonitorCog aria-hidden="true" /><div><h2>Appearance</h2><p>Choose how Sotto looks and moves.</p></div></div>
        <div className="settings-fields-grid">
          <Field label="Theme" description={copy.settingsThemeDescription}><Select value={settings.theme} onChange={(event) => void saveTheme(event.currentTarget.value as Theme)}><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></Select></Field>
          <Field label="Reduced motion" description={copy.settingsReducedMotionDescription}><Select value={settings.reducedMotion} onChange={(event) => void saveMotion(event.currentTarget.value as ReducedMotion)}><option value="system">Follow system</option><option value="on">Reduce motion</option></Select></Field>
          <Toggle label="Show floating widget when idle" checked={settings.showWidgetWhenIdle} onCheckedChange={(checked) => void save({ showWidgetWhenIdle: checked })} description="Keep the small dictation sliver on screen between sessions. Click it to dictate." />
        </div>
      </Card>

      <Card className="settings-section">
        <div className="settings-section__heading"><Keyboard aria-hidden="true" /><div><h2>Capture</h2><p>Control the microphone, shortcut, and recording length.</p></div></div>
        <div className="settings-fields-grid">
          <Field label="Microphone" description={deviceState === 'error' ? copy.settingsMicrophoneUnavailable : 'Input used for future recordings.'}>
            <Select value={settings.microphoneId ?? ''} onChange={(event) => void save({ microphoneId: event.currentTarget.value || null })}>
              <option value="">{copy.settingsMicrophoneDefaultOption}</option>
              {!microphoneKnown && settings.microphoneId !== null ? <option value={settings.microphoneId}>Previous microphone (unavailable)</option> : null}
              {microphones.map((microphone, index) => <option key={microphone.deviceId} value={microphone.deviceId}>{microphone.label || `Microphone ${index + 1}`}</option>)}
            </Select>
          </Field>
          <div className="settings-input-action">
            <Field label="Global shortcut" description={copy.settingsGlobalShortcutDescription}>
              <input className="tt-input" value={hotkeyDraft} onChange={(event) => {
                const value = event.currentTarget.value
                hotkeyDraftRef.current = value
                hotkeyEditVersionRef.current += 1
                setHotkeyDraft(value)
              }} />
            </Field>
            <Button variant="secondary" onClick={async () => {
              const candidate = parseAccelerator(hotkeyDraftRef.current, platform)
              if (candidate === null) {
                const display = formatAccelerator(settingsRef.current.hotkey, platform, 'editing')
                hotkeyDraftRef.current = display
                setHotkeyDraft(display)
                setNotice({ text: 'Enter a valid shortcut. Your previous shortcut is still active.', error: true })
                return
              }
              const submission: DraftSubmission<string> = {
                token: ++hotkeyTokenRef.current,
                submitted: candidate,
                authoritativeAtSubmit: canonicalAccelerator(settingsRef.current.hotkey, platform),
                editVersion: hotkeyEditVersionRef.current,
              }
              hotkeySubmissionRef.current = submission
              const result = await onReplaceHotkey(candidate).catch(() => ({ ok: false as const, reason: 'unavailable' as const }))
              if (hotkeySubmissionRef.current?.token !== submission.token) return
              if (result.ok) setNotice({ text: 'Global shortcut updated.', error: false })
              else {
                hotkeySubmissionRef.current = null
                if (hotkeyEditVersionRef.current === submission.editVersion) {
                  const display = formatAccelerator(settingsRef.current.hotkey, platform, 'editing')
                  hotkeyDraftRef.current = display
                  setHotkeyDraft(display)
                }
                setNotice({ text: result.reason === 'conflict' ? 'Another application is already using that shortcut. Your previous shortcut is still active.' : result.reason === 'invalid' ? 'That shortcut is not valid. Your previous shortcut is still active.' : 'The shortcut could not be updated. Your previous shortcut is still active.', error: true })
              }
            }}>Apply shortcut</Button>
          </div>
          <Field label="Maximum recording time" description="Sotto stops automatically at this limit."><Select value={String(settings.maxRecordingSeconds)} onChange={(event) => void save({ maxRecordingSeconds: Number(event.currentTarget.value) as AppSettings['maxRecordingSeconds'] })}><option value="30">30 seconds</option><option value="60">1 minute</option><option value="120">2 minutes</option><option value="300">5 minutes</option></Select></Field>
          <Toggle label="Sound cues" checked={settings.soundCues} onCheckedChange={(checked) => void save({ soundCues: checked })} description="Play a short local sound when recording starts and stops." />
        </div>
      </Card>

      <Card className="settings-section">
        <div className="settings-section__heading"><Gauge aria-hidden="true" /><div><h2>Transcription</h2><p>Balance speed, accuracy, and local hardware use.</p></div></div>
        <div className="settings-model-grid">{modelCards}</div>
        {disclosureState === 'error' ? <p className="settings-inline-warning"><CircleAlert size={16} />{modelReady(modelStatuses.instant) ? 'Optional model details are unavailable. Standard remains ready and no download can start.' : 'Optional model details are unavailable, so no model download can start.'}</p> : null}
        <div className="settings-fields-grid">
          <Field label="Language" description="Automatic currently uses English defaults; choose a language for multilingual speech."><Select value={settings.language} onChange={(event) => void save({ language: event.currentTarget.value })}>{!languageKnown ? <option value={settings.language}>Saved language ({settings.language})</option> : null}{knownLanguages.map((language) => <option key={language.value} value={language.value}>{language.label}</option>)}</Select></Field>
          <Toggle label="Whitespace formatting" checked={settings.formatWhitespace} onCheckedChange={(checked) => void save({ formatWhitespace: checked })} description="Trim and normalize repeated whitespace without changing words." />
          <div className="settings-input-action">
            <Field label="Transcription server" description="Base address of an OpenAI-compatible speech server on your network, such as http://desktop.local:5092.">
              <input className="tt-input" inputMode="url" autoComplete="off" spellCheck={false} placeholder="http://host:port" value={remoteAsrUrlDraft} onChange={(event) => { setRemoteAsrStatus(null); setRemoteAsrUrlDraft(event.currentTarget.value) }} />
            </Field>
            <Button variant="secondary" disabled={remoteAsrTesting} onClick={() => void saveAndTestRemoteAsr()}>{remoteAsrTesting ? 'Testing...' : 'Save and test'}</Button>
          </div>
          <Toggle label="Use the transcription server" checked={settings.remoteAsr} disabled={settings.remoteAsrUrl.trim().length === 0} onCheckedChange={(checked) => void save({ remoteAsr: checked })} description={REMOTE_ASR_PRIVACY_NOTICE} />
        </div>
        {remoteAsrStatus === null ? null : <p className={`settings-remote-status${remoteAsrStatus.error ? ' settings-remote-status--error' : ''}`} role="status">{remoteAsrStatus.error ? <CircleAlert size={16} aria-hidden="true" /> : <Check size={16} aria-hidden="true" />}{remoteAsrStatus.text}</p>}
      </Card>

      <Card className="settings-section">
        <div className="settings-section__heading"><Sparkles aria-hidden="true" /><div><h2>Formatting</h2><p>Optional AI cleanup for punctuation, self-corrections, and tricky words.</p></div></div>
        <div className="settings-fields-grid">
          <Toggle label="AI formatting" checked={settings.llmFormatting} onCheckedChange={(checked) => void save({ llmFormatting: checked })} description="Send transcript text (never audio) to OpenRouter for cleanup. Falls back to the raw transcript if the network is slow or offline." />
          <Field label="Formatting quality" description="Low is near-instant; higher tiers format better but add up to a couple seconds."><Select disabled={!settings.llmFormatting} value={settings.llmQuality} onChange={(event) => void save({ llmQuality: event.currentTarget.value as LlmQuality })}><option value="low">Low — fastest (Mercury 2)</option><option value="medium">Medium (Nova 2 Lite)</option><option value="value">Value — cheap, near-High (GLM-5.3 Flash)</option><option value="high">High — best formatting (Claude Haiku 4.5)</option></Select></Field>
          <div className="settings-input-action">
            <Field label="OpenRouter API key" description="Required for AI formatting. Stored locally in settings.">
              <input className="tt-input" type="password" autoComplete="off" value={llmApiKeyDraft} onChange={(event) => setLlmApiKeyDraft(event.currentTarget.value)} />
            </Field>
            <Button variant="secondary" onClick={() => void save({ llmApiKey: llmApiKeyDraft.trim() }, 'API key saved.')}>Save API key</Button>
          </div>
          <div className="settings-input-action">
            <Field label="Personal dictionary" description="One word or name per line. The AI corrects mis-heard words toward these.">
              <textarea className="tt-input" rows={5} value={llmDictionaryDraft} onChange={(event) => setLlmDictionaryDraft(event.currentTarget.value)} />
            </Field>
            <Button variant="secondary" onClick={() => void save({ llmDictionary: llmDictionaryDraft }, 'Dictionary saved.')}>Save dictionary</Button>
          </div>
          <Toggle label="Streaming transcription" checked={settings.streamingAsr} onCheckedChange={(checked) => void save({ streamingAsr: checked })} description="Transcribe while you speak so long dictations finish almost immediately after you stop." />
        </div>
      </Card>

      <Card className="settings-section">
        <div className="settings-section__heading"><HardDrive aria-hidden="true" /><div><h2>Output</h2><p>Clipboard copy always protects the result when paste is unavailable.</p></div></div>
        <div className="settings-fields-grid">
          <Toggle label="Automatic clipboard copy" checked disabled onCheckedChange={() => undefined} description="Always enabled for every successful non-empty transcript." />
          <Toggle label="Automatic paste" checked={settings.autoPaste} onCheckedChange={(checked) => void save({ autoPaste: checked })} description={copy.settingsAutoPasteDescription} />
          <div className="settings-input-action"><Field label="Paste delay" description="Milliseconds to wait before attempting paste (50-1000)." {...(pasteDelayError === undefined ? {} : { error: pasteDelayError })}><input className="tt-input" inputMode="numeric" value={pasteDelayDraft} onChange={(event) => { const value = event.currentTarget.value; pasteDelayDraftRef.current = value; pasteDelayEditVersionRef.current += 1; setPasteDelayDraft(value) }} /></Field><Button variant="secondary" onClick={() => void savePasteDelay()}>Save paste delay</Button></div>
          <div className="settings-input-action"><Field label="Success message duration" description="Milliseconds the success state remains visible (500-5000)." {...(successDurationError === undefined ? {} : { error: successDurationError })}><input className="tt-input" inputMode="numeric" value={successDurationDraft} onChange={(event) => { const value = event.currentTarget.value; successDurationDraftRef.current = value; successDurationEditVersionRef.current += 1; setSuccessDurationDraft(value) }} /></Field><Button variant="secondary" onClick={() => void saveSuccessDuration()}>Save success duration</Button></div>
        </div>
      </Card>

      <Card className="settings-section">
        <div className="settings-section__heading"><HardDrive aria-hidden="true" /><div><h2>Application and privacy</h2><p>Choose startup behavior and what is retained locally.</p></div></div>
        <div className="settings-fields-grid">
          <Toggle label={copy.settingsLaunchAtStartupLabel} checked={settings.launchAtStartup} onCheckedChange={async (checked) => {
            const result = await onSetStartup(checked).catch(() => null)
            setNotice(result?.enabled === checked ? { text: 'Startup setting saved.', error: false } : { text: copy.settingsStartupFailureNotice, error: true })
          }} />
          <Toggle label="Start minimized" checked={settings.startMinimized} onCheckedChange={(checked) => void save({ startMinimized: checked })} description={copy.settingsStartMinimizedDescription} />
          <Toggle label="Keep local history" checked={settings.historyEnabled} onCheckedChange={(checked) => void save({ historyEnabled: checked })} description="Store transcript text locally for search and reuse." />
          <Field label="History retention" description="Maximum saved entries when history is enabled."><Select disabled={!settings.historyEnabled} value={String(settings.historyRetention)} onChange={(event) => { const value = event.currentTarget.value; void save({ historyRetention: value === 'unlimited' ? 'unlimited' : Number(value) as HistoryRetention }) }}><option value="25">25 entries</option><option value="100">100 entries</option><option value="500">500 entries</option><option value="unlimited">Unlimited</option></Select></Field>
        </div>
        <div className="settings-danger-zone">
          <div><h3>Clear transcript history</h3><p>Remove saved text without changing settings or models.</p></div><Button variant="danger" onClick={() => { setClearFailure(null); setClearOpen(true) }}>Clear history</Button>
          <div><h3>Reset settings</h3><p>Restore defaults and reopen setup. Downloaded models and history remain in place.</p></div><Button variant="secondary" onClick={() => { setResetFailure(null); setResetOpen(true) }}>Reset settings</Button>
        </div>
      </Card>

      {installPreset === null ? null : (() => {
        const disclosure = optionalDisclosure(installPreset)
        if (disclosure === undefined) return null
        const label = MODEL_CATALOG[installPreset].label
        const installStatus = modelStatuses[installPreset]
        const pendingStatus = installStatus?.state === 'downloading'
          ? modelStateCopy(installStatus)
          : installStatus?.state === 'error'
            ? modelStateCopy(installStatus)
            : installStatus !== undefined && modelReady(installStatus)
              ? `${label} is installed and ready offline.`
              : `Preparing the ${label} model download...`
        return <ConfirmationDialog
          title={`Download ${label} model?`}
          description={<div className="settings-download-dialog"><p>{disclosure.repository} / {bytesLabel(disclosure.totalBytes)} / {disclosure.license}</p><p>{disclosures?.optionalDownloadNotice}</p><label><input type="checkbox" checked={installConsent} onChange={(event) => setInstallConsent(event.currentTarget.checked)} />Allow this {label} model download</label></div>}
          cancelLabel="Not now"
          confirmLabel={`Download ${label} model`}
          danger={false}
          confirmDisabled={!installConsent}
          pendingStatus={pendingStatus}
          failureMessage={installFailure ?? `${label} could not be downloaded. Standard is unchanged.`}
          fallbackFocusRef={headingRef}
          onCancel={() => { setInstallConsent(false); setInstallPreset(null) }}
          onConfirm={async () => {
            if (!installConsent) return false
            setInstallFailure(null)
            const result = await onInstallModel({ preset: installPreset, consent: true }).catch(() => ({ ok: false as const, reason: 'unavailable' as const }))
            setInstallConsent(false)
            if (!result.ok) { setInstallFailure(`${label} could not be downloaded. Standard is unchanged.`); return false }
            setNotice({ text: `${label} is installed and ready offline.`, error: false })
            void onGetModelStatus(installPreset)
            return true
          }}
        />
      })()}
      {removePreset === null ? null : <ConfirmationDialog
        title={`Remove ${MODEL_CATALOG[removePreset].label} model?`}
        description="The downloaded files will be removed. Standard always remains installed and ready."
        cancelLabel="Keep model"
        confirmLabel="Remove downloaded model"
        failureMessage={removeFailure ?? 'The downloaded model could not be removed.'}
        fallbackFocusRef={headingRef}
        onCancel={() => setRemovePreset(null)}
        onConfirm={async () => {
          setRemoveFailure(null)
          if (settings.modelPreset === removePreset) {
            if (!modelReady(modelStatuses.instant)) {
              setRemoveFailure('Standard is not ready, so the selected model was not removed.')
              return false
            }
            const switched = await onUpdateSettings({ modelPreset: 'instant' }).catch(() => false)
            if (!switched) { setRemoveFailure('Could not switch to Standard, so the selected model was not removed.'); return false }
          }
          const result = await onRemoveModel(removePreset).catch(() => ({ ok: false as const, reason: 'unavailable' as const }))
          if (!result.ok) { setRemoveFailure('The downloaded model could not be removed.'); return false }
          setNotice({ text: 'Downloaded model removed. Standard remains ready.', error: false })
          void onGetModelStatus(removePreset)
          return true
        }}
      />}
      {!clearOpen ? null : <ConfirmationDialog title="Clear history?" description="This permanently removes every saved transcript. Settings and models are unchanged." cancelLabel="Keep history" confirmLabel="Clear all transcripts" failureMessage={clearFailure ?? 'History could not be cleared.'} fallbackFocusRef={headingRef} onCancel={() => setClearOpen(false)} onConfirm={async () => { setClearFailure(null); const cleared = await onClearHistory().catch(() => false); if (cleared) setNotice({ text: 'Transcript history cleared.', error: false }); else setClearFailure('History could not be cleared. Your saved transcripts are unchanged.'); return cleared }} />}
      {!resetOpen ? null : <ConfirmationDialog title="Reset settings?" description="Defaults will be restored and first-run setup will reopen. Downloaded models and saved history are preserved." cancelLabel="Keep settings" confirmLabel="Reset all settings" failureMessage={resetFailure ?? 'Settings could not be reset.'} fallbackFocusRef={headingRef} onCancel={() => setResetOpen(false)} onConfirm={async () => { setResetFailure(null); const reset = await onResetSettings().catch(() => false); if (reset) setNotice({ text: 'Settings reset to defaults.', error: false }); else setResetFailure('Settings could not be reset. Your current settings are unchanged.'); return reset }} />}
    </div>
  )
}
