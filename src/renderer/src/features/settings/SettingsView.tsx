import React, { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'

import {
  TRANSCRIPTION_PRIVACY_NOTICE,
  UPDATE_CHECK_PRIVACY_NOTICE,
  type HotkeyChangeResult,
  type TranscriptionKeyCheck,
  type StartupState,
  type UpdateStatus,
} from '../../../../shared/contracts'
import { formatAccelerator, parseAccelerator } from '../../../../shared/accelerator'
import type { SottoPlatform } from '../../../../shared/platform'
import type {
  AppSettings,
  HistoryRetention,
  LlmQuality,
  ReducedMotion,
  SettingsPatch,
} from '../../../../shared/settings'
import { Button } from '../../components/Button'
import { Card } from '../../components/Card'
import { ConfirmationDialog } from '../../components/ConfirmationDialog'
import { Field } from '../../components/Field'
import { Select } from '../../components/Select'
import { SegmentedControl } from '../../components/SegmentedControl'
import { Toggle } from '../../components/Toggle'
import { KNOWN_LANGUAGES } from '../../languages'
import { platformCopy } from '../../platformCopy'
import { OpenRouterKeyField } from '../../components/OpenRouterKeyField'
import { AgentSettingsLink } from '../../agents/AgentAccountSettings'
import { ProvidersSettings } from '../../agents/ProvidersSettings'

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
  /** Null until the main process answers; the section still renders. */
  readonly updateStatus: UpdateStatus | null
  readonly mediaDevices?: MediaDevicesAdapter | undefined
  readonly onUpdateSettings: (patch: SettingsPatch) => Promise<boolean>
  readonly onReplaceHotkey: (accelerator: string) => Promise<HotkeyChangeResult>
  readonly onSetStartup: (enabled: boolean) => Promise<StartupState | null>
  readonly onResetSettings: () => Promise<boolean>
  readonly onClearHistory: () => Promise<boolean>
  readonly onCheckTranscriptionKey: () => Promise<TranscriptionKeyCheck>
  readonly onCheckForUpdates: () => Promise<UpdateStatus | null>
  readonly onDownloadUpdate: () => Promise<boolean>
  readonly onInstallUpdate: () => Promise<boolean>
}

const SETTINGS_SECTIONS = [
  { id: 'settings-capture', label: 'Dictation' },
  { id: 'settings-transcription', label: 'Transcription' },
  { id: 'settings-formatting', label: 'Cleanup' },
  { id: 'settings-providers', label: 'Providers' },
  { id: 'settings-output', label: 'Output' },
  { id: 'settings-privacy', label: 'Application' },
  { id: 'settings-agents', label: 'Agents' },
] as const

type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]['id']

