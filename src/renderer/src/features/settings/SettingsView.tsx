import { HostsSettings } from './HostsSettings'
import { PhonesSettings } from './PhonesSettings'
import { DictationShortcuts } from './DictationShortcuts'
import { LinuxDictationShortcuts } from './LinuxDictationShortcuts'
import { useRevisionDraft } from './useRevisionDraft'
import { SettingsFindField, SettingsFindResults } from './SettingsFind'
import { describeSetting, findSettingControl, findSettings, isSettingsSection, revealSetting, settingsIndex, settingsSectionHome, SETTINGS_PAGES, type SettingEntry, type SettingGate, type SettingsPageId, type SettingsSectionId } from './settingsPages'
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { AudioLines, ChevronRight, ClipboardPaste, Cloud, Command, Download, Eye, FolderGit2, Gauge, GitBranch, Globe, History, Keyboard, MessageSquareText, MessagesSquare, Mic, Palette, Power, RotateCcw, Server, Settings2, ShieldCheck, Smartphone, Sparkles, Timer } from 'lucide-react'

import {
  TRANSCRIPTION_PRIVACY_NOTICE,
  UPDATE_CHECK_PRIVACY_NOTICE,
  type DictationShortcutsChange,
  type DictationShortcutsResult,
  type HotkeyChangeResult,
  type OpenRouterKeyCheck,
  type StartupState,
  type UpdateStatus,
} from '../../../../shared/contracts'
import type { SottoPlatform } from '../../../../shared/platform'
import type {
  AppSettings,
  HistoryRetention,
  ReducedMotion,
  SettingsPatch,
} from '../../../../shared/settings'
import { dictationOn, TYPING_SPEED_MAX_WPM, TYPING_SPEED_MIN_WPM } from '../../../../shared/settings'
import { UPDATES_UNSUPPORTED_MESSAGE } from '../updates/updateControlLogic'
import { releaseTrackName } from '../../../../shared/releaseTrack'
import { releaseTrackOf } from '../../state/useReleaseTrack'
import { useHeldProviders, useOwlFeature } from '../../state/owlFeature'
import { requestUpdateAll } from '../updates/UpdateAllCard'
import { Button } from '../../components/Button'
import { OpenSystemSettingsButton } from '../../components/OpenSystemSettingsButton'
import { Card } from '../../components/Card'
import { ConfirmationDialog } from '../../components/ConfirmationDialog'
import { Field } from '../../components/Field'
import { Select } from '../../components/Select'
import { SegmentedControl } from '../../components/SegmentedControl'
import { Toggle } from '../../components/Toggle'
import { SettingsGroup } from './SettingsGroup'
import { NotificationSettings } from './NotificationSettings'
import { useDesktopNotifications } from '../../state/desktopNotifications'
import { formatModelSize, SPEECH_MODEL_REFUSED, SpeechModelStatus as SpeechModelStatusView } from '../../components/SpeechModelStatus'
import { type SpeechModelOption, type SpeechModelStatus } from '../../../../shared/speechModel'
import { platformCopy } from '../../platformCopy'
import { OpenRouterKeyField } from '../../components/OpenRouterKeyField'
import { AgentSetupFields } from '../../agents/AgentAccountSettings'
import { ProvidersSettings } from '../../agents/ProvidersSettings'
import { SidebarFoot, SidebarTop } from '../../agents/SidebarFrame'
import { useSidebarSize } from '../../agents/sidebarSize'
import { PageWindowControls } from '../../components/WindowControls'
import { AppearanceSettings } from './AppearanceSettings'
import { CloudIphoneSettings } from './CloudIphoneSettings'
import { GitSettings } from './GitSettings'
import { ProjectThreadDefaults } from './ProjectThreadDefaults'
import { WorkerRolesSettings } from './WorkerRolesSettings'
import { PerformanceSettings } from '../performance/PerformanceSettings'
import { WatcherOwl } from '../../watcher/WatcherOwl'
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
  /** Owl `dictation-hold-shortcuts`: replaces every dictation shortcut at once. */
  readonly onReplaceDictationShortcuts?: ((change: DictationShortcutsChange) => Promise<DictationShortcutsResult>) | undefined
  readonly onSetStartup: (enabled: boolean) => Promise<StartupState | null>
  readonly onResetSettings: () => Promise<boolean>
  readonly onClearHistory: () => Promise<boolean>
  readonly onCheckOpenRouterKey: () => Promise<OpenRouterKeyCheck>
  /** Where the speech model stands (ADR-0071); null until main answers. */
  readonly speechModel: SpeechModelStatus | null
  /** Starts the speech model download, or retries one that failed. */
  readonly onDownloadSpeechModel: () => void
  /** The speech models Sotto can run on this computer; null until main answers. */
  readonly speechModels?: readonly SpeechModelOption[] | null
  /** Switches dictation to the model with this id. */
  readonly onChooseSpeechModel?: (id: string) => void
  /** True when the last choice was refused because that model is no longer on this computer. */
  readonly speechModelRefused?: boolean
  readonly onCheckForUpdates: () => Promise<UpdateStatus | null>
  readonly onDownloadUpdate: () => Promise<boolean>
  readonly onInstallUpdate: () => Promise<boolean>
  /** Opens Settings at a page or group instead of its first page: an Open Settings press elsewhere (settingsPages.ts). */
  readonly openSection?: { readonly section: SettingsSectionId; readonly key: number } | null
}

