import React, { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Check, CircleAlert, Gauge, HardDrive, Keyboard, MonitorCog, Trash2 } from 'lucide-react'

import type {
  CommandResult,
  HotkeyChangeResult,
  ModelDisclosure,
  ModelDisclosureCatalog,
  ModelInstallRequest,
  ModelStatus,
  StartupState,
  UnavailableResult,
} from '../../../../shared/contracts'
import { formatWindowsAccelerator, parseWindowsAccelerator } from '../../../../shared/accelerator'
import { MODEL_CATALOG } from '../../../../shared/modelCatalog'
import type {
  AppSettings,
  HistoryRetention,
  InferencePreference,
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

type MediaDevicesAdapter = Pick<MediaDevices, 'enumerateDevices' | 'addEventListener' | 'removeEventListener'>

interface DraftSubmission<T> {
  readonly token: number
  readonly submitted: T
  readonly authoritativeAtSubmit: T
  readonly editVersion: number
}

export interface SettingsViewProps {
  readonly settings: AppSettings
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

function canonicalAccelerator(value: string): string {
  return parseWindowsAccelerator(formatWindowsAccelerator(value)) ?? value.trim()
}

export function SettingsView({
  settings,
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
}: SettingsViewProps): ReactNode {
  const [microphones, setMicrophones] = useState<readonly MediaDeviceInfo[]>([])
  const [deviceState, setDeviceState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [hotkeyDraft, setHotkeyDraft] = useState(() => formatWindowsAccelerator(settings.hotkey))
  const [pasteDelayDraft, setPasteDelayDraft] = useState(String(settings.pasteDelayMs))
  const [successDurationDraft, setSuccessDurationDraft] = useState(String(settings.successDisplayMs))
  const [pasteDelayError, setPasteDelayError] = useState<string | undefined>()
  const [successDurationError, setSuccessDurationError] = useState<string | undefined>()
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null)
  const [disclosures, setDisclosures] = useState<ModelDisclosureCatalog | null>(null)
  const [disclosureState, setDisclosureState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [installPreset, setInstallPreset] = useState<Extract<ModelPreset, 'fast' | 'accurate'> | null>(null)
  const [installConsent, setInstallConsent] = useState(false)
  const [removePreset, setRemovePreset] = useState<Extract<ModelPreset, 'fast' | 'accurate'> | null>(null)
  const [installFailure, setInstallFailure] = useState<string | null>(null)
  const [removeFailure, setRemoveFailure] = useState<string | null>(null)
  const [clearFailure, setClearFailure] = useState<string | null>(null)
  const [resetFailure, setResetFailure] = useState<string | null>(null)
  const [resetOpen, setResetOpen] = useState(false)
  const [clearOpen, setClearOpen] = useState(false)
  const saveSequenceRef = useRef(0)
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
      const display = formatWindowsAccelerator(settings.hotkey)
      hotkeyDraftRef.current = display
      setHotkeyDraft(display)
      return
    }
    const authoritative = canonicalAccelerator(settings.hotkey)
    if (authoritative === submission.submitted) {
      if (hotkeyEditVersionRef.current === submission.editVersion) {
        const display = formatWindowsAccelerator(settings.hotkey)
        hotkeyDraftRef.current = display
        setHotkeyDraft(display)
      }
      hotkeySubmissionRef.current = null
    } else if (authoritative !== submission.authoritativeAtSubmit) {
      hotkeySubmissionRef.current = null
      const display = formatWindowsAccelerator(settings.hotkey)
      hotkeyDraftRef.current = display
      setHotkeyDraft(display)
    }
  }, [settings.hotkey])
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
    for (const preset of ['fast', 'balanced', 'accurate'] as const) void onGetModelStatus(preset)
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

  const optionalDisclosure = useCallback((preset: Extract<ModelPreset, 'fast' | 'accurate'>): ModelDisclosure | undefined => (
    disclosures?.models.find((model) => model.preset === preset && !model.bundled)
  ), [disclosures])

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

  const modelCards = useMemo(() => (['fast', 'balanced', 'accurate'] as const).map((preset) => {
    const status = modelStatuses[preset]
    const optional = preset !== 'balanced'
    const disclosure = optional ? optionalDisclosure(preset) : undefined
    const selected = settings.modelPreset === preset
    const canInstall = status?.state === 'missing' || status?.state === 'error'
    return (
      <article className="settings-model-card" key={preset} data-selected={selected}>
        <div className="settings-model-card__heading">
          <div><h3>{MODEL_CATALOG[preset].label}</h3><p>{preset === 'fast' ? 'Quickest response' : preset === 'balanced' ? 'Best everyday balance' : 'Highest accuracy'}</p></div>
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
        <div className="settings-section__heading"><MonitorCog aria-hidden="true" /><div><h2>Appearance</h2><p>Choose how TalkType looks and moves.</p></div></div>
        <div className="settings-fields-grid">
          <Field label="Theme" description="Follow Windows or force a complete light or dark theme."><Select value={settings.theme} onChange={(event) => void saveTheme(event.currentTarget.value as Theme)}><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></Select></Field>
          <Field label="Reduced motion" description="Follow Windows or minimize non-essential motion."><Select value={settings.reducedMotion} onChange={(event) => void saveMotion(event.currentTarget.value as ReducedMotion)}><option value="system">Follow system</option><option value="on">Reduce motion</option></Select></Field>
          <Toggle label="Show floating widget when idle" checked={settings.showWidgetWhenIdle} onCheckedChange={(checked) => void save({ showWidgetWhenIdle: checked })} description="Keep the small dictation sliver on screen between sessions. Click it to dictate." />
        </div>
      </Card>

      <Card className="settings-section">
        <div className="settings-section__heading"><Keyboard aria-hidden="true" /><div><h2>Capture</h2><p>Control the microphone, shortcut, and recording length.</p></div></div>
        <div className="settings-fields-grid">
          <Field label="Microphone" description={deviceState === 'error' ? 'Microphones are unavailable. Check Windows privacy settings.' : 'Input used for future recordings.'}>
            <Select value={settings.microphoneId ?? ''} onChange={(event) => void save({ microphoneId: event.currentTarget.value || null })}>
              <option value="">Windows default</option>
              {!microphoneKnown && settings.microphoneId !== null ? <option value={settings.microphoneId}>Previous microphone (unavailable)</option> : null}
              {microphones.map((microphone, index) => <option key={microphone.deviceId} value={microphone.deviceId}>{microphone.label || `Microphone ${index + 1}`}</option>)}
            </Select>
          </Field>
          <div className="settings-input-action">
            <Field label="Global shortcut" description="Used anywhere in Windows to start and stop dictation.">
              <input className="tt-input" value={hotkeyDraft} onChange={(event) => {
                const value = event.currentTarget.value
                hotkeyDraftRef.current = value
                hotkeyEditVersionRef.current += 1
                setHotkeyDraft(value)
              }} />
            </Field>
            <Button variant="secondary" onClick={async () => {
              const candidate = parseWindowsAccelerator(hotkeyDraftRef.current)
              if (candidate === null) {
                const display = formatWindowsAccelerator(settingsRef.current.hotkey)
                hotkeyDraftRef.current = display
                setHotkeyDraft(display)
                setNotice({ text: 'Enter a valid shortcut. Your previous shortcut is still active.', error: true })
                return
              }
              const submission: DraftSubmission<string> = {
                token: ++hotkeyTokenRef.current,
                submitted: candidate,
                authoritativeAtSubmit: canonicalAccelerator(settingsRef.current.hotkey),
                editVersion: hotkeyEditVersionRef.current,
              }
              hotkeySubmissionRef.current = submission
              const result = await onReplaceHotkey(candidate).catch(() => ({ ok: false as const, reason: 'unavailable' as const }))
              if (hotkeySubmissionRef.current?.token !== submission.token) return
              if (result.ok) setNotice({ text: 'Global shortcut updated.', error: false })
              else {
                hotkeySubmissionRef.current = null
                if (hotkeyEditVersionRef.current === submission.editVersion) {
                  const display = formatWindowsAccelerator(settingsRef.current.hotkey)
                  hotkeyDraftRef.current = display
                  setHotkeyDraft(display)
                }
                setNotice({ text: result.reason === 'conflict' ? 'Another application is already using that shortcut. Your previous shortcut is still active.' : result.reason === 'invalid' ? 'That shortcut is not valid. Your previous shortcut is still active.' : 'The shortcut could not be updated. Your previous shortcut is still active.', error: true })
              }
            }}>Apply shortcut</Button>
          </div>
          <Field label="Maximum recording time" description="TalkType stops automatically at this limit."><Select value={String(settings.maxRecordingSeconds)} onChange={(event) => void save({ maxRecordingSeconds: Number(event.currentTarget.value) as AppSettings['maxRecordingSeconds'] })}><option value="30">30 seconds</option><option value="60">1 minute</option><option value="120">2 minutes</option><option value="300">5 minutes</option></Select></Field>
          <Toggle label="Sound cues" checked={settings.soundCues} onCheckedChange={(checked) => void save({ soundCues: checked })} description="Play a short local sound when recording starts and stops." />
        </div>
      </Card>

      <Card className="settings-section">
        <div className="settings-section__heading"><Gauge aria-hidden="true" /><div><h2>Transcription</h2><p>Balance speed, accuracy, and local hardware use.</p></div></div>
        <div className="settings-model-grid">{modelCards}</div>
        {disclosureState === 'error' ? <p className="settings-inline-warning"><CircleAlert size={16} />{modelReady(modelStatuses.balanced) ? 'Optional model details are unavailable. Balanced remains ready and no download can start.' : 'Optional model details are unavailable, so no model download can start.'}</p> : null}
        <div className="settings-fields-grid">
          <Field label="Language" description="Automatic currently uses English defaults; choose a language for multilingual speech."><Select value={settings.language} onChange={(event) => void save({ language: event.currentTarget.value })}>{!languageKnown ? <option value={settings.language}>Saved language ({settings.language})</option> : null}{knownLanguages.map((language) => <option key={language.value} value={language.value}>{language.label}</option>)}</Select></Field>
          <Field label="Inference" description="Auto chooses the best available local backend."><Select value={settings.inferencePreference} onChange={(event) => void save({ inferencePreference: event.currentTarget.value as InferencePreference })}><option value="auto">Auto</option><option value="webgpu">Prefer WebGPU</option><option value="wasm">CPU / WASM</option></Select></Field>
          <Toggle label="Whitespace formatting" checked={settings.formatWhitespace} onCheckedChange={(checked) => void save({ formatWhitespace: checked })} description="Trim and normalize repeated whitespace without changing words." />
        </div>
      </Card>

      <Card className="settings-section">
        <div className="settings-section__heading"><HardDrive aria-hidden="true" /><div><h2>Output</h2><p>Clipboard copy always protects the result when paste is unavailable.</p></div></div>
        <div className="settings-fields-grid">
          <Toggle label="Automatic clipboard copy" checked disabled onCheckedChange={() => undefined} description="Always enabled for every successful non-empty transcript." />
          <Toggle label="Automatic paste" checked={settings.autoPaste} onCheckedChange={(checked) => void save({ autoPaste: checked })} description="Best-effort Ctrl+V into the previously focused application." />
          <div className="settings-input-action"><Field label="Paste delay" description="Milliseconds to wait before attempting paste (50-1000)." {...(pasteDelayError === undefined ? {} : { error: pasteDelayError })}><input className="tt-input" inputMode="numeric" value={pasteDelayDraft} onChange={(event) => { const value = event.currentTarget.value; pasteDelayDraftRef.current = value; pasteDelayEditVersionRef.current += 1; setPasteDelayDraft(value) }} /></Field><Button variant="secondary" onClick={() => void savePasteDelay()}>Save paste delay</Button></div>
          <div className="settings-input-action"><Field label="Success message duration" description="Milliseconds the success state remains visible (500-5000)." {...(successDurationError === undefined ? {} : { error: successDurationError })}><input className="tt-input" inputMode="numeric" value={successDurationDraft} onChange={(event) => { const value = event.currentTarget.value; successDurationDraftRef.current = value; successDurationEditVersionRef.current += 1; setSuccessDurationDraft(value) }} /></Field><Button variant="secondary" onClick={() => void saveSuccessDuration()}>Save success duration</Button></div>
        </div>
      </Card>

      <Card className="settings-section">
        <div className="settings-section__heading"><HardDrive aria-hidden="true" /><div><h2>Application and privacy</h2><p>Choose startup behavior and what is retained locally.</p></div></div>
        <div className="settings-fields-grid">
          <Toggle label="Launch when Windows starts" checked={settings.launchAtStartup} onCheckedChange={async (checked) => {
            const result = await onSetStartup(checked).catch(() => null)
            setNotice(result?.enabled === checked ? { text: 'Startup setting saved.', error: false } : { text: 'Windows startup could not be updated.', error: true })
          }} />
          <Toggle label="Start minimized" checked={settings.startMinimized} onCheckedChange={(checked) => void save({ startMinimized: checked })} description="Open directly in the tray when TalkType launches." />
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
          failureMessage={installFailure ?? `${label} could not be downloaded. Balanced is unchanged.`}
          fallbackFocusRef={headingRef}
          onCancel={() => { setInstallConsent(false); setInstallPreset(null) }}
          onConfirm={async () => {
            if (!installConsent) return false
            setInstallFailure(null)
            const result = await onInstallModel({ preset: installPreset, consent: true }).catch(() => ({ ok: false as const, reason: 'unavailable' as const }))
            setInstallConsent(false)
            if (!result.ok) { setInstallFailure(`${label} could not be downloaded. Balanced is unchanged.`); return false }
            setNotice({ text: `${label} is installed and ready offline.`, error: false })
            void onGetModelStatus(installPreset)
            return true
          }}
        />
      })()}
      {removePreset === null ? null : <ConfirmationDialog
        title={`Remove ${MODEL_CATALOG[removePreset].label} model?`}
        description="The downloaded files will be removed. Balanced always remains installed and ready."
        cancelLabel="Keep model"
        confirmLabel="Remove downloaded model"
        failureMessage={removeFailure ?? 'The downloaded model could not be removed.'}
        fallbackFocusRef={headingRef}
        onCancel={() => setRemovePreset(null)}
        onConfirm={async () => {
          setRemoveFailure(null)
          if (settings.modelPreset === removePreset) {
            if (!modelReady(modelStatuses.balanced)) {
              setRemoveFailure('Balanced is not ready, so the selected model was not removed.')
              return false
            }
            const switched = await onUpdateSettings({ modelPreset: 'balanced' }).catch(() => false)
            if (!switched) { setRemoveFailure('Could not switch to Balanced, so the selected model was not removed.'); return false }
          }
          const result = await onRemoveModel(removePreset).catch(() => ({ ok: false as const, reason: 'unavailable' as const }))
          if (!result.ok) { setRemoveFailure('The downloaded model could not be removed.'); return false }
          setNotice({ text: 'Downloaded model removed. Balanced remains ready.', error: false })
          void onGetModelStatus(removePreset)
          return true
        }}
      />}
      {!clearOpen ? null : <ConfirmationDialog title="Clear history?" description="This permanently removes every saved transcript. Settings and models are unchanged." cancelLabel="Keep history" confirmLabel="Clear all transcripts" failureMessage={clearFailure ?? 'History could not be cleared.'} fallbackFocusRef={headingRef} onCancel={() => setClearOpen(false)} onConfirm={async () => { setClearFailure(null); const cleared = await onClearHistory().catch(() => false); if (cleared) setNotice({ text: 'Transcript history cleared.', error: false }); else setClearFailure('History could not be cleared. Your saved transcripts are unchanged.'); return cleared }} />}
      {!resetOpen ? null : <ConfirmationDialog title="Reset settings?" description="Defaults will be restored and first-run setup will reopen. Downloaded models and saved history are preserved." cancelLabel="Keep settings" confirmLabel="Reset all settings" failureMessage={resetFailure ?? 'Settings could not be reset.'} fallbackFocusRef={headingRef} onCancel={() => setResetOpen(false)} onConfirm={async () => { setResetFailure(null); const reset = await onResetSettings().catch(() => false); if (reset) setNotice({ text: 'Settings reset to defaults.', error: false }); else setResetFailure('Settings could not be reset. Your current settings are unchanged.'); return reset }} />}
    </div>
  )
}
