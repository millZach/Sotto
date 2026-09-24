import { HostsSettings } from './HostsSettings'
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowUpRight, AudioLines, ChevronRight, Command, Mic, Palette, Server, Settings2, Sparkles, Workflow } from 'lucide-react'

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
  WorktreeCleanupDays,
} from '../../../../shared/settings'
import { GIT_FETCH_INTERVAL_SECONDS, WORKTREE_CLEANUP_DAYS, type GitFetchIntervalSeconds } from '../../../../shared/settings'
import { UPDATES_UNSUPPORTED_MESSAGE } from '../updates/updateControlLogic'
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
import { AgentSetupFields } from '../../agents/AgentAccountSettings'
import { ProvidersSettings } from '../../agents/ProvidersSettings'
import { SidebarFoot, SidebarTop } from '../../agents/SidebarFrame'
import { PageWindowControls } from '../../components/WindowControls'
import { AppearanceSettings } from './AppearanceSettings'
import { GitBehaviourSettings, GitWritingSettings } from './GitSettings'
import { ProjectThreadDefaults } from './ProjectThreadDefaults'
import { VoiceWave } from '../../components/VoiceWave'
import {
  BrowserMicrophoneTest,
  type MicrophoneTestController,
  type MicrophoneTestState,
} from '../onboarding/microphoneTest'

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
  /** The page's sentence, seated at the room's bottom right. */
  readonly statusText?: ReactNode
  /** Null until the main process answers; the section still renders. */
  readonly updateStatus: UpdateStatus | null
  readonly mediaDevices?: MediaDevicesAdapter | undefined
  /** Injected in tests; production runs the same browser test onboarding uses. */
  readonly createMicrophoneTest?: () => MicrophoneTestController
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
  { id: 'settings-capture', label: 'Dictation', icon: Mic },
  { id: 'settings-transcription', label: 'Transcription', icon: AudioLines },
  { id: 'settings-formatting', label: 'Cleanup', icon: Sparkles },
  { id: 'settings-providers', label: 'Providers', icon: Command },
  { id: 'settings-hosts', label: 'Hosts', icon: Server },
  { id: 'settings-agents', label: 'Agents', icon: Workflow },
  { id: 'settings-output', label: 'Output', icon: ArrowUpRight },
  { id: 'settings-appearance', label: 'Appearance', icon: Palette },
  { id: 'settings-privacy', label: 'Application', icon: Settings2 },
] as const

type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]['id']

