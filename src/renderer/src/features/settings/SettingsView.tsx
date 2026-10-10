import { HostsSettings } from './HostsSettings'
import { PhonesSettings } from './PhonesSettings'
import { useRevisionDraft } from './useRevisionDraft'
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowUpRight, AudioLines, ChevronRight, Cloud, Command, GitBranch, Mic, Palette, Server, Settings2, Smartphone, Sparkles, Workflow } from 'lucide-react'

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
import { WORKTREE_CLEANUP_DAYS } from '../../../../shared/settings'
import { UPDATES_UNSUPPORTED_MESSAGE } from '../updates/updateControlLogic'
import { releaseTrackName } from '../../../../shared/releaseTrack'
import { releaseTrackOf } from '../../state/useReleaseTrack'
import { Button } from '../../components/Button'
import { OpenSystemSettingsButton } from '../../components/OpenSystemSettingsButton'
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
import { CloudIphoneSettings } from './CloudIphoneSettings'
import { GitSettings } from './GitSettings'
import { ProjectThreadDefaults } from './ProjectThreadDefaults'
import { VoiceWave } from '../../components/VoiceWave'
import {
  useAudioInputDevices,
  type MediaDevicesAdapter,
} from '../../audio/useAudioInputDevices'
import {
  MICROPHONE_HEARD_LEVEL,
  WorkletMicrophoneTest,
  type MicrophoneTestController,
  type MicrophoneTestState,
} from '../onboarding/microphoneTest'