function prefersStillMotion(): boolean {
  if (typeof document !== 'undefined' && document.documentElement.dataset.reducedMotion === 'on') return true
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function updateStatusCopy(status: UpdateStatus | null): string {
  if (status === null) return 'Update status is unavailable.'
  switch (status.phase.phase) {
    case 'checking': return 'Asking GitHub...'
    case 'up-to-date': return 'You are on the newest release.'
    case 'available': return `Sotto ${status.phase.version} is available.`
    case 'downloading': return `Downloading ${status.phase.version} - ${status.phase.percent}%`
    case 'downloaded': return `Sotto ${status.phase.version} is downloaded. It installs when you restart.`
    case 'failed': return 'Sotto could not reach GitHub. It will try again later.'
    case 'unsupported': return 'Update checks run only in the installed Windows app.'
    default: return 'Not checked yet.'
  }
}

function parseBoundedInteger(value: string, minimum: number, maximum: number): number | null {
  if (!/^\d+$/u.test(value.trim())) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null
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
  updateStatus,
  mediaDevices = typeof navigator === 'undefined' ? undefined : navigator.mediaDevices,
  onUpdateSettings,
  onReplaceHotkey,
  onSetStartup,
  onResetSettings,
  onClearHistory,
  onCheckTranscriptionKey,
  onCheckForUpdates,
  onDownloadUpdate,
  onInstallUpdate,
}: SettingsViewProps): ReactNode {
  const [microphones, setMicrophones] = useState<readonly MediaDeviceInfo[]>([])
  const [deviceState, setDeviceState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [hotkeyDraft, setHotkeyDraft] = useState(() => formatAccelerator(settings.hotkey, platform, 'editing'))
  const [pasteDelayDraft, setPasteDelayDraft] = useState(String(settings.pasteDelayMs))
  const [successDurationDraft, setSuccessDurationDraft] = useState(String(settings.successDisplayMs))
  const [pasteDelayError, setPasteDelayError] = useState<string | undefined>()
  const [successDurationError, setSuccessDurationError] = useState<string | undefined>()
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null)
  const [llmDictionaryDraft, setLlmDictionaryDraft] = useState(settings.llmDictionary)
  const [updateBusy, setUpdateBusy] = useState(false)
  const [clearFailure, setClearFailure] = useState<string | null>(null)
  const [resetFailure, setResetFailure] = useState<string | null>(null)
  const [resetOpen, setResetOpen] = useState(false)
  const [clearOpen, setClearOpen] = useState(false)
  const saveSequenceRef = useRef(0)
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
    setLlmDictionaryDraft(settings.llmDictionary)
  }, [settings.llmDictionary])
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

  // One busy flag for all three: they are the same button row, and only one of
  // check, download, or restart can sensibly be in flight at a time.
  const runUpdateAction = async (operation: () => Promise<unknown>): Promise<void> => {
    setUpdateBusy(true)
    try {
      await operation().catch(() => undefined)
    } finally {
      setUpdateBusy(false)
    }
  }

  const copy = platformCopy(platform)
  const languageKnown = KNOWN_LANGUAGES.some(({ value }) => value === settings.language)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [activeSection, setActiveSection] = useState<SettingsSectionId>(SETTINGS_SECTIONS[0].id)
  // Scroll-spy for the sub-navigation: the last section whose top has passed
  // the scroller's top edge is the one being read.
  const updateActiveSection = useCallback((): void => {
    const scroller = scrollRef.current
    if (scroller === null) return
    const top = scroller.getBoundingClientRect().top
    const padding = Number.parseFloat(getComputedStyle(scroller).scrollPaddingTop) || 0
    let current: SettingsSectionId = SETTINGS_SECTIONS[0].id
    for (const section of SETTINGS_SECTIONS) {
      const element = scroller.querySelector<HTMLElement>(`#${section.id}`)
      if (element !== null) {
        const margin = Number.parseFloat(getComputedStyle(element).scrollMarginTop) || 0
        if (element.getBoundingClientRect().top <= top + Math.max(24, padding + margin + 1)) current = section.id
      }
    }
    if (scroller.scrollTop > 0 && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2) {
      current = 'settings-agents'
    }
    setActiveSection(current)
  }, [])
  const microphoneKnown = settings.microphoneId === null || microphones.some(({ deviceId }) => deviceId === settings.microphoneId)

  const saveMotion = async (reducedMotion: ReducedMotion): Promise<void> => {
    const sequence = ++motionSequenceRef.current
    applyMotionPreference(reducedMotion)
    const saved = await save({ reducedMotion })
    if (sequence === motionSequenceRef.current && !saved) {
      applyMotionPreference(settingsRef.current.reducedMotion)
    }
  }

  const saveHotkey = async (): Promise<void> => {

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

  }


  const jumpToSection = (id: SettingsSectionId): void => {
    setActiveSection(id)
    const target = scrollRef.current?.querySelector<HTMLElement>(`#${id}`)
    if (target === null || target === undefined) return
    if (typeof target.scrollIntoView === 'function') {
      target.scrollIntoView({ block: 'start', behavior: prefersStillMotion() ? 'auto' : 'smooth' })
    }
  }

  return (
    <div className="management-view settings-view">
      <h1 className="tt-visually-hidden" ref={headingRef} tabIndex={-1}>Settings</h1>
      <div className="settings-layout">
        <nav className="settings-subnav" aria-label="Settings sections">
          {SETTINGS_SECTIONS.map((section) => (
            <a
              key={section.id}
              className="tt-focusable"
              href={`#${section.id}`}
              aria-current={activeSection === section.id ? 'true' : undefined}
              onClick={(event) => { event.preventDefault(); jumpToSection(section.id) }}
            >{section.label}</a>
          ))}
          <p className="settings-version">Sotto {updateStatus?.currentVersion ?? '3.6.0'}<br />{platform === 'darwin' ? 'macOS' : 'Windows'}</p>
        </nav>
        <div className="settings-scroll" ref={scrollRef} onScroll={updateActiveSection}>
          {notice === null ? null : <p className="settings-notice" role={notice.error ? 'alert' : 'status'}>{notice.text}</p>}

          <Card className="settings-section" id="settings-capture">
            <div className="settings-section__heading"><h2>Dictation</h2><p>Sotto listens on <b>{microphones.find(device => device.deviceId === settings.microphoneId)?.label ?? copy.settingsMicrophoneDefaultOption}</b> when you press <b>{formatAccelerator(settings.hotkey, platform, 'editing')}</b>, and stops after <b>{settings.maxRecordingSeconds < 60 ? `${settings.maxRecordingSeconds} seconds` : `${settings.maxRecordingSeconds / 60} ${settings.maxRecordingSeconds === 60 ? 'minute' : 'minutes'}`}</b>.</p></div>
            <div className="settings-rows">
              <Field label="Microphone" description={deviceState === 'error' ? copy.settingsMicrophoneUnavailable : 'Input used for future recordings.'}>
                <Select value={settings.microphoneId ?? ''} onChange={(event) => void save({ microphoneId: event.currentTarget.value || null })}>
                  <option value="">{copy.settingsMicrophoneDefaultOption}</option>
                  {!microphoneKnown && settings.microphoneId !== null ? <option value={settings.microphoneId}>Previous microphone (unavailable)</option> : null}
                  {microphones.map((microphone, index) => <option key={microphone.deviceId} value={microphone.deviceId}>{microphone.label || `Microphone ${index + 1}`}</option>)}
                </Select>
              </Field>
              <div className="settings-input-action">
                <Field label="Global shortcut" description={copy.settingsGlobalShortcutDescription}>
                  <input className="tt-input" value={hotkeyDraft} onBlur={() => void saveHotkey()} onChange={(event) => {
                    const value = event.currentTarget.value
                    hotkeyDraftRef.current = value
                    hotkeyEditVersionRef.current += 1
                    setHotkeyDraft(value)
                  }} />
                </Field>

              </div>
              <Field label="Maximum recording time" description="Sotto stops automatically at this limit."><SegmentedControl label="Maximum recording time" value={String(settings.maxRecordingSeconds)} onChange={value => void save({ maxRecordingSeconds: Number(value) as AppSettings['maxRecordingSeconds'] })} options={[{ value: '30', label: '30 s' }, { value: '60', label: '1 min' }, { value: '120', label: '2 min' }, { value: '300', label: '5 min' }]} /></Field>
              <Toggle label="Sound cues" checked={settings.soundCues} onCheckedChange={(checked) => void save({ soundCues: checked })} description="Play a short local sound when recording starts and stops." />
              <Toggle label="Streaming transcription" checked={settings.streamingAsr} onCheckedChange={(checked) => void save({ streamingAsr: checked })} description="Transcribe while you speak so long dictations finish almost immediately after you stop." />
            </div>
          </Card>

          <Card className="settings-section" id="settings-transcription">
            <div className="settings-section__heading"><h2>Transcription</h2><p>{settings.llmApiKey ? 'Sotto transcribes with the key you saved. Speech goes out to OpenRouter and text comes back.' : 'Sotto cannot transcribe until you add your OpenRouter API key below.'}</p></div>
            <div className="settings-rows">
              <div className="settings-model-statement">
                <h3>MAI-Transcribe-2</h3>
                <p>Microsoft's speech model, and the only one Sotto uses.</p>
              </div>
              <OpenRouterKeyField apiKey={settings.llmApiKey} onUpdateSettings={onUpdateSettings} onCheckTranscriptionKey={onCheckTranscriptionKey} />
              <Field label="Language" description="Choose a language or let the transcription model detect it."><Select value={settings.language} onChange={(event) => void save({ language: event.currentTarget.value })}>{!languageKnown ? <option value={settings.language}>Saved language ({settings.language})</option> : null}{KNOWN_LANGUAGES.map((language) => <option key={language.value} value={language.value}>{language.label}</option>)}</Select></Field>
              <Toggle label="Whitespace formatting" checked={settings.formatWhitespace} onCheckedChange={(checked) => void save({ formatWhitespace: checked })} description="Trim and normalize repeated whitespace without changing words." />
              <p className="settings-disclosure">{TRANSCRIPTION_PRIVACY_NOTICE}</p>
            </div>
          </Card>

          <Card className="settings-section" id="settings-formatting">
            <div className="settings-section__heading"><h2>Cleanup</h2><p>{settings.llmFormatting ? 'AI cleanup is on. Transcript text goes to OpenRouter with your API key.' : 'AI cleanup is off. Your words stay as you dictated them.'}</p></div>
            <div className="settings-rows">
              <Toggle label="AI formatting" checked={settings.llmFormatting} onCheckedChange={(checked) => void save({ llmFormatting: checked })} description="Send transcript text to OpenRouter for cleanup. Falls back to the raw transcript if the network is slow or offline." />
              <Field label="Formatting quality" description="Low is near-instant; higher tiers format better but add up to a couple seconds."><Select disabled={!settings.llmFormatting} value={settings.llmQuality} onChange={(event) => void save({ llmQuality: event.currentTarget.value as LlmQuality })}><option value="low">Low — fastest (Mercury 2)</option><option value="medium">Medium (Nova 2 Lite)</option><option value="value">Value — cheap, near-High (GLM-5.3 Flash)</option><option value="high">High — best formatting (Claude Haiku 4.5)</option></Select></Field>
              <div className="settings-input-action">
                <Field label="Personal dictionary" description="One word or name per line. Sent with your audio as spelling hints, and used to fix mis-heard words during cleanup.">
                  <textarea className="tt-input" rows={5} value={llmDictionaryDraft} onBlur={() => { if (llmDictionaryDraft !== settings.llmDictionary) void save({ llmDictionary: llmDictionaryDraft }, 'Dictionary saved.') }} onChange={(event) => setLlmDictionaryDraft(event.currentTarget.value)} />
                </Field>

              </div>

            </div>
          </Card>

          <Card className="settings-section" id="settings-providers"><div className="settings-section__heading"><h2>Providers</h2></div><ProvidersSettings /></Card>

          <Card className="settings-section" id="settings-output">
            <div className="settings-section__heading"><h2>Output</h2><p>{settings.autoPaste ? 'Sotto copies your words and pastes them at your cursor.' : 'Sotto copies your words so you can paste them yourself.'}</p></div>
            <div className="settings-rows">
              <Toggle label="Automatic clipboard copy" checked disabled onCheckedChange={() => undefined} description="Always enabled for every successful non-empty transcript." />
              <Toggle label="Automatic paste" checked={settings.autoPaste} onCheckedChange={(checked) => void save({ autoPaste: checked })} description={copy.settingsAutoPasteDescription} />
              <div className="settings-input-action"><Field label="Paste delay" description="Milliseconds to wait before attempting paste (50-1000)." {...(pasteDelayError === undefined ? {} : { error: pasteDelayError })}><input className="tt-input" inputMode="numeric" value={pasteDelayDraft} onBlur={() => void savePasteDelay()} onChange={(event) => { const value = event.currentTarget.value; pasteDelayDraftRef.current = value; pasteDelayEditVersionRef.current += 1; setPasteDelayDraft(value) }} /></Field></div>
              <div className="settings-input-action"><Field label="Success message duration" description="Milliseconds the success state remains visible (500-5000)." {...(successDurationError === undefined ? {} : { error: successDurationError })}><input className="tt-input" inputMode="numeric" value={successDurationDraft} onBlur={() => void saveSuccessDuration()} onChange={(event) => { const value = event.currentTarget.value; successDurationDraftRef.current = value; successDurationEditVersionRef.current += 1; setSuccessDurationDraft(value) }} /></Field></div>
            </div>
          </Card>

          <Card className="settings-section" id="settings-privacy">
            <div className="settings-section__heading"><h2>Application</h2><p>{settings.launchAtStartup ? 'Sotto opens when you sign in.' : 'Sotto opens when you launch it.'} {settings.historyEnabled ? 'Transcripts are kept on this computer.' : 'Transcript history is off.'}</p></div>
            <div className="settings-rows">

              <Field label="Reduced motion" description={copy.settingsReducedMotionDescription}><Select value={settings.reducedMotion} onChange={(event) => void saveMotion(event.currentTarget.value as ReducedMotion)}><option value="system">Follow system</option><option value="on">Reduce motion</option></Select></Field>
              <Toggle label="Show floating widget when idle" checked={settings.showWidgetWhenIdle} onCheckedChange={(checked) => void save({ showWidgetWhenIdle: checked })} description="Keep the small dictation sliver on screen between sessions. Click it to dictate." />
            <Toggle label={copy.settingsLaunchAtStartupLabel} checked={settings.launchAtStartup} onCheckedChange={async (checked) => {
                const result = await onSetStartup(checked).catch(() => null)
                setNotice(result?.enabled === checked ? { text: 'Startup setting saved.', error: false } : { text: copy.settingsStartupFailureNotice, error: true })
              }} />
              <Toggle label="Start minimized" checked={settings.startMinimized} onCheckedChange={(checked) => void save({ startMinimized: checked })} description={copy.settingsStartMinimizedDescription} />
              <Toggle label="Keep local history" checked={settings.historyEnabled} onCheckedChange={(checked) => void save({ historyEnabled: checked })} description="Store transcript text locally for search and reuse." />
              <Field label="History retention" description="Maximum saved entries when history is enabled."><Select disabled={!settings.historyEnabled} value={String(settings.historyRetention)} onChange={(event) => { const value = event.currentTarget.value; void save({ historyRetention: value === 'unlimited' ? 'unlimited' : Number(value) as HistoryRetention }) }}><option value="25">25 entries</option><option value="100">100 entries</option><option value="500">500 entries</option><option value="unlimited">Unlimited</option></Select></Field>
            </div>
<div className="settings-updates" id="settings-updates">
            <div className="settings-section__heading"><h2>Updates</h2><p>Sotto looks for new releases on GitHub and installs them itself.</p></div>
            <div className="settings-update-row">
              <div>
                <p className="settings-update-version">{updateStatus === null ? 'Sotto' : `Sotto ${updateStatus.currentVersion}`}</p>
                <p className="settings-update-status" aria-live="polite">{updateStatusCopy(updateStatus)}</p>
              </div>
              <div className="settings-update-actions">
                {updateStatus?.phase.phase === 'available' ? <Button variant="secondary" disabled={updateBusy} onClick={() => void runUpdateAction(onDownloadUpdate)}>Download</Button> : null}
                {updateStatus?.phase.phase === 'downloaded' ? <Button variant="secondary" disabled={updateBusy} onClick={() => void runUpdateAction(onInstallUpdate)}>Restart to update</Button> : null}
                <Button variant="secondary" disabled={updateBusy} onClick={() => void runUpdateAction(onCheckForUpdates)}>{updateBusy ? 'Working...' : 'Check now'}</Button>
              </div>
            </div>
            <div className="settings-rows">
              <Toggle label="Check for updates automatically" checked={settings.autoUpdateCheck} onCheckedChange={(checked) => void save({ autoUpdateCheck: checked })} description={UPDATE_CHECK_PRIVACY_NOTICE} />
            </div>
          </div>

            <div className="settings-danger-row">
              <div><h3>Clear transcript history</h3><p>Remove saved text without changing settings or models.</p></div>
              <Button variant="danger" onClick={() => { setClearFailure(null); setClearOpen(true) }}>Clear history</Button>
            </div>
            <div className="settings-danger-row">
              <div><h3>Reset settings</h3><p>Restore defaults and reopen setup. Downloaded models and history remain in place.</p></div>
              <Button variant="secondary" onClick={() => { setResetFailure(null); setResetOpen(true) }}>Reset settings</Button>
            </div>
          </Card>
          <Card className="settings-section" id="settings-agents"><div className="settings-section__heading"><h2>Agents</h2><p>Choose Sotto’s coordinator for deep reasoning and thread management.</p></div><AgentSettingsLink /></Card>
        </div>
      </div>

      {!clearOpen ? null : <ConfirmationDialog title="Clear history?" description="This permanently removes every saved transcript. Settings are unchanged." cancelLabel="Keep history" confirmLabel="Clear all transcripts" failureMessage={clearFailure ?? 'History could not be cleared.'} fallbackFocusRef={headingRef} onCancel={() => setClearOpen(false)} onConfirm={async () => { setClearFailure(null); const cleared = await onClearHistory().catch(() => false); if (cleared) setNotice({ text: 'Transcript history cleared.', error: false }); else setClearFailure('History could not be cleared. Your saved transcripts are unchanged.'); return cleared }} />}
      {!resetOpen ? null : <ConfirmationDialog title="Reset settings?" description="Defaults will be restored and first-run setup will reopen. Saved history is preserved." cancelLabel="Keep settings" confirmLabel="Reset all settings" failureMessage={resetFailure ?? 'Settings could not be reset.'} fallbackFocusRef={headingRef} onCancel={() => setResetOpen(false)} onConfirm={async () => { setResetFailure(null); const reset = await onResetSettings().catch(() => false); if (reset) setNotice({ text: 'Settings reset to defaults.', error: false }); else setResetFailure('Settings could not be reset. Your current settings are unchanged.'); return reset }} />}
    </div>
  )
}