function updateStatusCopy(status: UpdateStatus | null): string {
  if (status === null) return 'Update status is unavailable.'
  const phase = status.phase
  switch (phase.phase) {
    case 'checking': return 'Asking GitHub...'
    case 'up-to-date': return 'You are on the newest release.'
    case 'available': return phase.problem === null
      ? `Sotto ${phase.version} is available.`
      : `Sotto ${phase.version} could not be downloaded: ${phase.problem}`
    case 'downloading': return `Downloading ${phase.version} - ${phase.percent}%`
    case 'downloaded': return phase.problem === null
      ? `Sotto ${phase.version} is downloaded. Restart to install it.`
      : `Sotto ${phase.version} could not be installed: ${phase.problem}`
    case 'failed': return phase.problem === null
      ? 'Sotto could not reach GitHub. It will try again in a few minutes.'
      : `Sotto could not check for updates: ${phase.problem}`
    case 'unsupported': return UPDATES_UNSUPPORTED_MESSAGE
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
  statusText,
  updateStatus,
  mediaDevices = typeof navigator === 'undefined' ? undefined : navigator.mediaDevices,
  createMicrophoneTest = () => new BrowserMicrophoneTest(),
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
  const [microphoneState, setMicrophoneState] = useState<MicrophoneTestState>('idle')
  const [microphoneLevel, setMicrophoneLevel] = useState(0)
  const microphoneTestRef = useRef<MicrophoneTestController | null>(null)
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

  // The microphone opened here is released when Settings goes away.
  useEffect(() => () => {
    const controller = microphoneTestRef.current
    microphoneTestRef.current = null
    if (controller !== null) void Promise.resolve(controller.stop()).catch(() => undefined)
  }, [])

  /**
   * The same level test onboarding runs. A microphone that reports ready is
   * proof one is set up, so it retires a skip made during setup; any other
   * outcome leaves the skip alone and says what went wrong.
   */
  const runMicrophoneTest = async (): Promise<void> => {
    const previous = microphoneTestRef.current
    microphoneTestRef.current = null
    setMicrophoneLevel(0)
    setMicrophoneState('requesting')
    if (previous !== null) await Promise.resolve(previous.stop()).catch(() => undefined)
    let controller: MicrophoneTestController
    try { controller = createMicrophoneTest() } catch {
      setMicrophoneState('error')
      return
    }
    microphoneTestRef.current = controller
    const outcome = await controller.start((level) => {
      if (microphoneTestRef.current === controller) setMicrophoneLevel(level)
    }).catch(() => 'error' as const)
    if (microphoneTestRef.current !== controller) return
    setMicrophoneState(outcome)
    if (outcome !== 'ready') {
      microphoneTestRef.current = null
      setMicrophoneLevel(0)
      await Promise.resolve(controller.stop()).catch(() => undefined)
      return
    }
    if (settingsRef.current.microphoneSkipped) await onUpdateSettings({ microphoneSkipped: false }).catch(() => false)
  }

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
  // Panels stay mounted so account, key and theme drafts survive category changes.
  // Each visit starts at the heading; the sidebar keeps its own scroll position.
  useLayoutEffect(() => {
    if (scrollRef.current !== null) scrollRef.current.scrollTop = 0
  }, [activeSection])
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


  const selectSection = (id: SettingsSectionId): void => {
    setActiveSection(id)
  }

  const panelProps = (id: SettingsSectionId) => ({
    role: 'tabpanel',
    'aria-labelledby': `tab-${id}`,
    hidden: activeSection !== id,
    tabIndex: 0,
  })

  return (
    <div className="management-view settings-view">
      <div className="settings-layout">
        {/* The rail wears the Threads sidebar's frame: its top row above the sections, its foot below them. */}
        <aside className="settings-sidebar thread-nav">
          <SidebarTop />
          <div className="settings-sidebar__body">
          <h1 ref={headingRef} tabIndex={-1}>Settings</h1>
          <nav className="settings-subnav" aria-label="Settings sections" role="tablist" aria-orientation="vertical">
            {SETTINGS_SECTIONS.map((section, index) => {
              const Icon = section.icon
              return <button
                type="button"
                key={section.id}
                id={`tab-${section.id}`}
                className="tt-focusable"
                role="tab"
                aria-selected={activeSection === section.id}
                aria-controls={section.id === 'settings-appearance' ? 'settings-appearance-panel' : section.id}
                tabIndex={activeSection === section.id ? 0 : -1}
                onClick={() => selectSection(section.id)}
                onKeyDown={(event) => {
                  let next: number
                  if (event.key === 'ArrowDown') next = (index + 1) % SETTINGS_SECTIONS.length
                  else if (event.key === 'ArrowUp') next = (index - 1 + SETTINGS_SECTIONS.length) % SETTINGS_SECTIONS.length
                  else if (event.key === 'Home') next = 0
                  else if (event.key === 'End') next = SETTINGS_SECTIONS.length - 1
                  else return
                  event.preventDefault()
                  const category = SETTINGS_SECTIONS[next]!
                  selectSection(category.id)
                  document.getElementById(`tab-${category.id}`)?.focus()
                }}
              ><Icon size={17} strokeWidth={1.7} aria-hidden="true" /><span>{section.label}</span>{activeSection === section.id ? <ChevronRight size={15} aria-hidden="true" /> : null}</button>
            })}
          </nav>
          </div>
          <SidebarFoot />
        </aside>
        <div className="settings-detail">
          {notice === null ? null : <div className="settings-feedback"><p className="settings-notice" role={notice.error ? 'alert' : 'status'}>{notice.text}</p></div>}
          <div className="settings-scroll" ref={scrollRef}>
            <div className="settings-form">
              <Card className="settings-section" id="settings-capture" {...panelProps('settings-capture')}>
                <div className="settings-section__heading"><h2>Dictation</h2><p>Microphone & recording</p></div>
                <div className="settings-rows">
                  <Field label="Microphone" {...(deviceState === 'error' ? { description: copy.settingsMicrophoneUnavailable } : {})}>
                    <Select value={settings.microphoneId ?? ''} onChange={(event) => void save({ microphoneId: event.currentTarget.value || null })}>
                      <option value="">{copy.settingsMicrophoneDefaultOption}</option>
                      {!microphoneKnown && settings.microphoneId !== null ? <option value={settings.microphoneId}>Previous microphone (unavailable)</option> : null}
                      {microphones.map((microphone, index) => <option key={microphone.deviceId} value={microphone.deviceId}>{microphone.label || `Microphone ${index + 1}`}</option>)}
                    </Select>
                  </Field>
                  <Field label="Microphone test" description="Check that Sotto can hear you. Access is asked for only while the test runs.">
                    <div className="settings-microphone-test" data-state={microphoneState}>
                      {/* The wave the widget and the Dictate room show; it listens for as long as the test's stream runs. */}
                      <VoiceWave stage={microphoneState === 'requesting' || microphoneState === 'ready' ? 'listening' : 'idle'} value={microphoneLevel} label="Microphone level" size="deck" />
                      <p role="status">
                        {microphoneState === 'ready' ? 'Microphone ready.' : null}
                        {microphoneState === 'requesting' ? 'Waiting for microphone permission...' : null}
                        {microphoneState === 'idle' ? (settings.microphoneSkipped ? 'No microphone is set up. Run this test to set one up.' : 'Run a quick input-level test.') : null}
                        {microphoneState === 'denied' ? copy.settingsMicrophoneUnavailable : null}
                        {microphoneState === 'missing' ? 'No microphone was found.' : null}
                        {microphoneState === 'error' ? 'The microphone test could not start.' : null}
                      </p>
                      <Button
                        variant={microphoneState === 'ready' ? 'secondary' : 'primary'}
                        disabled={microphoneState === 'requesting'}
                        onClick={() => void runMicrophoneTest()}
                      >
                        {microphoneState === 'ready' ? 'Retest microphone' : 'Test microphone'}
                      </Button>
                    </div>
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
                  <Field label="Recording limit"><SegmentedControl label="Maximum recording time" value={String(settings.maxRecordingSeconds)} onChange={value => void save({ maxRecordingSeconds: Number(value) as AppSettings['maxRecordingSeconds'] })} options={[{ value: '30', label: '30 s' }, { value: '60', label: '1 min' }, { value: '120', label: '2 min' }, { value: '300', label: '5 min' }]} /></Field>
                  <Toggle label="Sound cues" checked={settings.soundCues} onCheckedChange={(checked) => void save({ soundCues: checked })} description="A short sound when recording starts and stops." />
                  <Toggle label="Streaming transcription" checked={settings.streamingAsr} onCheckedChange={(checked) => void save({ streamingAsr: checked })} description="Transcribe as you speak for a faster finish." />
                </div>
              </Card>

              <Card className="settings-section" id="settings-transcription" {...panelProps('settings-transcription')}>
                <div className="settings-section__heading"><h2>Transcription</h2><p>Language & speech to text</p></div>
                <div className="settings-rows">
                  <div className="settings-model-statement">
                    <h3>MAI-Transcribe-2</h3>
                    <p>Speech recognition by Microsoft.</p>
                  </div>
                  <OpenRouterKeyField apiKey={settings.llmApiKey} onUpdateSettings={onUpdateSettings} onCheckTranscriptionKey={onCheckTranscriptionKey} />
                  <Field label="Language"><Select value={settings.language} onChange={(event) => void save({ language: event.currentTarget.value })}>{!languageKnown ? <option value={settings.language}>Saved language ({settings.language})</option> : null}{KNOWN_LANGUAGES.map((language) => <option key={language.value} value={language.value}>{language.label}</option>)}</Select></Field>
                  <Toggle label="Whitespace formatting" checked={settings.formatWhitespace} onCheckedChange={(checked) => void save({ formatWhitespace: checked })} description="Trim and normalize repeated whitespace without changing words." />
                  <p className="settings-disclosure">{TRANSCRIPTION_PRIVACY_NOTICE}</p>
                </div>
              </Card>

              <Card className="settings-section" id="settings-formatting" {...panelProps('settings-formatting')}>
                <div className="settings-section__heading"><h2>Cleanup</h2><p>Formatting, vocabulary & writing</p></div>
                <div className="settings-rows">
                  <Toggle label="AI formatting" checked={settings.llmFormatting} onCheckedChange={(checked) => void save({ llmFormatting: checked })} description="Send transcript text to OpenRouter for cleanup. Falls back to the raw transcript if the network is slow or offline." />
                  <Field label="Formatting quality" description="Low is near-instant; higher tiers format better but add up to a couple seconds."><Select disabled={!settings.llmFormatting} value={settings.llmQuality} onChange={(event) => void save({ llmQuality: event.currentTarget.value as LlmQuality })}><option value="low">Low — fastest (Mercury 2)</option><option value="medium">Medium (Nova 2 Lite)</option><option value="value">Value — cheap, near-High (GLM-5.3 Flash)</option><option value="high">High — best formatting (Claude Haiku 4.5)</option></Select></Field>
                  <div className="settings-input-action">
                    <Field label="Personal dictionary" description="One word or name per line. Sent as spelling hints with your audio and used during cleanup.">
                      <textarea className="tt-input" rows={5} value={llmDictionaryDraft} onBlur={() => { if (llmDictionaryDraft !== settings.llmDictionary) void save({ llmDictionary: llmDictionaryDraft }, 'Dictionary saved.') }} onChange={(event) => setLlmDictionaryDraft(event.currentTarget.value)} />
                    </Field>

                  </div>
                  <Toggle label="Generated thread titles" checked={settings.threadTitles} onCheckedChange={(checked) => void save({ threadTitles: checked })} description="Ask a thread's own model to name the thread from its first exchange, and a new worktree branch from its first prompt, only while local history is kept. Names you choose are never replaced." />
                  <Toggle label="Generated commit messages" checked={settings.commitMessages} onCheckedChange={(checked) => void save({ commitMessages: checked })} description="Ask the thread's own model to draft a commit message from the staged diff when the commit form opens. Only the staged diff, the repository's recent commit subjects and AGENTS.md, and any custom instructions are sent, and nothing is committed until you press Commit." />
                  <Toggle label="Generated pull request text" checked={settings.pullRequestText} onCheckedChange={(checked) => void save({ pullRequestText: checked })} description="Ask the thread's own model to draft a pull request title and body when the form opens. Only the branch's commit subjects, a capped diff against the base, the pull request template and any custom instructions are sent, and nothing is created until you press Create." />
                  <GitWritingSettings settings={settings} onSave={save} />

                </div>
              </Card>

              <Card className="settings-section" id="settings-providers" {...panelProps('settings-providers')}><div className="settings-section__heading"><h2>Providers</h2><p>Accounts & connections</p></div><ProvidersSettings /></Card>

              <Card className="settings-section" id="settings-hosts" {...panelProps('settings-hosts')}><div className="settings-section__heading"><h2>Hosts</h2><p>Local & remote hosts</p></div><HostsSettings localHostEnabled={settings.localHostEnabled} onLocalHostChange={enabled => onUpdateSettings({ localHostEnabled: enabled })} /></Card>

              <Card className="settings-section" id="settings-agents" {...panelProps('settings-agents')}><div className="settings-section__heading"><h2>Agents</h2><p>{settings.voiceCoordinatorEnabled ? 'Reasoning, voice & projects' : 'Reasoning & projects'}</p></div><AgentSetupFields /></Card>

              <Card className="settings-section" id="settings-output" {...panelProps('settings-output')}>
                <div className="settings-section__heading"><h2>Output</h2><p>Clipboard & automatic paste</p></div>
                <div className="settings-rows">
                  <Toggle label="Automatic clipboard copy" checked disabled onCheckedChange={() => undefined} description="Always enabled for every successful non-empty transcript." />
                  <Toggle label="Automatic paste" checked={settings.autoPaste} onCheckedChange={(checked) => void save({ autoPaste: checked })} description={copy.settingsAutoPasteDescription} />
                  <div className="settings-input-action"><Field label="Paste delay" description="Milliseconds to wait before attempting paste (50-1000)." {...(pasteDelayError === undefined ? {} : { error: pasteDelayError })}><input className="tt-input" inputMode="numeric" value={pasteDelayDraft} onBlur={() => void savePasteDelay()} onChange={(event) => { const value = event.currentTarget.value; pasteDelayDraftRef.current = value; pasteDelayEditVersionRef.current += 1; setPasteDelayDraft(value) }} /></Field></div>
                  <div className="settings-input-action"><Field label="Success message duration" description="Milliseconds the success state remains visible (500-5000)." {...(successDurationError === undefined ? {} : { error: successDurationError })}><input className="tt-input" inputMode="numeric" value={successDurationDraft} onBlur={() => void saveSuccessDuration()} onChange={(event) => { const value = event.currentTarget.value; successDurationDraftRef.current = value; successDurationEditVersionRef.current += 1; setSuccessDurationDraft(value) }} /></Field></div>
                </div>
              </Card>

              <div id="settings-appearance-panel" className="settings-category" {...panelProps('settings-appearance')}><AppearanceSettings settings={settings} platform={platform} onSave={save} getSettings={() => settingsRef.current} /></div>

              <Card className="settings-section" id="settings-privacy" {...panelProps('settings-privacy')}>
                <div className="settings-section__heading"><h2>Application</h2><p>Startup, privacy & updates</p></div>
                <div className="settings-rows">

                  <Field label="Reduced motion" description={copy.settingsReducedMotionDescription}><Select value={settings.reducedMotion} onChange={(event) => void saveMotion(event.currentTarget.value as ReducedMotion)}><option value="system">Follow system</option><option value="on">Reduce motion</option></Select></Field>
                  <Field label="Web links in threads" description="Where a link in a thread opens when you click it. Right-click a link, or press Shift+F10, to choose for that link."><SegmentedControl label="Web links in threads" value={settings.webLinkDestination} onChange={value => void save({ webLinkDestination: value as AppSettings['webLinkDestination'] })} options={[{ value: 'external', label: 'System browser' }, { value: 'embedded', label: 'Sotto browser' }]} /></Field>
                  <Toggle label="Show browser previews" checked={settings.showBrowserPreviews} onCheckedChange={checked => void save({ showBrowserPreviews: checked })} description="Show a small preview of the browser task of the focused thread, or the thread Tools is pinned to, in the corner. When off, browser work still runs and Tools > Browser still shows it." />
                  <Field label="Replies in threads" description="Stream a reply word by word as the agent writes it, or show it once it is finished. Commands and tool calls always appear as they run."><SegmentedControl label="Replies in threads" value={settings.responseStreaming} onChange={value => void save({ responseStreaming: value as AppSettings['responseStreaming'] })} options={[{ value: 'live', label: 'As written' }, { value: 'complete', label: 'When finished' }]} /></Field>
                  <Field label="New threads work in" description="Project defaults can override this. Existing threads keep their working folder."><Select value={settings.threadWorkingCopyDefault} onChange={event => void save({ threadWorkingCopyDefault: event.currentTarget.value as AppSettings['threadWorkingCopyDefault'] })}><option value="shared">Project folder</option><option value="independent">New worktree</option></Select></Field>
                  <Field label="Remove idle worktrees after" description="A thread's own worktree folder goes when the thread has been idle this long. The branch stays and sending puts the folder back. Only a folder with no uncommitted changes and nothing but installed dependencies in its ignored files is removed."><Select value={String(settings.worktreeCleanup.afterDays ?? 'never')} onChange={event => { const value = event.currentTarget.value; void save({ worktreeCleanup: { ...settings.worktreeCleanup, afterDays: value === 'never' ? null : Number(value) as WorktreeCleanupDays } }) }}><option value="never">Never</option>{WORKTREE_CLEANUP_DAYS.map(days => <option key={days} value={String(days)}>{days} days</option>)}</Select></Field>
                  <Toggle label="Remove a worktree when its thread is settled" checked={settings.worktreeCleanup.onSettle} onCheckedChange={checked => void save({ worktreeCleanup: { ...settings.worktreeCleanup, onSettle: checked } })} description="Settle removes a clean worktree folder without asking. A folder with uncommitted changes still asks." />
                  <Toggle label="Remove a worktree once its commits are in the default branch" checked={settings.worktreeCleanup.unchanged} onCheckedChange={checked => void save({ worktreeCleanup: { ...settings.worktreeCleanup, unchanged: checked } })} description="Checked against the local copy of the repository's default branch, once an hour." />
                  <Toggle label="Remove a worktree when its pull request is merged" checked={settings.worktreeCleanup.merged} onCheckedChange={checked => void save({ worktreeCleanup: { ...settings.worktreeCleanup, merged: checked } })} description="Asks GitHub through gh, the way the Changes panel does, once an hour." />
                  <Field label="Git fetch interval" description="How often Sotto fetches a project's origin remote to learn whether a thread's branch is ahead or behind, while this window is in front. Off stops every background fetch; the branch's pull request is then read only when you refresh."><Select value={String(settings.gitFetchIntervalSeconds)} onChange={event => void save({ gitFetchIntervalSeconds: Number(event.currentTarget.value) as GitFetchIntervalSeconds })}>{GIT_FETCH_INTERVAL_SECONDS.map(seconds => <option key={seconds} value={String(seconds)}>{seconds === 0 ? 'Off' : seconds < 60 ? `${seconds} seconds` : seconds === 60 ? '1 minute' : `${seconds / 60} minutes`}</option>)}</Select></Field>
                  <GitBehaviourSettings settings={settings} onSave={save} />
                  <ProjectThreadDefaults settings={settings} onSave={save} />
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
                      {updateStatus?.phase.phase === 'downloaded' ? <Button variant="secondary" disabled={updateBusy} onClick={() => void runUpdateAction(onInstallUpdate)}>Restart and install</Button> : null}
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
            </div>
          </div>
        </div>
      </div>
      <PageWindowControls />
      {statusText ? <p className="page-status">{statusText}</p> : null}

      {!clearOpen ? null : <ConfirmationDialog title="Clear history?" description="This permanently removes every saved transcript. Settings are unchanged." cancelLabel="Keep history" confirmLabel="Clear all transcripts" failureMessage={clearFailure ?? 'History could not be cleared.'} fallbackFocusRef={headingRef} onCancel={() => setClearOpen(false)} onConfirm={async () => { setClearFailure(null); const cleared = await onClearHistory().catch(() => false); if (cleared) setNotice({ text: 'Transcript history cleared.', error: false }); else setClearFailure('History could not be cleared. Your saved transcripts are unchanged.'); return cleared }} />}
      {!resetOpen ? null : <ConfirmationDialog title="Reset settings?" description="Defaults will be restored and first-run setup will reopen. Saved history is preserved." cancelLabel="Keep settings" confirmLabel="Reset all settings" failureMessage={resetFailure ?? 'Settings could not be reset.'} fallbackFocusRef={headingRef} onCancel={() => setResetOpen(false)} onConfirm={async () => { setResetFailure(null); const reset = await onResetSettings().catch(() => false); if (reset) setNotice({ text: 'Settings reset to defaults.', error: false }); else setResetFailure('Settings could not be reset. Your current settings are unchanged.'); return reset }} />}
    </div>
  )
}
