import React, { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

import type { AppSettings } from '../../shared/settings'
import { AppShell, layoutFor } from './components/AppShell'
import { Card } from './components/Card'
import { DictateRoom } from './features/dictate/DictateRoom'
import { HelpView } from './features/help/HelpView'
import { HistoryView } from './features/history/HistoryView'
import { Onboarding } from './features/onboarding/Onboarding'
import { UpdateControl } from './features/updates/UpdateControl'
import { installConfirmation } from './features/updates/updateControlLogic'
import { useUpdateFlow, type UpdateNotice } from './features/updates/useUpdateFlow'
import { releaseUrl } from '../../shared/releases'
import { ConfirmationDialog } from './components/ConfirmationDialog'
import {
  BrowserMicrophoneTest,
  type MicrophoneTestController,
  type MicrophoneTestState,
} from './features/onboarding/microphoneTest'
import { useApp, type AppNavigation } from './state/AppContext'
import { useMemoryEnabled } from './state/memoryFeature'
import { useVoiceCoordinatorEnabled } from './state/voiceCoordinator'
import { SettingsView } from './features/settings/SettingsView'
import { HostQuestionDialog } from './features/settings/HostQuestionDialog'
import { ToastRegion, type ToastMessage } from './components/ToastRegion'
import { AgentProvider } from './agents/AgentContext'
import { ClientUpdateCard } from './agents/ClientUpdateCard'
import { FinishedThreadWatch } from './agents/finishedThreads'
import { PageSidebar } from './agents/PageSidebar'
import { SidebarChromeProvider } from './agents/SidebarFrame'
import { AgentAppearance, AgentRoom } from './agents/AgentRoom'
import { ThreadWorkspace } from './agents/ThreadWorkspace'
import { PersonalChatsView } from './agents/personal/PersonalChatsView'
import { E2E_THREADS_NOW } from '../../shared/e2e'
import { MemorySurface } from './features/memory/MemorySurface'
import { ThemeEditorHost } from './features/settings/themes/ThemeEditor'
import { appearancePreview, applyAppearance, systemPrefersDark, useAppearancePreviewVersion, useSystemPrefersDark } from './state/appearance'

const recoveryMessages = {
  SETTINGS_RECOVERED: 'Sotto restored default settings after a local settings file could not be read. The original file was preserved.',
  HISTORY_RECOVERED: 'Sotto started with an empty history after its local history file could not be read. The original file was preserved.',
  ACCESSIBILITY_PERMISSION_REQUIRED: 'Sotto copied the transcript instead of pasting it. Automatic paste needs Sotto allowed in System Settings > Privacy & Security > Accessibility, and allowed to control System Events under System Settings > Privacy & Security > Automation.',
} as const

export interface AppProps {
  readonly createMicrophoneTest?: () => MicrophoneTestController
}

/**
 * The main window paints the chosen mode and the theme that owns it (including
 * edits whose saves are still in flight, and the theme editor's unsaved draft),
 * with `system` resolved against the current operating system scheme, plus
 * the motion preference. `theme` is the widget's
 * and never reaches this root. Until settings load the root keeps whatever the
 * first-frame cache applied.
 */
export function applyDocumentPreferences(
  settings: AppSettings | null,
  root: HTMLElement = document.documentElement,
  systemDark: boolean = systemPrefersDark(),
): void {
  if (settings !== null) applyAppearance(appearancePreview.effective(settings), root, systemDark, appearancePreview.draft)
  if (settings?.reducedMotion === 'on') root.dataset.reducedMotion = 'on'
  else delete root.dataset.reducedMotion
}

/**
 * The one sentence at the room's foot (the footer under the strip, the foot
 * beside the sidebar, or the corner of a page that owns its window): what this
 * page keeps. Threads has no foot line, so it says nothing here.
 */
function FooterStatus({ navigation, settings, historyKept }: {
  readonly navigation: Exclude<AppNavigation, 'onboarding'>
  readonly settings: AppSettings
  /** Whether History still holds transcripts the user could clear. */
  readonly historyKept: boolean
}): ReactNode {
  switch (navigation) {
    case 'agents': return <AgentAppearance />
    case 'chats': return 'Chats are saved on this computer.'
    case 'history': return settings.historyEnabled ? 'Kept on this computer only.' : historyKept ? 'History is off. Older transcripts are still here.' : 'History is off.'
    case 'memory': return 'Your preferences, with their history.'
    case 'settings': return 'Changes save as you make them.'
    case 'help': return 'Shortcuts, privacy, and troubleshooting.'
    default: return settings.llmApiKey.length > 0
      ? 'MAI-Transcribe-2 via OpenRouter'
      : 'Add your OpenRouter API key in Settings'
  }
}

export function App({ createMicrophoneTest = () => new BrowserMicrophoneTest() }: AppProps): ReactNode {
  const app = useApp()
  const voiceCoordinator = useVoiceCoordinatorEnabled()
  const memoryEnabled = useMemoryEnabled()
  const [microphoneState, setMicrophoneState] = useState<MicrophoneTestState>('idle')
  const [microphoneLevel, setMicrophoneLevel] = useState(0)
  const [historyQuery, setHistoryQuery] = useState('')
  const [historyClearOpen, setHistoryClearOpen] = useState(false)
  const [agentSheet, setAgentSheet] = useState<'session' | 'new' | 'settings' | null>(null)
  const [historySearchRequest, setHistorySearchRequest] = useState(0)
  const microphoneRef = useRef<MicrophoneTestController | null>(null)
  const microphoneGenerationRef = useRef(0)
  const microphoneMountedRef = useRef(false)
  const microphoneStateRef = useRef<MicrophoneTestState>('idle')
  const microphoneSettledStateRef = useRef<Exclude<MicrophoneTestState, 'requesting'>>('idle')
  const microphoneReleaseTailRef = useRef<Promise<void>>(Promise.resolve())
  const microphoneReleasesRef = useRef(new WeakMap<MicrophoneTestController, Promise<void>>())
  const systemDark = useSystemPrefersDark()
  const appearanceEdits = useAppearancePreviewVersion()
  const [themeNotice, setThemeNotice] = useState<ToastMessage | null>(null)
  const latestSettingsRef = useRef(app.settings)
  latestSettingsRef.current = app.settings

  useEffect(() => {
    if (themeNotice === null) return
    const timer = setTimeout(() => setThemeNotice(current => (current === themeNotice ? null : current)), 4_000)
    return () => clearTimeout(timer)
  }, [themeNotice])

  // Update toasts: each one leaves by itself after a while, and a fresh one
  // about the same subject replaces the earlier one rather than stacking.
  const [updateToasts, setUpdateToasts] = useState<readonly ToastMessage[]>([])
  const updateToastSerial = useRef(0)
  const updateToastTimers = useRef(new Set<ReturnType<typeof setTimeout>>())
  useEffect(() => {
    const timers = updateToastTimers.current
    return () => { for (const timer of timers) clearTimeout(timer) }
  }, [])
  const notifyUpdate = useCallback((notice: UpdateNotice): void => {
    const id = `update-${++updateToastSerial.current}`
    const link = notice.version === undefined ? null : releaseUrl(notice.version)
    const open = window.sotto?.openExternalLink
    const message = (
      <>
        <strong>{notice.title}</strong>
        {notice.detail === null ? null : <> {notice.detail}</>}
        {link !== null && open !== undefined
          ? <> <button type="button" className="tt-toast__link tt-focusable" onClick={() => { void open(link) }}>Read more</button></>
          : null}
      </>
    )
    setUpdateToasts(current => [...current.filter(toast => toast.tone !== notice.tone), { id, message, tone: notice.tone }])
    const timer = setTimeout(() => {
      updateToastTimers.current.delete(timer)
      setUpdateToasts(current => current.filter(toast => toast.id !== id))
    }, notice.tone === 'error' ? 9_000 : 7_000)
    updateToastTimers.current.add(timer)
  }, [])

  const updateFlow = useUpdateFlow({
    status: app.update,
    checkRequest: app.updateCheckRequest,
    check: app.actions.checkForUpdates,
    download: app.actions.downloadUpdate,
    install: app.actions.installUpdate,
    notify: notifyUpdate,
  })

  // Layout effect: a new appearance is on the root before the browser paints
  // the render that selected it, so the choice and the room never disagree.
  useLayoutEffect(() => {
    applyDocumentPreferences(app.settings, document.documentElement, systemDark)
  }, [app.settings, systemDark, appearanceEdits])

  useEffect(() => {
    const search = (event: KeyboardEvent): void => {
      if (!app.settings?.onboardingComplete || document.querySelector('dialog[open], [role="dialog"]')) return
      if (event.key.toLowerCase() !== 'k' || !(app.platform === 'darwin' ? event.metaKey : event.ctrlKey)) return
      event.preventDefault()
      app.actions.navigate('history')
      setHistorySearchRequest(value => value + 1)
    }
    window.addEventListener('keydown', search)
    return () => window.removeEventListener('keydown', search)
  }, [app.actions, app.platform, app.settings?.onboardingComplete])

  useEffect(() => {
    if (historySearchRequest > 0 && app.navigation === 'history') document.querySelector<HTMLInputElement>('.history-find__input')?.focus()
  }, [historySearchRequest, app.navigation])

  const releaseMicrophone = useCallback((controller: MicrophoneTestController): Promise<void> => {
    const existing = microphoneReleasesRef.current.get(controller)
    if (existing !== undefined) return existing
    const release = microphoneReleaseTailRef.current
      .then(() => controller.stop())
      .catch(() => undefined)
    microphoneReleasesRef.current.set(controller, release)
    microphoneReleaseTailRef.current = release
    return release
  }, [])

  const commitMicrophoneState = useCallback((next: MicrophoneTestState): void => {
    microphoneStateRef.current = next
    if (next !== 'requesting') microphoneSettledStateRef.current = next
    if (microphoneMountedRef.current) setMicrophoneState(next)
  }, [])

  useEffect(() => {
    microphoneMountedRef.current = true
    return () => {
      microphoneMountedRef.current = false
      ++microphoneGenerationRef.current
      const controller = microphoneRef.current
      microphoneRef.current = null
      if (controller !== null) void releaseMicrophone(controller)
    }
  }, [releaseMicrophone])

  const stopMicrophone = useCallback(async (): Promise<void> => {
    ++microphoneGenerationRef.current
    const controller = microphoneRef.current
    microphoneRef.current = null
    if (microphoneMountedRef.current) {
      setMicrophoneLevel(0)
      if (microphoneStateRef.current === 'requesting') {
        commitMicrophoneState(microphoneSettledStateRef.current)
      }
    }
    if (controller !== null) await releaseMicrophone(controller)
    else await microphoneReleaseTailRef.current
  }, [commitMicrophoneState, releaseMicrophone])

  const requestMicrophone = useCallback(async (): Promise<void> => {
    const generation = ++microphoneGenerationRef.current
    if (!microphoneMountedRef.current) return
    const previousController = microphoneRef.current
    microphoneRef.current = null
    setMicrophoneLevel(0)
    commitMicrophoneState('requesting')
    if (previousController !== null) await releaseMicrophone(previousController)
    else await microphoneReleaseTailRef.current
    if (!microphoneMountedRef.current || microphoneGenerationRef.current !== generation) return
    let controller: MicrophoneTestController
    try { controller = createMicrophoneTest() } catch {
      if (microphoneMountedRef.current && microphoneGenerationRef.current === generation) {
        commitMicrophoneState('error')
      }
      return
    }
    if (!microphoneMountedRef.current || microphoneGenerationRef.current !== generation) {
      await releaseMicrophone(controller)
      return
    }
    microphoneRef.current = controller
    const outcome = await controller.start((level) => {
      if (
        microphoneMountedRef.current &&
        microphoneGenerationRef.current === generation &&
        microphoneRef.current === controller
      ) {
        setMicrophoneLevel(level)
      }
    }).catch(() => 'error' as const)
    if (
      !microphoneMountedRef.current ||
      microphoneGenerationRef.current !== generation ||
      microphoneRef.current !== controller
    ) {
      await releaseMicrophone(controller)
      return
    }
    commitMicrophoneState(outcome)
    if (outcome !== 'ready') {
      microphoneRef.current = null
      await releaseMicrophone(controller)
    }
  }, [commitMicrophoneState, createMicrophoneTest, releaseMicrophone])

  let content: ReactNode
  if (app.status === 'loading') {
    content = <main className="app-loading" aria-busy="true"><p role="status">Preparing Sotto...</p></main>
  } else if (app.status === 'unavailable' || app.settings === null) {
    content = (
      <main className="app-unavailable">
        <Card>
          <h1>Sotto could not finish starting</h1>
          <p>Your data was not changed. Close and reopen Sotto, then try again.</p>
        </Card>
      </main>
    )
  } else if (!app.settings.onboardingComplete || app.navigation === 'onboarding') {
    const recoveryToasts: ToastMessage[] = app.recoveryNotices.map((notice) => ({
      id: notice.code,
      message: recoveryMessages[notice.code],
    }))
    content = (
      <>
        <Onboarding
          microphoneState={microphoneState}
          microphoneLevel={microphoneLevel}
          settings={app.settings}
          onUpdateSettings={app.actions.updateSettings}
          onCheckTranscriptionKey={app.actions.checkTranscriptionKey}
          shortcut={app.settings.hotkey}
          platform={app.platform}
          onRequestMicrophone={requestMicrophone}
          onStopMicrophone={stopMicrophone}
          onComplete={async ({ microphoneSkipped }) => {
            await stopMicrophone()
            const saved = await app.actions.updateSettings({ onboardingComplete: true, microphoneSkipped })
            if (saved) app.actions.navigate('threads')
            return saved
          }}
        />
        <ToastRegion messages={recoveryToasts} />
      </>
    )
  } else {
    const navigation = app.navigation
    const updateControl = <UpdateControl status={app.update} busy={updateFlow.busy} onActivate={updateFlow.activate} />
    // With the voice coordinator off there is no Agents room to open, so the
    // page that would have shown it shows Threads, and the controls that led
    // into its settings lead to Settings instead.
    // The same goes for Memory while memory is hidden.
    const threadsPage = navigation === 'threads' || (navigation === 'agents' && !voiceCoordinator) || (navigation === 'memory' && !memoryEnabled)
    const layout = layoutFor(navigation, threadsPage)
    // A capture run holds the sidebar's clocks still.
    const captureNow = window.sottoE2E?.scenario === 'design-threads' ? E2E_THREADS_NOW : undefined
    const statusText = <FooterStatus navigation={navigation} settings={app.settings} historyKept={app.historyStatus === 'ready' && app.history.length > 0} />
    const threadWorkspace = (
      <ThreadWorkspace
        onOpenAgents={voiceCoordinator
          ? () => { setAgentSheet('session'); app.actions.navigate('agents') }
          : () => app.actions.navigate('settings')}
        updateControl={updateControl}
        now={captureNow}
      />
    )

    let view: ReactNode
    switch (navigation) {
      case 'memory':
        view = memoryEnabled ? null : threadWorkspace
        break
      case 'agents':
        view = voiceCoordinator
          ? <AgentRoom initialSheet={agentSheet} onOpenThreads={() => app.actions.navigate('threads')} />
          : threadWorkspace
        break
      case 'threads':
        view = threadWorkspace
        break
      case 'chats':
        view = <PersonalChatsView statusText={statusText} onOpenCoordinatorSettings={() => {
          if (!voiceCoordinator) { app.actions.navigate('settings'); return }
          setAgentSheet('settings')
          app.actions.navigate('agents')
        }} />
        break
      case 'history':
        view = <HistoryView
          entries={app.history}
          enabled={app.settings.historyEnabled}
          status={app.historyStatus}
          query={historyQuery}
          onQueryChange={setHistoryQuery}
          clearOpen={historyClearOpen}
          onClearOpenChange={setHistoryClearOpen}
          onOpenDictate={() => app.actions.navigate('home')}
          onOpenSettings={() => app.actions.navigate('settings')}
          onCopy={app.actions.copyHistory}
          onDelete={app.actions.deleteHistory}
          onClear={app.actions.clearHistory}
        />
        break
      case 'settings':
        view = <SettingsView
          settings={app.settings}
          platform={app.platform}
          statusText={statusText}
          updateStatus={app.update}
          onUpdateSettings={app.actions.updateSettings}
          onReplaceHotkey={app.actions.replaceHotkey}
          onSetStartup={app.actions.setStartup}
          onResetSettings={app.actions.resetSettings}
          onClearHistory={app.actions.clearHistory}
          onCheckTranscriptionKey={app.actions.checkTranscriptionKey}
          onCheckForUpdates={updateFlow.check}
          onDownloadUpdate={updateFlow.download}
          // The press opens the same confirmation the footer control uses; the
          // install itself happens only once that is answered.
          onInstallUpdate={async () => { updateFlow.activate('install'); return true }}
        />
        break
      case 'help':
        view = <HelpView shortcut={app.settings.hotkey} platform={app.platform} version={app.update?.currentVersion} />
        break
      default:
        view = <DictateRoom
          settings={app.settings}
          platform={app.platform}
          dictation={app.dictation}
          entries={app.history}
          historyStatus={app.historyStatus}
          onStart={app.actions.start}
          onStop={app.actions.stop}
          onOpenSettings={() => app.actions.navigate('settings')}
          onCopy={app.actions.copyHistory}
        />
    }

    const pendingInstall = updateFlow.pendingInstall === null ? null : installConfirmation(updateFlow.pendingInstall)

    content = (
      <>
        {/* The sidebar and the pages' own columns seat the same update control in their foot. */}
        <SidebarChromeProvider updateControl={updateControl}>
          <AppShell
            navigation={navigation}
            platform={app.platform}
            layout={layout}
            sidebar={layout === 'sidebar' ? <PageSidebar now={captureNow} /> : undefined}
            statusText={statusText}
            updateControl={updateControl}
            onNavigate={destination => { if (destination === 'agents') setAgentSheet(null); app.actions.navigate(destination) }}
            onMinimize={app.actions.minimizeApp}
            onMaximize={app.actions.toggleMaximizeApp}
            maximized={app.windowMaximized}
            onClose={app.actions.hideApp}
          >
            {/* The memory questionnaire greets you in the Agents room. With the coordinator off that
                page is the Threads page, which must not be replaced by a questionnaire; Memory still
                offers it on request. */}
            {memoryEnabled ? <MemorySurface navigation={threadsPage ? 'threads' : navigation}>{view}</MemorySurface> : view}
          </AppShell>
        </SidebarChromeProvider>
        {pendingInstall !== null ? (
          <ConfirmationDialog
            title={pendingInstall.title}
            description={pendingInstall.description}
            confirmLabel="Restart and install"
            cancelLabel="Not now"
            danger={false}
            onConfirm={async () => { await updateFlow.confirmInstall(); return true }}
            onCancel={updateFlow.cancelInstall}
          />
        ) : null}
        {/* A saved host reconnecting on its own can need an answer from SSH on any page. */}
        <HostQuestionDialog />
        <ThemeEditorHost
          settings={app.settings}
          onSave={app.actions.updateSettings}
          getSettings={() => latestSettingsRef.current ?? app.settings!}
          onNotice={message => setThemeNotice(current => ({ id: `theme-${Number(current?.id.slice(6) ?? 0) + 1}`, message }))}
        />
        <ToastRegion messages={[
          ...app.recoveryNotices.map((notice) => ({
            id: notice.code,
            message: recoveryMessages[notice.code],
          })),
          ...(themeNotice === null ? [] : [themeNotice]),
          ...updateToasts,
        ]} />
      </>
    )
  }

  const management = app.status === 'ready' && app.settings !== null
    && app.settings.onboardingComplete && app.navigation !== 'onboarding'

  return (
    <AgentProvider settings={app.settings} dictation={app.dictation}>
      <FinishedThreadWatch />
      {management ? content : (
        <AppShell
          navigation={null}
          platform={app.platform}
          onMinimize={app.actions.minimizeApp}
          onMaximize={app.actions.toggleMaximizeApp}
          maximized={app.windowMaximized}
          onClose={app.actions.hideApp}
        >
          {content}
        </AppShell>
      )}
      <ClientUpdateCard />
    </AgentProvider>
  )
}