type RailIcon = React.ComponentType<{ size?: number; strokeWidth?: number; 'aria-hidden'?: 'true' }>

const PAGE_ICONS: Record<SettingsPageId, RailIcon> = {
  'settings-capture': Mic,
  'settings-formatting': Sparkles,
  'settings-agents': MessagesSquare,
  'settings-git': GitBranch,
  // Watcher, an Owl feature: shown only while the Owl list turns it on. Worker roles (#1041) inside it follow their own.
  'settings-watcher': WatcherNavIcon,
  'settings-providers': Command,
  'settings-hosts': Server,
  'settings-cloud-iphone': Cloud,
  'settings-appearance': Palette,
  'settings-privacy': Settings2,
  // Main's watch on itself (#1233), an Owl feature: shown only while the Owl list turns `main-freeze` on.
  'settings-performance': Gauge,
}

/** The pages that serve dictation alone; they leave the rail while dictation is off (ADR-0107). */
const DICTATION_ONLY_PAGES: ReadonlySet<SettingsPageId> = new Set(['settings-formatting'])

/** The element a page's tab controls: Appearance's card sits inside a panel of its own. */
const panelIdOf = (id: SettingsPageId): string => id === 'settings-appearance' ? 'settings-appearance-panel' : id

/** Watcher's owl at the rail's icon size; the rail passes lucide's props, of which the owl takes only the size. */
function WatcherNavIcon({ size }: { readonly size?: number; readonly strokeWidth?: number; readonly 'aria-hidden'?: 'true' }): ReactNode {
  return <WatcherOwl size={size ?? 17} />
}

/**
 * The two columns. The sections' column is as wide as the Threads sidebar is, whatever the person left it at, so going
 * to Settings and back moves nothing in the frame. A collapsed sidebar has no rail to match: the column keeps the width
 * the sidebar expands to. It is a component of its own so that a window resize redraws this box and not every section in it.
 */