export interface SettingsViewProps {
  readonly openRouterKeyMigrationFailed?: boolean
  readonly settings: AppSettings
  readonly platform: SottoPlatform
  /** The page's sentence, seated at the room's bottom right. */
  readonly statusText?: ReactNode
  /** Null until the main process answers; the section still renders. */
  readonly updateStatus: UpdateStatus | null
  readonly mediaDevices?: MediaDevicesAdapter | undefined
  /** Injected in tests; production runs the same browser test onboarding uses. */
  readonly createMicrophoneTest?: () => MicrophoneTestController
  readonly onNotice?: (message: string | null) => void
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
  { id: 'settings-phones', label: 'Phones', icon: Smartphone },
  { id: 'settings-cloud-iphone', label: 'Cloud iPhone', icon: Cloud },
  { id: 'settings-agents', label: 'Agents', icon: Workflow },
  { id: 'settings-output', label: 'Output', icon: ArrowUpRight },
  { id: 'settings-appearance', label: 'Appearance', icon: Palette },
  { id: 'settings-privacy', label: 'Application', icon: Settings2 },
  { id: 'settings-git', label: 'Git', icon: GitBranch },
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
  openRouterKeyMigrationFailed = false,
  platform,
  statusText,
  updateStatus,
  mediaDevices = typeof navigator === 'undefined' ? undefined : navigator.mediaDevices,
  createMicrophoneTest = () => new WorkletMicrophoneTest(),
  onUpdateSettings,
  onNotice,
  onReplaceHotkey,
  onSetStartup,
  onResetSettings,
  onClearHistory,
  onCheckTranscriptionKey,
  onCheckForUpdates,
  onDownloadUpdate,
  onInstallUpdate,
}: SettingsViewProps): ReactNode {
  const [linuxStartupSupported, setLinuxStartupSupported] = useState(false)
  useEffect(() => {
    if (platform !== 'linux') return
    let active = true
    void window.sotto?.getStartup?.().then(state => { if (active) setLinuxStartupSupported(state.supported === true) }).catch(() => undefined)
    return () => { active = false }
  }, [platform])
  const [microphoneId, setMicrophoneId] = useState(settings.microphoneId)
  const [savedMicrophoneId, setSavedMicrophoneId] = useState(settings.microphoneId)
  if (settings.microphoneId !== savedMicrophoneId) {
    setSavedMicrophoneId(settings.microphoneId)
    setMicrophoneId(settings.microphoneId)
  }
  const [microphoneState, setMicrophoneState] = useState<MicrophoneTestState | 'closed'>('idle')
  const [microphoneLevel, setMicrophoneLevel] = useState(0)
  const microphonePeakRef = useRef(0)
  const microphoneTestRef = useRef<MicrophoneTestController | null>(null)
  const microphoneTestGeneration = useRef(0)
  const { devices: microphones, state: deviceState } = useAudioInputDevices(mediaDevices, microphoneState)
  const [pasteDelayError, setPasteDelayError] = useState<string | undefined>()
  const [successDurationError, setSuccessDurationError] = useState<string | undefined>()
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null)
  const hotkeyDraft = useRevisionDraft(canonicalAccelerator(settings.hotkey, platform), formatAccelerator(settings.hotkey, platform, 'editing'))
  const pasteDelayDraft = useRevisionDraft(settings.pasteDelayMs, String(settings.pasteDelayMs), () => setPasteDelayError(undefined))
  const successDurationDraft = useRevisionDraft(settings.successDisplayMs, String(settings.successDisplayMs), () => setSuccessDurationError(undefined))
  const [dictionaryPasteCut, setDictionaryPasteCut] = useState(false)
  const llmDictionaryDraft = useRevisionDraft(settings.llmDictionary, settings.llmDictionary)
  const [updateBusy, setUpdateBusy] = useState(false)
  const [clearFailure, setClearFailure] = useState<string | null>(null)
  const [resetFailure, setResetFailure] = useState<string | null>(null)
  const [resetOpen, setResetOpen] = useState(false)
  const [clearOpen, setClearOpen] = useState(false)
  const saveSequenceRef = useRef(0)
  const microphoneSaveRef = useRef(0)
  const motionSequenceRef = useRef(0)
  const settingsRef = useRef(settings)
  const headingRef = useRef<HTMLHeadingElement>(null)

  settingsRef.current = settings

  const save = useCallback(async (patch: SettingsPatch, successText = 'Setting saved.'): Promise<boolean> => {
    const sequence = ++saveSequenceRef.current
    const saved = await onUpdateSettings(patch).catch(() => false)
    if (sequence === saveSequenceRef.current) setNotice(saved
      ? { text: successText, error: false }
      : { text: 'That setting could not be saved. Your previous setting is still active.', error: true })
    return saved
  }, [onUpdateSettings])

  // A result belongs to one input. A changed selection also invalidates pending permission.
  useEffect(() => {
    setMicrophoneState('idle')
    microphonePeakRef.current = 0
    setMicrophoneLevel(0)
    return () => {
      ++microphoneTestGeneration.current
      const controller = microphoneTestRef.current
      microphoneTestRef.current = null
      if (controller !== null) void Promise.resolve(controller.stop()).catch(() => undefined)
    }
  }, [settings.microphoneId])

  const stopMicrophoneTest = useCallback((): void => {
    ++microphoneTestGeneration.current
    const controller = microphoneTestRef.current
    microphoneTestRef.current = null
    if (controller !== null) void Promise.resolve(controller.stop()).catch(() => undefined)
    setMicrophoneLevel(0)
    setMicrophoneState(state => state === 'ready' ? 'closed' : state === 'requesting' ? 'idle' : state)
  }, [])

  useEffect(() => {
    const onVisibilityChange = (): void => { if (document.hidden) stopMicrophoneTest() }
    document.addEventListener('visibilitychange', onVisibilityChange)
    const unsubscribe = window.sotto?.onWindowHidden?.(stopMicrophoneTest)
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
      unsubscribe?.()
    }
  }, [stopMicrophoneTest])

  /**
   * The same level test onboarding runs. A microphone that reports ready is
   * proof one is set up, so it retires a skip made during setup; any other
   * outcome leaves the skip alone and says what went wrong.
   */
  const runMicrophoneTest = async (): Promise<void> => {
    const generation = ++microphoneTestGeneration.current
    const previous = microphoneTestRef.current
    microphoneTestRef.current = null
    setMicrophoneLevel(0)
    microphonePeakRef.current = 0
    setMicrophoneState('requesting')
    if (previous !== null) await Promise.resolve(previous.stop()).catch(() => undefined)
    if (generation !== microphoneTestGeneration.current || document.hidden) return
    let controller: MicrophoneTestController
    try { controller = createMicrophoneTest() } catch {
      setMicrophoneState('error')
      return
    }
    microphoneTestRef.current = controller
    const selectedDeviceId = microphoneId ?? undefined
    const outcome = await controller.start((level) => {
      if (microphoneTestRef.current !== controller) return
      const safeLevel = Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0
      microphonePeakRef.current = Math.max(microphonePeakRef.current, safeLevel)
      setMicrophoneLevel(safeLevel)
    }, selectedDeviceId, () => {
      if (microphoneTestRef.current !== controller) return
      microphoneTestRef.current = null
      setMicrophoneLevel(0)
      setMicrophoneState('missing')
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

  const dictionarySaveSequenceRef = useRef(0)
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  const saveDictionary = async (announce = true): Promise<void> => {
    const value = llmDictionaryDraft.read()
    if (value.length > 4000) {
      if (announce) setNotice({ text: 'The dictionary could not be saved. Keep it within 4,000 characters.', error: true })
      return
    }
    const submission = llmDictionaryDraft.begin(value, true)
    if (submission === null) return
    const sequence = ++dictionarySaveSequenceRef.current
    const saved = announce
      ? await save({ llmDictionary: value }, 'Dictionary saved.')
      : await onUpdateSettings({ llmDictionary: value }).catch(() => false)
    llmDictionaryDraft.settle(submission, saved, false)
    if (sequence !== dictionarySaveSequenceRef.current) return
    if (saved) onNotice?.(null)
    else if (!mountedRef.current) {
      onNotice?.('Your dictionary edits were not saved. Open Settings, choose Cleanup and enter them again.')
    }
  }

  const saveDictionaryRef = useRef(saveDictionary)
  saveDictionaryRef.current = saveDictionary
  useEffect(() => () => { void saveDictionaryRef.current(false) }, [])

  const savePasteDelay = async (): Promise<void> => {
    const value = parseBoundedInteger(pasteDelayDraft.read(), 50, 1_000)
    if (value === null) {
      setPasteDelayError('Enter a whole number between 50 and 1000.')
      return
    }
    setPasteDelayError(undefined)
    const submission = pasteDelayDraft.begin(value, true)
    if (submission === null) return
    const saved = await save({ pasteDelayMs: value }, 'Paste delay saved.')
    pasteDelayDraft.settle(submission, saved, true)
  }

  const saveSuccessDuration = async (): Promise<void> => {
    const value = parseBoundedInteger(successDurationDraft.read(), 500, 5_000)
    if (value === null) {
      setSuccessDurationError('Enter a whole number between 500 and 5000.')
      return
    }
    setSuccessDurationError(undefined)
    const submission = successDurationDraft.begin(value, true)
    if (submission === null) return
    const saved = await save({ successDisplayMs: value }, 'Success duration saved.')
    successDurationDraft.settle(submission, saved, true)
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
    const candidate = parseAccelerator(hotkeyDraft.read(), platform)
    if (candidate === null) {
      hotkeyDraft.reset()
      setNotice({ text: 'Enter a valid shortcut. Your previous shortcut is still active.', error: true })
      return
    }
    const submission = hotkeyDraft.begin(candidate, true)
    if (submission === null) return
    const result = await onReplaceHotkey(candidate).catch(() => ({ ok: false as const, reason: 'unavailable' as const }))
    const latest = hotkeyDraft.isLatest(submission)
    hotkeyDraft.settle(submission, result.ok, true)
    if (!latest) return
    if (result.ok) setNotice({ text: 'Global shortcut updated.', error: false })
    else {
      setNotice({ text: result.reason === 'conflict' ? 'Another application is already using that shortcut. Your previous shortcut is still active.' : result.reason === 'invalid' ? 'That shortcut is not valid. Your previous shortcut is still active.' : 'The shortcut could not be updated. Your previous shortcut is still active.', error: true })
    }
  }

  const selectSection = (id: SettingsSectionId): void => {
    if (id !== 'settings-capture') stopMicrophoneTest()
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
                    <Select value={microphoneId ?? ''} onChange={(event) => {
                      const next = event.currentTarget.value || null
                      const sequence = ++microphoneSaveRef.current
                      setMicrophoneId(next)
                      void save({ microphoneId: next }).then((saved) => {
                        // The notice says the previous setting is still active; show it.
                        if (!saved && sequence === microphoneSaveRef.current) setMicrophoneId(settingsRef.current.microphoneId)
                      })
                    }}>
                      <option value="">{copy.settingsMicrophoneDefaultOption}</option>
                      {!microphoneKnown && settings.microphoneId !== null ? <option value={settings.microphoneId}>Previous microphone (unavailable)</option> : null}
                      {microphones.map((microphone, index) => <option key={microphone.deviceId} value={microphone.deviceId}>{microphone.label || `Microphone ${index + 1}`}</option>)}
                    </Select>
                  </Field>
                  <Field label="Microphone test" description="Check that Sotto can hear you. Access is asked for only while the test runs.">
                    <div className="settings-microphone-test" data-state={microphoneState}>
                      {/* The wave the widget and the Dictate room show; it listens for as long as the test's stream runs. */}
                      <VoiceWave stage={microphoneState === 'requesting' || microphoneState === 'ready' ? 'listening' : 'idle'} value={microphoneLevel} label="Microphone level" size="deck" holdSpeaking={microphoneState === 'ready'} />
                      <p role="status">
                        {microphoneState === 'ready' ? 'Listening. Say something.' : null}
                        {microphoneState === 'closed' ? microphonePeakRef.current > MICROPHONE_HEARD_LEVEL ? 'Sotto heard you. The microphone is closed.' : 'Sotto did not hear anything. Check that the microphone is not muted.' : null}
                        {microphoneState === 'requesting' ? 'Waiting for microphone permission...' : null}
                        {microphoneState === 'idle' ? (settings.microphoneSkipped ? 'No microphone is set up. Run this test to set one up.' : 'Run a quick input-level test.') : null}
                        {microphoneState === 'denied' ? copy.settingsMicrophoneDenied : null}
                        {microphoneState === 'missing' ? !microphoneKnown && microphones.length > 0 ? 'The chosen microphone is not connected. Plug it in or choose another.' : 'No microphone was found.' : null}
                        {microphoneState === 'error' ? 'The microphone test could not start.' : null}
                      </p>
                      <Button
                        variant={microphoneState === 'closed' ? 'secondary' : 'primary'}
                        disabled={microphoneState === 'requesting'}
                        onClick={() => microphoneState === 'ready' ? stopMicrophoneTest() : void runMicrophoneTest()}
                      >
                        {microphoneState === 'ready' ? 'Stop test' : microphoneState === 'closed' ? 'Test again' : 'Test microphone'}
                      </Button>
                      {microphoneState === 'denied' ? <OpenSystemSettingsButton platform={platform} pane="microphone" /> : null}
                    </div>
                  </Field>
                  <div className="settings-input-action">
                    {platform === 'linux' ? <div className="tt-field">
                      <p className="tt-field__label">Compositor bindings</p>
                      <p className="tt-field__description">{copy.settingsGlobalShortcutDescription}</p>
                    </div> : <Field label="Global shortcut" description={copy.settingsGlobalShortcutDescription}>
                      <input className="tt-input" value={hotkeyDraft.value} onBlur={() => void saveHotkey()} onChange={(event) => {
                        const value = event.currentTarget.value
                        hotkeyDraft.edit(value)
                      }} />
                    </Field>}

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
                  <OpenRouterKeyField migrationFailed={openRouterKeyMigrationFailed} apiKey={settings.llmApiKey} onUpdateSettings={onUpdateSettings} onCheckTranscriptionKey={onCheckTranscriptionKey} />
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
                    <Field label="Personal dictionary" description={`One word or name per line. Sent as spelling hints with your audio and used during cleanup.${llmDictionaryDraft.value.length >= 4000 ? ' 4,000 characters maximum.' : ''}`}>
                      <textarea className="tt-input" rows={5} maxLength={4000} value={llmDictionaryDraft.value} onPaste={(event) => {
                        const input = event.currentTarget
                        const pasted = event.clipboardData.getData('text').replace(/\r\n?/gu, '\n')
                        setDictionaryPasteCut(input.value.length - (input.selectionEnd - input.selectionStart) + pasted.length > input.maxLength)
                      }} onBlur={() => void saveDictionary()} onChange={(event) => {
                        const value = event.currentTarget.value
                        if (value.length < event.currentTarget.maxLength) setDictionaryPasteCut(false)
                        llmDictionaryDraft.edit(value)
                      }} />
                    </Field>
                    <p className="settings-disclosure" role="status">{dictionaryPasteCut ? 'The pasted text was cut to fit the 4,000-character limit.' : ''}</p>

                  </div>
                  <Toggle label="Generated thread titles" checked={settings.threadTitles} onCheckedChange={(checked) => void save({ threadTitles: checked })} description="Name a new thread from the opening words of its first message as soon as you send it, then ask the thread's own model to name it from its first exchange, and a new worktree branch from its first prompt, only while local history is kept. Names you choose are never replaced." />
                  <Toggle label="Generated commit messages" checked={settings.commitMessages} onCheckedChange={(checked) => void save({ commitMessages: checked })} description="When the commit dialog's message is left empty, ask the thread's own model to write it in the Commit and pull request style chosen under Git. It is sent the staged diff, the staged file names, the repository's last twenty commit subjects, its AGENTS.md, and your custom instructions when that style is chosen. Off, the commit takes the subject “Update project files”." />
                  <Toggle label="Generated pull request text" checked={settings.pullRequestText} onCheckedChange={(checked) => void save({ pullRequestText: checked })} description="Ask the thread's own model to write a pull request's title and body when a Git action creates one, in the Commit and pull request style chosen under Git. It is sent the branch's commit subjects and a capped diff against the base, and your custom instructions when that style is chosen; a Git action also sends the changed files, and the repository's pull request template when Sotto finds one and Follow pull request templates is on." />

                </div>
              </Card>

              <Card className="settings-section" id="settings-providers" {...panelProps('settings-providers')}><div className="settings-section__heading"><h2>Providers</h2><p>Accounts & connections</p></div><ProvidersSettings /></Card>

              <Card className="settings-section" id="settings-hosts" {...panelProps('settings-hosts')}><div className="settings-section__heading"><h2>Hosts</h2><p>Local & remote hosts</p></div><HostsSettings localHostEnabled={settings.localHostEnabled} onLocalHostChange={enabled => onUpdateSettings({ localHostEnabled: enabled })} /></Card>

              <Card className="settings-section" id="settings-phones" {...panelProps('settings-phones')}><div className="settings-section__heading"><h2>Phones</h2><p>Sotto on your iPhone, reaching this computer</p></div><PhonesSettings phoneAccess={settings.phoneAccess} phoneAccessName={settings.phoneAccessName} onUpdateSettings={onUpdateSettings}
                onOpenHosts={() => { selectSection('settings-hosts'); document.getElementById('tab-settings-hosts')?.focus() }} /></Card>

              <Card className="settings-section" id="settings-cloud-iphone" {...panelProps('settings-cloud-iphone')}><div className="settings-section__heading"><h2>Cloud iPhone</h2><p>Native iOS builds on a run.cloud simulator</p></div>
                <CloudIphoneSettings settings={settings} onUpdateSettings={onUpdateSettings} /></Card>

              <Card className="settings-section" id="settings-agents" {...panelProps('settings-agents')}><div className="settings-section__heading"><h2>Agents</h2><p>New threads & projects</p></div><AgentSetupFields /></Card>

              <Card className="settings-section" id="settings-output" {...panelProps('settings-output')}>
                <div className="settings-section__heading"><h2>Output</h2><p>Clipboard & automatic paste</p></div>
                <div className="settings-rows">
                  <Toggle label="Automatic clipboard copy" checked disabled onCheckedChange={() => undefined} description="Always enabled for every successful non-empty transcript." />
                  <Toggle label="Automatic paste" checked={settings.autoPaste} onCheckedChange={(checked) => void save({ autoPaste: checked })} description={copy.settingsAutoPasteDescription} />
                  <div className="settings-input-action"><Field label="Paste delay" description="Milliseconds to wait before attempting paste (50-1000)." {...(pasteDelayError === undefined ? {} : { error: pasteDelayError })}><input className="tt-input" inputMode="numeric" value={pasteDelayDraft.value} onBlur={() => void savePasteDelay()} onChange={(event) => { pasteDelayDraft.edit(event.currentTarget.value) }} /></Field></div>
                  <div className="settings-input-action"><Field label="Success message duration" description="Milliseconds the success state remains visible (500-5000)." {...(successDurationError === undefined ? {} : { error: successDurationError })}><input className="tt-input" inputMode="numeric" value={successDurationDraft.value} onBlur={() => void saveSuccessDuration()} onChange={(event) => { successDurationDraft.edit(event.currentTarget.value) }} /></Field></div>
                </div>
              </Card>

              <div id="settings-appearance-panel" className="settings-category" {...panelProps('settings-appearance')}><AppearanceSettings settings={settings} platform={platform} onSave={save} getSettings={() => settingsRef.current} /></div>

              <Card className="settings-section" id="settings-privacy" {...panelProps('settings-privacy')}>
                <div className="settings-section__heading"><h2>Application</h2><p>Startup, privacy & updates</p></div>
                <div className="settings-rows">

                  <Field label="Reduced motion" description={copy.settingsReducedMotionDescription}><Select value={settings.reducedMotion} onChange={(event) => void saveMotion(event.currentTarget.value as ReducedMotion)}><option value="system">Follow system</option><option value="on">Reduce motion</option></Select></Field>
                  <Field label="Web links in threads" description="Where a link in a thread opens when you click it. Right-click a link, or press Shift+F10, to choose for that link."><SegmentedControl label="Web links in threads" value={settings.webLinkDestination} onChange={value => void save({ webLinkDestination: value as AppSettings['webLinkDestination'] })} options={[{ value: 'external', label: 'System browser' }, { value: 'embedded', label: 'Sotto browser' }]} /></Field>
                  <Toggle label="Show the browser when an agent opens a page" checked={settings.showBrowserPreviews} onCheckedChange={checked => void save({ showBrowserPreviews: checked })} description="When an agent opens a page, its thread's browser player opens over the thread, and the test iPhone does the same when an agent uses it. When off, both stay closed and Tools still shows the work." />
                  <Toggle label="Let agents use the browser without asking" checked={settings.browserWithoutAsking} onCheckedChange={checked => void save({ browserWithoutAsking: checked })} description="Agents can open pages, click and type in Sotto's browser without asking first. They can see every page in their thread's browser, including pages you open and sites you are signed in to there. Stop sharing one page, or stop it for one thread, in Tools > Browser." />
                  <Toggle label="Let agents draw visuals in threads" checked={settings.visualsInThreads} onCheckedChange={checked => void save({ visualsInThreads: checked })} description="An agent can draw a diagram, or a small interactive page sealed from the network, in its thread to show how something works. Visuals are made on this computer and contact no one. When off, agents explain in text instead, and visuals already in threads stay." />
                  {/* ADR-0061 decision 12: the switch governs the agent's tool alone; the user's own Babysit pull request stays either way. */}
                  <Toggle label="Let agents babysit pull requests" checked={settings.babysitPullRequests} onCheckedChange={checked => void save({ babysitPullRequests: checked })}
                    description={settings.babysitPullRequests
                      ? 'An agent can ask Sotto to babysit its pull request and stop checking GitHub itself. Sotto sends its thread a wake-up when the pull request needs it.'
                      : 'Agents cannot start babysitting, and Sotto stops what they started. You can still babysit a pull request from the Pull request surface.'} />
                  <Field label="Replies in threads" description="Stream a reply word by word as the agent writes it, or show it once it is finished. Commands and tool calls always appear as they run."><SegmentedControl label="Replies in threads" value={settings.responseStreaming} onChange={value => void save({ responseStreaming: value as AppSettings['responseStreaming'] })} options={[{ value: 'live', label: 'As written' }, { value: 'complete', label: 'When finished' }]} /></Field>
                  <Field label="New threads work in" description="Project defaults can override this. Existing threads keep their working folder."><Select value={settings.threadWorkingCopyDefault} onChange={event => void save({ threadWorkingCopyDefault: event.currentTarget.value as AppSettings['threadWorkingCopyDefault'] })}><option value="shared">Project folder</option><option value="independent">New worktree</option></Select></Field>
                  <Field label="Remove idle worktrees after" description="A thread's own worktree folder goes when the thread has been idle this long. The branch stays and sending puts the folder back. Only a folder with no uncommitted changes and nothing but installed dependencies in its ignored files is removed."><Select value={String(settings.worktreeCleanup.afterDays ?? 'never')} onChange={event => { const value = event.currentTarget.value; void save({ worktreeCleanup: { afterDays: value === 'never' ? null : Number(value) as WorktreeCleanupDays } }) }}><option value="never">Never</option>{WORKTREE_CLEANUP_DAYS.map(days => <option key={days} value={String(days)}>{days} days</option>)}</Select></Field>
                  <Toggle label="Remove a worktree when its thread is settled" checked={settings.worktreeCleanup.onSettle} onCheckedChange={checked => void save({ worktreeCleanup: { onSettle: checked } })} description="Settle removes a clean worktree folder without asking. A folder with uncommitted changes still asks." />
                  <Toggle label="Remove a worktree once its commits are in the default branch" checked={settings.worktreeCleanup.unchanged} onCheckedChange={checked => void save({ worktreeCleanup: { unchanged: checked } })} description="Checked against the local copy of the repository's default branch, once an hour." />
                  <Toggle label="Remove a worktree when its pull request is merged" checked={settings.worktreeCleanup.merged} onCheckedChange={checked => void save({ worktreeCleanup: { merged: checked } })} description="Once an hour, asks GitHub through gh, on your own sign-in, whether the worktree's branch has a merged pull request." />
                  <ProjectThreadDefaults settings={settings} onSave={save} />
                  <Toggle label="Show floating widget when idle" checked={settings.showWidgetWhenIdle} onCheckedChange={(checked) => void save({ showWidgetWhenIdle: checked })} description="Keep the small dictation sliver on screen between sessions. Click it to dictate." />
                  <Toggle label={copy.settingsLaunchAtStartupLabel} checked={settings.launchAtStartup}
                    {...(platform === 'linux' && !linuxStartupSupported ? { disabled: true, description: 'Sotto cannot change sign-in startup here.' } : {})} onCheckedChange={async (checked) => {
                    const result = await onSetStartup(checked).catch(() => null)
                    if (platform === 'linux') setLinuxStartupSupported(result?.supported === true)
                    setNotice(result?.enabled !== checked
                      ? { text: copy.settingsStartupFailureNotice, error: true }
                      : result.approvalRequired === true
                        ? { text: 'Sotto starts at login once you allow it in System Settings > General > Login Items.', error: false }
                        : { text: 'Startup setting saved.', error: false })
                  }} />
                  <Toggle label="Start minimized" checked={settings.startMinimized} onCheckedChange={(checked) => void save({ startMinimized: checked })} description={copy.settingsStartMinimizedDescription} />
                  <Toggle label="Keep local history" checked={settings.historyEnabled} onCheckedChange={(checked) => void save({ historyEnabled: checked })} description="Store transcript text locally for search and reuse. Turning this off also deletes saved checkpoints at once." />
                  <Field label="History retention" description="Maximum saved entries when history is enabled."><Select disabled={!settings.historyEnabled} value={String(settings.historyRetention)} onChange={(event) => { const value = event.currentTarget.value; void save({ historyRetention: value === 'unlimited' ? 'unlimited' : Number(value) as HistoryRetention }) }}><option value="25">25 entries</option><option value="100">100 entries</option><option value="500">500 entries</option><option value="unlimited">Unlimited</option></Select></Field>
                </div>
                <div className="settings-updates" id="settings-updates">
                  <div className="settings-section__heading"><h2>Updates</h2><p>Sotto looks for new releases on GitHub and installs them itself.</p></div>
                  <div className="settings-update-row">
                    <div>
                      <p className="settings-update-version">{updateStatus === null ? 'Sotto' : `${releaseTrackName(releaseTrackOf(updateStatus))} ${updateStatus.currentVersion}`}</p>
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
                  <div><h3>Reset settings</h3><p>Restore defaults and reopen setup. Your saved OpenRouter key, downloaded models and history remain in place.</p></div>
                  <Button variant="secondary" onClick={() => { setResetFailure(null); setResetOpen(true) }}>Reset settings</Button>
                </div>
              </Card>

              <Card className="settings-section" id="settings-git" {...panelProps('settings-git')}>
                <div className="settings-section__heading"><h2>Git</h2><p>Commits, pull requests, Changes & fetching</p></div>
                <GitSettings settings={settings} onSave={save} />
              </Card>
            </div>
          </div>
        </div>
      </div>
      <PageWindowControls />
      {statusText ? <p className="page-status">{statusText}</p> : null}

      {!clearOpen ? null : <ConfirmationDialog title="Clear history?" description="This permanently removes every saved transcript. Settings are unchanged." cancelLabel="Keep history" confirmLabel="Clear all transcripts" failureMessage={clearFailure ?? 'History could not be cleared.'} fallbackFocusRef={headingRef} onCancel={() => setClearOpen(false)} onConfirm={async () => { setClearFailure(null); const cleared = await onClearHistory().catch(() => false); if (cleared) setNotice({ text: 'Transcript history cleared.', error: false }); else setClearFailure('History could not be cleared. Your saved transcripts are unchanged.'); return cleared }} />}
      {!resetOpen ? null : <ConfirmationDialog title="Reset settings?" description="Defaults will be restored and first-run setup will reopen. Your saved OpenRouter key and history are preserved." cancelLabel="Keep settings" confirmLabel="Reset all settings" failureMessage={resetFailure ?? 'Settings could not be reset.'} fallbackFocusRef={headingRef} onCancel={() => setResetOpen(false)} onConfirm={async () => { setResetFailure(null); const reset = await onResetSettings().catch(() => false); if (reset) setNotice({ text: 'Settings reset to defaults.', error: false }); else setResetFailure('Settings could not be reset. Your current settings are unchanged.'); return reset }} />}
    </div>
  )
}