function SettingsLayout({ children }: { readonly children: ReactNode }): ReactNode {
  const { width } = useSidebarSize()
  return <div className="settings-layout" style={{ '--app-sidebar-width': `${width}px` } as CSSProperties}>{children}</div>
}

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
  onReplaceDictationShortcuts,
  onSetStartup,
  onResetSettings,
  onClearHistory,
  onCheckOpenRouterKey,
  speechModel,
  onDownloadSpeechModel,
  speechModels = null,
  onChooseSpeechModel,
  speechModelRefused = false,
  onCheckForUpdates,
  onDownloadUpdate,
  onInstallUpdate,
  openSection = null,
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
  const [typingSpeedError, setTypingSpeedError] = useState<string | undefined>()
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null)
  const pasteDelayDraft = useRevisionDraft(settings.pasteDelayMs, String(settings.pasteDelayMs), () => setPasteDelayError(undefined))
  const successDurationDraft = useRevisionDraft(settings.successDisplayMs, String(settings.successDisplayMs), () => setSuccessDurationError(undefined))
  const typingSpeedDraft = useRevisionDraft(settings.typingSpeedWpm, String(settings.typingSpeedWpm), () => setTypingSpeedError(undefined))
  const [dictionaryPasteCut, setDictionaryPasteCut] = useState(false)
  const llmDictionaryDraft = useRevisionDraft(settings.llmDictionary, settings.llmDictionary)
  const [updateBusy, setUpdateBusy] = useState(false)
  const resumeAfterRestart = useOwlFeature('resume-after-restart')
  const updateAll = useOwlFeature('update-all')
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

  /**
   * The whole-number fields (Paste delay, Success message duration, Typing speed) save the same way: a draft outside
   * its bounds says so and stays unsaved, and a save follows the draft's revision so an older answer never clobbers a
   * newer edit.
   */
  const saveBoundedNumber = async <K extends 'pasteDelayMs' | 'successDisplayMs' | 'typingSpeedWpm'>(
    draft: typeof pasteDelayDraft, key: K, minimum: number, maximum: number,
    setError: (error: string | undefined) => void, notice: string,
  ): Promise<void> => {
    const value = parseBoundedInteger(draft.read(), minimum, maximum)
    if (value === null) {
      setError(`Enter a whole number between ${minimum} and ${maximum}.`)
      return
    }
    setError(undefined)
    const submission = draft.begin(value, true)
    if (submission === null) return
    const saved = await save({ [key]: value } as Pick<AppSettings, K>, notice)
    draft.settle(submission, saved, true)
  }
  const savePasteDelay = (): Promise<void> => saveBoundedNumber(pasteDelayDraft, 'pasteDelayMs', 50, 1_000, setPasteDelayError, 'Paste delay saved.')
  const saveSuccessDuration = (): Promise<void> => saveBoundedNumber(successDurationDraft, 'successDisplayMs', 500, 5_000, setSuccessDurationError, 'Success duration saved.')
  const saveTypingSpeed = (): Promise<void> => saveBoundedNumber(typingSpeedDraft, 'typingSpeedWpm', TYPING_SPEED_MIN_WPM, TYPING_SPEED_MAX_WPM, setTypingSpeedError, 'Typing speed saved.')

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
  const scrollRef = useRef<HTMLDivElement>(null)
  const [activeSection, setActiveSection] = useState<SettingsPageId>(SETTINGS_PAGES[0].id)
  const [findQuery, setFindQuery] = useState('')
  const findInputRef = useRef<HTMLInputElement>(null)
  const findListRef = useRef<HTMLUListElement>(null)
  /** A group or setting to bring into view once its page shows. */
  const [reveal, setReveal] = useState<{ readonly group: string | null; readonly settings: readonly string[]; readonly key: number } | null>(null)
  // Settings, under Watcher, exists only while the Owl list turns Watcher on; its worker roles, only while they are on too.
  const watcherOn = useOwlFeature('watcher'), workerRolesOn = useOwlFeature('worker-roles')
  const workerRoles = watcherOn && workerRolesOn
  const performanceOn = useOwlFeature('main-freeze')
  // Owl `dictation-off`: with dictation off, only the switch stays in Dictation, and its sections leave the rail.
  const dictationSwitch = useOwlFeature('dictation-off')
  const dictation = dictationOn(settings, dictationSwitch)
  const sections = SETTINGS_PAGES.filter(section => (section.id !== 'settings-watcher' || watcherOn) && (section.id !== 'settings-performance' || performanceOn)
    && (dictation || !DICTATION_ONLY_PAGES.has(section.id)))
  const museHeld = useHeldProviders().has('muse')
  const menuBarOwlOn = useOwlFeature('menu-bar-owl')
  const notificationsShown = useDesktopNotifications() !== undefined
  const gates: Record<SettingGate, boolean> = { dictation, 'dictation-off': dictationSwitch, watcher: watcherOn, 'worker-roles': workerRoles, 'main-freeze': performanceOn, 'resume-after-restart': resumeAfterRestart, muse: !museHeld, 'menu-bar-owl': menuBarOwlOn, notifications: notificationsShown }
  // Find a setting reaches only what the page shows now. While it holds text it reads the mounted pages: a setting
  // whose page is not showing it (Providers with the local host off, say) is left out, and what the page says about
  // each one is matched as well as its name.
  const searching = findQuery.trim() !== ''
  const findIndex = settingsIndex(platform).filter(entry => entry.gate === undefined || gates[entry.gate]).flatMap(entry => {
    if (!searching) return [entry]
    const panel = document.getElementById(panelIdOf(settingsSectionHome(entry.section).page))
    const control = panel && findSettingControl(panel, entry.target ?? entry.label)
    if (!control) return panel && entry.fallback && findSettingControl(panel, entry.fallback) ? [entry] : []
    return [{ ...entry, words: `${entry.words ?? ''} ${describeSetting(control)}` }]
  })
  if (!sections.some(section => section.id === activeSection)) setActiveSection('settings-capture')
  useEffect(() => { if (!dictation) stopMicrophoneTest() }, [dictation, stopMicrophoneTest])
  // Panels stay mounted so account, key and theme drafts survive category changes.
  // Each visit starts at the heading; the sidebar keeps its own scroll position.
  useLayoutEffect(() => {
    if (scrollRef.current !== null) scrollRef.current.scrollTop = 0
  }, [activeSection])
  // After the visit's scroll to the top: a group or setting asked for comes into view, a setting with focus on it.
  // Each request is applied once: a later visit to its page must not pull focus back to it.
  const revealedRef = useRef<number | null>(null)
  useLayoutEffect(() => {
    if (reveal === null || revealedRef.current === reveal.key) return
    revealedRef.current = reveal.key
    const panel = document.getElementById(panelIdOf(activeSection))
    // The setting itself, or where it goes while the page is not showing it.
    const control = panel ? reveal.settings.reduce<HTMLElement | null>((found, name) => found ?? findSettingControl(panel, name), null) : null
    const group = reveal.group === null ? null : document.getElementById(reveal.group)
    if (control) revealSetting(control)
    else if (group) group.scrollIntoView?.({ block: 'start' })
  }, [reveal, activeSection])
  const microphoneKnown = settings.microphoneId === null || microphones.some(({ deviceId }) => deviceId === settings.microphoneId)

  const saveMotion = async (reducedMotion: ReducedMotion): Promise<void> => {
    const sequence = ++motionSequenceRef.current
    applyMotionPreference(reducedMotion)
    const saved = await save({ reducedMotion })
    if (sequence === motionSequenceRef.current && !saved) {
      applyMotionPreference(settingsRef.current.reducedMotion)
    }
  }

  const selectSection = (id: SettingsPageId): void => {
    if (id !== 'settings-capture') stopMicrophoneTest()
    setActiveSection(id)
  }

  /** Opens the page a section or setting is on, and brings the group or setting into view. */
  const openAt = (section: SettingsSectionId, settings: readonly string[] = []): void => {
    const home = settingsSectionHome(section)
    const page = sections.some(item => item.id === home.page) ? home.page : 'settings-capture'
    selectSection(page)
    setReveal(previous => ({ group: page === home.page ? home.group : null, settings, key: (previous?.key ?? 0) + 1 }))
  }
  const openRequest = useRef<number | null>(null)
  useEffect(() => {
    if (!openSection || openRequest.current === openSection.key || !isSettingsSection(openSection.section)) return
    openRequest.current = openSection.key
    openAt(openSection.section)
  })
  const openFound = (entry: SettingEntry): void => {
    setFindQuery('')
    openAt(entry.section, [entry.target ?? entry.label, ...entry.fallback ? [entry.fallback] : []])
  }
  const pageLabel = (entry: SettingEntry): string => SETTINGS_PAGES.find(page => page.id === settingsSectionHome(entry.section).page)?.label ?? ''

  const panelProps = (id: SettingsPageId) => ({
    role: 'tabpanel',
    'aria-labelledby': `tab-${id}`,
    hidden: activeSection !== id,
    tabIndex: 0,
  })

  return (
    <div className="management-view settings-view">
      <SettingsLayout>
        {/* The rail wears the Threads sidebar's frame: its top row above the sections, its foot below them. */}
        <aside className={platform === 'darwin' ? 'settings-sidebar thread-nav thread-nav--mac' : 'settings-sidebar thread-nav'}>
          <SidebarTop />
          <div className="settings-sidebar__body">
          <h1 ref={headingRef} tabIndex={-1}>Settings</h1>
          <SettingsFindField query={findQuery} onQueryChange={setFindQuery} inputRef={findInputRef}
            onOpenFirst={() => { const first = findSettings(findIndex, findQuery)[0]; if (first) openFound(first) }}
            onEnterResults={() => findListRef.current?.querySelector('button')?.focus()} />
          {findQuery.trim() ? <SettingsFindResults query={findQuery} index={findIndex} pageOf={pageLabel} onOpen={openFound} listRef={findListRef}
            onLeave={clear => { if (clear) setFindQuery(''); findInputRef.current?.focus() }} /> : null}
          <nav className="settings-subnav" aria-label="Settings sections" role="tablist" aria-orientation="vertical" hidden={findQuery.trim() !== ''}>
            {sections.map((section, index) => {
              const Icon = PAGE_ICONS[section.id]
              return <button
                type="button"
                key={section.id}
                id={`tab-${section.id}`}
                className="tt-focusable"
                role="tab"
                aria-selected={activeSection === section.id}
                aria-controls={panelIdOf(section.id)}
                // A divider opens each run of pages after the first.
                {...(index > 0 && sections[index - 1]!.run !== section.run ? { 'data-run-start': '' } : {})}
                tabIndex={activeSection === section.id ? 0 : -1}
                onClick={() => selectSection(section.id)}
                onKeyDown={(event) => {
                  let next: number
                  if (event.key === 'ArrowDown') next = (index + 1) % sections.length
                  else if (event.key === 'ArrowUp') next = (index - 1 + sections.length) % sections.length
                  else if (event.key === 'Home') next = 0
                  else if (event.key === 'End') next = sections.length - 1
                  else return
                  event.preventDefault()
                  const category = sections[next]!
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
                <div className="settings-section__heading"><h2>Dictation</h2><p>{dictation ? 'Microphone, speech model & what happens to the text' : 'Dictation is off'}</p></div>
                <SettingsGroup title="Microphone" icon={Mic}>
                  {dictationSwitch ? <Toggle label="Dictate with Sotto" checked={settings.dictationEnabled} onCheckedChange={(checked) => void save({ dictationEnabled: checked })} description="Turn off if you use another dictation app. Sotto stops listening for the hotkey and unloads the speech model." /> : null}
                  {dictation ? null : <p className="settings-disclosure">Dictation is off. The hotkey is free for other apps and the Dictate room is hidden. Your transcripts, vocabulary and speech model are kept.</p>}
                  {dictation ? <>
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
                  </> : null}
                </SettingsGroup>
                {dictation ? <>
                <SettingsGroup title="Shortcuts" icon={Keyboard}>
                  {platform === 'linux'
                    ? <LinuxDictationShortcuts settings={settings} visible={activeSection === 'settings-capture'} onReplaceHotkey={onReplaceHotkey} onReplaceDictationShortcuts={onReplaceDictationShortcuts} />
                    : <DictationShortcuts settings={settings} platform={platform} onReplaceHotkey={onReplaceHotkey} onReplaceDictationShortcuts={onReplaceDictationShortcuts} />}
                </SettingsGroup>
                <SettingsGroup title="While you dictate" icon={Timer}>
                  <Field label="Recording limit"><SegmentedControl label="Maximum recording time" value={String(settings.maxRecordingSeconds)} onChange={value => void save({ maxRecordingSeconds: Number(value) as AppSettings['maxRecordingSeconds'] })} options={[{ value: '30', label: '30 s' }, { value: '60', label: '1 min' }, { value: '120', label: '2 min' }, { value: '300', label: '5 min' }]} /></Field>
                  <Toggle label="Sound cues" checked={settings.soundCues} onCheckedChange={(checked) => void save({ soundCues: checked })} description="A short sound when recording starts and stops." />
                  <div className="settings-input-action"><Field label="Typing speed" description={`How fast you type, in words per minute (${TYPING_SPEED_MIN_WPM} to ${TYPING_SPEED_MAX_WPM}). The Dictate room counts the time dictation saves you against it.`} {...(typingSpeedError === undefined ? {} : { error: typingSpeedError })}><input className="tt-input" inputMode="numeric" value={typingSpeedDraft.value} onBlur={() => void saveTypingSpeed()} onChange={(event) => { typingSpeedDraft.edit(event.currentTarget.value) }} /></Field></div>
                  {/* While Omarchy's shell pill stands in for the widget, the switch would change nothing anyone can see. */}
                  <Toggle label="Show floating widget when idle" checked={settings.showWidgetWhenIdle} onCheckedChange={(checked) => void save({ showWidgetWhenIdle: checked })}
                    {...(platform === 'linux' && settings.shellPillInUse === true
                      ? { disabled: true, description: 'On Omarchy, the owl in the bar replaces the widget. Remove the shell plugin to bring it back.' }
                      : { description: 'Keep the small dictation sliver on screen between sessions. Click it to dictate.' })} />
                </SettingsGroup>
                <SettingsGroup id="settings-transcription" title="Speech model" icon={AudioLines}>
                  <SpeechModelPicker
                    models={speechModels}
                    choice={settings.speechModel}
                    status={speechModel}
                    onChoose={onChooseSpeechModel}
                    refused={speechModelRefused}
                    onRetry={onDownloadSpeechModel}
                    platform={platform}
                  />
                  <Toggle label="Whitespace formatting" checked={settings.formatWhitespace} onCheckedChange={(checked) => void save({ formatWhitespace: checked })} description="Trims extra spaces without changing any words." />
                  <p className="settings-disclosure">{TRANSCRIPTION_PRIVACY_NOTICE}</p>
                </SettingsGroup>
                <SettingsGroup id="settings-output" title="After you dictate" icon={ClipboardPaste}>
                  <Toggle label="Automatic clipboard copy" checked disabled onCheckedChange={() => undefined} description="Always on. Every successful transcript is copied." />
                  <Toggle label="Automatic paste" checked={settings.autoPaste} onCheckedChange={(checked) => void save({ autoPaste: checked })} description={copy.settingsAutoPasteDescription} />
                  <div className="settings-input-action"><Field label="Paste delay" description="How long to wait before pasting, in milliseconds (50 to 1000)." {...(pasteDelayError === undefined ? {} : { error: pasteDelayError })}><input className="tt-input" inputMode="numeric" value={pasteDelayDraft.value} onBlur={() => void savePasteDelay()} onChange={(event) => { pasteDelayDraft.edit(event.currentTarget.value) }} /></Field></div>
                  <div className="settings-input-action"><Field label="Success message duration" description="How long the success message stays up, in milliseconds (500 to 5000)." {...(successDurationError === undefined ? {} : { error: successDurationError })}><input className="tt-input" inputMode="numeric" value={successDurationDraft.value} onBlur={() => void saveSuccessDuration()} onChange={(event) => { successDurationDraft.edit(event.currentTarget.value) }} /></Field></div>
                </SettingsGroup>
                </> : null}
              </Card>

              {dictation ? <Card className="settings-section" id="settings-formatting" {...panelProps('settings-formatting')}>
                <div className="settings-section__heading"><h2>Cleanup</h2><p>AI cleanup through OpenRouter</p></div>
                <div className="settings-rows">
                  <Toggle label="AI formatting" checked={settings.llmFormatting} onCheckedChange={(checked) => void save({ llmFormatting: checked })} description="Sends the text, never audio, to OpenRouter to tidy it up. Offline, you get the raw transcript." />
                  <OpenRouterKeyField migrationFailed={openRouterKeyMigrationFailed} apiKey={settings.llmApiKey} onUpdateSettings={onUpdateSettings} onCheckOpenRouterKey={onCheckOpenRouterKey} />
                  <div className="settings-input-action">
                    <Field label="Personal dictionary" description={`One word or name per line, so AI cleanup spells them your way.${llmDictionaryDraft.value.length >= 4000 ? ' 4,000 characters maximum.' : ''}`}>
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
                </div>
              </Card> : null}

              <Card className="settings-section" id="settings-agents" {...panelProps('settings-agents')}>
                <div className="settings-section__heading"><h2>Threads</h2><p>New threads, replies, the browser & visuals</p></div>
                <AgentSetupFields />
                <SettingsGroup title="Working copy" icon={FolderGit2}>
                  <Field label="New threads work in" description="Project defaults below can override this. Existing threads keep their folder."><Select value={settings.threadWorkingCopyDefault} onChange={event => void save({ threadWorkingCopyDefault: event.currentTarget.value as AppSettings['threadWorkingCopyDefault'] })}><option value="shared">Project folder</option><option value="independent">New worktree</option></Select></Field>
                  <ProjectThreadDefaults settings={settings} onSave={save} />
                </SettingsGroup>
                <SettingsGroup title="In a thread" icon={MessageSquareText}>
                  <Field label="Replies in threads" description="Show replies as they are written or once finished. Commands and tool calls always show as they run."><SegmentedControl label="Replies in threads" value={settings.responseStreaming} onChange={value => void save({ responseStreaming: value as AppSettings['responseStreaming'] })} options={[{ value: 'live', label: 'As written' }, { value: 'complete', label: 'When finished' }]} /></Field>
                  <Toggle label="Generated thread titles" checked={settings.threadTitles} onCheckedChange={(checked) => void save({ threadTitles: checked })} description="The thread's own model names new threads from their first exchange, and new worktree branches from their first prompt, while local history is on. Names you choose are kept." />
                  {/* ADR-0076: an Owl feature, read when Sotto next starts. */}
                  {resumeAfterRestart ? <Toggle label="Resume threads after a restart" checked={settings.resumeThreadsAfterRestart} onCheckedChange={checked => void save({ resumeThreadsAfterRestart: checked })}
                    description={settings.resumeThreadsAfterRestart
                      ? 'A thread working when Sotto closes, for an update, a quit, a crash or a restart, carries on when Sotto opens again, with a short note from Sotto in the thread.'
                      : 'A thread working when Sotto closes waits for your next message.'} /> : null}
                </SettingsGroup>
                <SettingsGroup id="settings-browser" title="Links and Sotto’s browser" icon={Globe}>
                  <Field label="Web links in threads" description="Where links in threads open. To choose for one link, right-click it or press Shift+F10."><SegmentedControl label="Web links in threads" value={settings.webLinkDestination} onChange={value => void save({ webLinkDestination: value as AppSettings['webLinkDestination'] })} options={[{ value: 'external', label: 'System browser' }, { value: 'embedded', label: 'Sotto browser' }]} /></Field>
                  <Toggle label="Show the browser when an agent opens a page" checked={settings.showBrowserPreviews} onCheckedChange={checked => void save({ showBrowserPreviews: checked })} description="Opens the browser or test iPhone over the thread when an agent uses it. Off, the work still shows in Tools." />
                </SettingsGroup>
                <SettingsGroup title="What agents can do without asking" icon={ShieldCheck}>
                  <Toggle label="Let agents use the browser without asking" checked={settings.browserWithoutAsking} onCheckedChange={checked => void save({ browserWithoutAsking: checked })} description="Agents can open pages, click and type in Sotto's browser, and see every page there, signed-in sites included. Stop it for a page or thread in Tools > Browser." />
                  <Toggle label="Let agents draw visuals in threads" checked={settings.visualsInThreads} onCheckedChange={checked => void save({ visualsInThreads: checked })} description="Agents can draw diagrams and small interactive pages in a thread. Visuals are made on this computer and never go online." />
                </SettingsGroup>
              </Card>

              <Card className="settings-section" id="settings-git" {...panelProps('settings-git')}>
                <div className="settings-section__heading"><h2>Git & worktrees</h2><p>Worktrees, commits, pull requests, Changes & fetching</p></div>
                <GitSettings settings={settings} onSave={save} />
              </Card>

              {watcherOn ? <Card className="settings-section" id="settings-watcher" {...panelProps('settings-watcher')}>
                <div className="settings-section__heading"><h2>Watcher</h2><p>{workerRoles ? 'How Watcher looks after threads, and what each kind of work runs on' : 'How Watcher looks after threads'}</p></div>
                <SettingsGroup title="Watched threads" icon={Eye}>
                  <Toggle label="Settle finished threads" checked={settings.watcherSettlesFinishedThreads} onCheckedChange={checked => void save({ watcherSettlesFinishedThreads: checked })}
                    description="Watcher settles a thread it watches once its work is done: nothing running or waiting on you, and every pull request merged or closed. Then it stops watching it." />
                </SettingsGroup>
                {workerRoles ? <WorkerRolesSettings settings={settings} platform={platform} onUpdateSettings={onUpdateSettings}
                  onOpenSection={id => { selectSection(id); document.getElementById(`tab-${id}`)?.focus() }} /> : null}</Card> : null}

              <Card className="settings-section" id="settings-providers" {...panelProps('settings-providers')}><div className="settings-section__heading"><h2>Providers</h2><p>Accounts & connections</p></div><ProvidersSettings /></Card>

              <Card className="settings-section" id="settings-hosts" {...panelProps('settings-hosts')}>
                <div className="settings-section__heading"><h2>Hosts & phones</h2><p>This computer, other computers, and your iPhone</p></div>
                <HostsSettings localHostEnabled={settings.localHostEnabled} onLocalHostChange={enabled => onUpdateSettings({ localHostEnabled: enabled })} />
                <SettingsGroup id="settings-phones" title="Phones" icon={Smartphone} rows={false}>
                  {/* Run the local host is on this page, above: the press brings it into view with focus on it. */}
                  <PhonesSettings phoneAccess={settings.phoneAccess} phoneAccessName={settings.phoneAccessName} onUpdateSettings={onUpdateSettings}
                    onOpenHosts={() => { const panel = document.getElementById('settings-hosts'); const control = panel && findSettingControl(panel, 'Run the local host'); if (control) revealSetting(control) }} />
                </SettingsGroup>
              </Card>

              <Card className="settings-section" id="settings-cloud-iphone" {...panelProps('settings-cloud-iphone')}><div className="settings-section__heading"><h2>Cloud iPhone</h2><p>Native iOS builds on a run.cloud simulator</p></div>
                <CloudIphoneSettings settings={settings} onUpdateSettings={onUpdateSettings} /></Card>

              <div id="settings-appearance-panel" className="settings-category" {...panelProps('settings-appearance')}>
                <AppearanceSettings settings={settings} platform={platform} onSave={save} getSettings={() => settingsRef.current}>
                  <Field label="Reduced motion" description={copy.settingsReducedMotionDescription}><Select value={settings.reducedMotion} onChange={(event) => void saveMotion(event.currentTarget.value as ReducedMotion)}><option value="system">Follow system</option><option value="on">Reduce motion</option></Select></Field>
                </AppearanceSettings>
              </div>

              <Card className="settings-section" id="settings-privacy" {...panelProps('settings-privacy')}>
                <div className="settings-section__heading"><h2>Application</h2><p>Startup, history, updates & reset</p></div>
                <SettingsGroup title="When your computer starts" icon={Power}>
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
                </SettingsGroup>
                <SettingsGroup id="settings-history" title="History" icon={History}>
                  <Toggle label="Keep local history" checked={settings.historyEnabled} onCheckedChange={(checked) => void save({ historyEnabled: checked })} description="Saves transcripts on this computer to search and reuse. With it off, Sotto saves no text but still keeps each dictation's time, length, word count and app name. Turning it off deletes saved checkpoints right away." />
                  <Field label="History retention" description="How many transcripts to keep."><Select disabled={!settings.historyEnabled} value={String(settings.historyRetention)} onChange={(event) => { const value = event.currentTarget.value; void save({ historyRetention: value === 'unlimited' ? 'unlimited' : Number(value) as HistoryRetention }) }}><option value="25">25 entries</option><option value="100">100 entries</option><option value="500">500 entries</option><option value="unlimited">Unlimited</option></Select></Field>
                  <div className="settings-danger-row">
                    <div><h3>Clear transcript history</h3><p>Remove saved text without changing settings or models.</p></div>
                    <Button variant="danger" onClick={() => { setClearFailure(null); setClearOpen(true) }}>Clear history</Button>
                  </div>
                </SettingsGroup>
                <NotificationSettings settings={settings} onSave={save} />
                <SettingsGroup id="settings-updates" title="Updates" icon={Download} note={copy.settingsUpdatesLead}>
                  {/* Where Sotto never updates itself, the row says how to update by hand and offers nothing to press. */}
                  <div className="settings-update-row">
                    <div>
                      <p className="settings-update-version">{updateStatus === null ? 'Sotto' : `${releaseTrackName(releaseTrackOf(updateStatus))} ${updateStatus.currentVersion}`}</p>
                      {copy.settingsUpdatesByHand === null
                        ? <p className="settings-update-status" aria-live="polite">{updateStatusCopy(updateStatus)}</p>
                        : <p className="settings-update-status">{copy.settingsUpdatesByHand}</p>}
                    </div>
                    {copy.settingsUpdatesByHand === null ? <div className="settings-update-actions">
                      {/* On Owl, Update all runs the corner card's press: Sotto, its clients and its hosts (ADR-0077). */}
                      {updateStatus?.phase.phase === 'available' ? updateAll
                        ? <Button variant="secondary" disabled={updateBusy} aria-label="Update all: Sotto, its clients and its hosts" onClick={requestUpdateAll}>Update all</Button>
                        : <Button variant="secondary" disabled={updateBusy} onClick={() => void runUpdateAction(onDownloadUpdate)}>Download</Button> : null}
                      {updateStatus?.phase.phase === 'downloaded' ? <Button variant="secondary" disabled={updateBusy} onClick={() => void runUpdateAction(onInstallUpdate)}>Restart and install</Button> : null}
                      <Button variant="secondary" disabled={updateBusy} onClick={() => void runUpdateAction(onCheckForUpdates)}>{updateBusy ? 'Working...' : 'Check now'}</Button>
                    </div> : null}
                  </div>
                  {copy.settingsUpdatesByHand === null
                    ? <Toggle label="Check for updates automatically" checked={settings.autoUpdateCheck} onCheckedChange={(checked) => void save({ autoUpdateCheck: checked })} description={UPDATE_CHECK_PRIVACY_NOTICE} />
                    : null}
                </SettingsGroup>
                <SettingsGroup title="Start over" icon={RotateCcw}>
                  <div className="settings-danger-row">
                    <div><h3>Reset settings</h3><p>Restore defaults and reopen setup. Your OpenRouter key, speech model and history stay.</p></div>
                    <Button variant="secondary" onClick={() => { setResetFailure(null); setResetOpen(true) }}>Reset settings</Button>
                  </div>
                </SettingsGroup>
              </Card>

              {performanceOn ? <Card className="settings-section" id="settings-performance" {...panelProps('settings-performance')}>
                <div className="settings-section__heading"><h2>Performance</h2><p>How quickly Sotto's main process answers, on this computer</p></div>
                <PerformanceSettings visible={activeSection === 'settings-performance'} settings={settings} onUpdateSettings={save} />
              </Card> : null}
            </div>
          </div>
        </div>
      </SettingsLayout>
      <PageWindowControls />
      {statusText ? <p className="page-status">{statusText}</p> : null}

      {!clearOpen ? null : <ConfirmationDialog title="Clear history?" description="This permanently removes every saved transcript, and the numbers the Dictate room counts. Settings are unchanged." cancelLabel="Keep history" confirmLabel="Clear all transcripts" failureMessage={clearFailure ?? 'History could not be cleared.'} fallbackFocusRef={headingRef} onCancel={() => setClearOpen(false)} onConfirm={async () => { setClearFailure(null); const cleared = await onClearHistory().catch(() => false); if (cleared) setNotice({ text: 'Transcript history cleared.', error: false }); else setClearFailure('History could not be cleared. Your saved transcripts are unchanged.'); return cleared }} />}
      {!resetOpen ? null : <ConfirmationDialog title="Reset settings?" description="Defaults will be restored and first-run setup will reopen. Your saved OpenRouter key, speech model and history are preserved." cancelLabel="Keep settings" confirmLabel="Reset all settings" failureMessage={resetFailure ?? 'Settings could not be reset.'} fallbackFocusRef={headingRef} onCancel={() => setResetOpen(false)} onConfirm={async () => { setResetFailure(null); const reset = await onResetSettings().catch(() => false); if (reset) setNotice({ text: 'Settings reset to defaults.', error: false }); else setResetFailure('Settings could not be reset. Your current settings are unchanged.'); return reset }} />}
    </div>
  )
}

/**
 * What the picker calls a model: its name, and for one not on this computer yet its size. The list's
 * Download group says that choosing it downloads it, which keeps every name short enough to read in
 * the closed list.
 */
function speechModelLabel(model: SpeechModelOption): string {
  return model.installed ? model.name : `${model.name}, ${formatModelSize(model.bytes)}`
}

const PICKER_STEPS: Readonly<Record<string, (index: number, last: number) => number>> = Object.freeze({
  ArrowDown: (index, last) => Math.min(last, index + 1),
  ArrowRight: (index, last) => Math.min(last, index + 1),
  ArrowUp: (index) => Math.max(0, index - 1),
  ArrowLeft: (index) => Math.max(0, index - 1),
  Home: () => 0,
  PageUp: () => 0,
  End: (_index, last) => last,
  PageDown: (_index, last) => last,
})

/**
 * Settings → Dictation's speech model: a list of the models already on
 * this computer, then Sotto's models to download, then the chosen one's
 * statement and where it stands.
 *
 * A closed list changes its value, and says so, at every typed letter, and on
 * Windows and Linux at every arrow key too, and a choice can start a 650 MB
 * download. So those keys only move to a model here, and Enter, or a click in
 * the open list, chooses it; leaving the list goes back to the chosen one.
 * macOS opens its own menu on the arrows, where only Enter or a click chooses,
 * so the Mac keeps its arrows. Opening the list, by pointer or key, first goes
 * back to the chosen model, so a click on the one moved to is a change.
 */
function SpeechModelPicker({ models, choice, status, onChoose, refused, onRetry, platform }: {
  readonly models: readonly SpeechModelOption[] | null
  readonly choice: string | null
  readonly status: SpeechModelStatus | null
  readonly onChoose: ((id: string) => void) | undefined
  readonly refused: boolean
  readonly onRetry: () => void
  readonly platform: SottoPlatform
}): ReactNode {
  const chosen = models?.find(model => model.id === choice) ?? null
  const [movedTo, setMovedTo] = useState<string | null>(null)
  const here = models?.filter(model => model.installed) ?? []
  const downloads = models?.filter(model => !model.installed) ?? []
  // In the order the list shows them, which the arrow keys follow.
  const options = [...here, ...downloads]
  const moved = options.find(model => model.id === movedTo && model.id !== chosen?.id) ?? null
  const choose = (id: string): void => {
    setMovedTo(null)
    if (id !== '' && id !== chosen?.id) onChoose?.(id)
  }
  const onKeyDown = (event: React.KeyboardEvent<HTMLSelectElement>): void => {
    if (event.ctrlKey || event.metaKey) return
    // These open the list; it opens on the chosen model, so choosing the one moved to is a change.
    if (event.altKey || event.key === ' ' || event.key === 'F4' || (platform === 'darwin' && event.key.startsWith('Arrow'))) {
      setMovedTo(null)
      return
    }
    if (event.key === 'Enter') {
      if (moved === null) return
      event.preventDefault()
      choose(moved.id)
      return
    }
    if (event.key === 'Escape' && moved !== null) {
      event.preventDefault()
      event.stopPropagation()
      setMovedTo(null)
      return
    }
    const index = options.findIndex(model => model.id === (moved ?? chosen)?.id)
    const last = options.length - 1
    let next: number | undefined = platform === 'darwin' ? undefined : PICKER_STEPS[event.key]?.(index, last)
    if (next === undefined && event.key.length === 1 && event.key !== ' ') {
      // Typing a letter goes to the next model whose name starts with it, as the list itself would.
      const letter = event.key.toLocaleLowerCase()
      const after = [...options.slice(index + 1), ...options.slice(0, index + 1)]
      const found = after.find(model => model.name.toLocaleLowerCase().startsWith(letter))
      next = found === undefined ? index : options.indexOf(found)
    }
    if (next === undefined || last < 0) return
    event.preventDefault()
    setMovedTo(options[Math.max(0, next)]?.id ?? null)
  }
  const description = moved === null
    ? 'The model that turns your speech into text. Choosing one switches dictation to it.'
    : moved.installed
      ? `Press Enter to switch dictation to ${moved.name}.`
      : `Press Enter to download ${moved.name}, ${formatModelSize(moved.bytes)}, and switch dictation to it.`
  return <>
    <Field label="Speech model" description={description} {...(refused ? { error: SPEECH_MODEL_REFUSED } : {})}>
      <Select
        value={moved?.id ?? chosen?.id ?? ''}
        disabled={models === null || onChoose === undefined}
        onKeyDown={onKeyDown}
        onBlur={() => setMovedTo(null)}
        onMouseDown={() => setMovedTo(null)}
        onChange={event => choose(event.currentTarget.value)}
      >
        {chosen === null ? <option value="" disabled>{models === null ? 'Looking for models…' : 'Choose a model'}</option> : null}
        {here.length > 0 ? <optgroup label="Already on this computer">{here.map(model => <option key={model.id} value={model.id}>{speechModelLabel(model)}</option>)}</optgroup> : null}
        {downloads.length > 0 ? <optgroup label="Download">{downloads.map(model => <option key={model.id} value={model.id}>{speechModelLabel(model)}</option>)}</optgroup> : null}
      </Select>
    </Field>
    <div className="settings-model-statement">
      {chosen === null ? null : <>
        <h3>{chosen.name}</h3>
        <p>Speech recognition by {chosen.maker}, on this computer. {chosen.languages}.</p>
      </>}
      <SpeechModelStatusView status={status} model={chosen} onRetry={onRetry} />
    </div>
  </>
}
