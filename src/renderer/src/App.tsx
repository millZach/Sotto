import React, { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'

import type { ModelDisclosureCatalog, ModelStatus } from '../../shared/contracts'
import type { AppSettings, ModelPreset } from '../../shared/settings'
import { AppShell } from './components/AppShell'
import { Card } from './components/Card'
import { DictateRoom } from './features/dictate/DictateRoom'
import { HelpView } from './features/help/HelpView'
import { HistoryFooter, HistoryView } from './features/history/HistoryView'
import { Onboarding, type OnboardingModelState } from './features/onboarding/Onboarding'
import { UpdateBanner } from './features/updates/UpdateBanner'
import { updatePromptKey } from './features/updates/updatePrompt'
import {
  BrowserMicrophoneTest,
  type MicrophoneTestController,
  type MicrophoneTestState,
} from './features/onboarding/microphoneTest'
import { useApp, type AppNavigation } from './state/AppContext'
import { SettingsView } from './features/settings/SettingsView'
import { ToastRegion, type ToastMessage } from './components/ToastRegion'
import { AgentProvider, useAgents } from './agents/AgentContext'
import { MODEL_CATALOG } from '../../shared/modelCatalog'
import { languageLabel } from './languages'
import { AgentAppearance, AgentRoom } from './agents/AgentRoom'
import { ThreadsView } from './agents/ThreadsView'
import { lookingAfterSentence } from './agents/threadFacts'
import { E2E_THREADS_NOW } from '../../shared/e2e'

const recoveryMessages = {
  SETTINGS_RECOVERED: 'Sotto restored default settings after a local settings file could not be read. The original file was preserved.',
  HISTORY_RECOVERED: 'Sotto started with an empty history after its local history file could not be read. The original file was preserved.',
  ACCESSIBILITY_PERMISSION_REQUIRED: 'Sotto copied the transcript instead of pasting it. Automatic paste needs Sotto allowed in System Settings > Privacy & Security > Accessibility, and allowed to control System Events under System Settings > Privacy & Security > Automation.',
} as const

export interface AppProps {
  readonly createMicrophoneTest?: () => MicrophoneTestController
}

/**
 * The main window is black whatever `theme` says (the field is kept for old
 * settings files and the widget snapshot), so only reduced motion reaches the
 * root; a stale theme attribute from an earlier build is cleared.
 */
export function applyDocumentPreferences(settings: AppSettings | null, root: HTMLElement = document.documentElement): void {
  delete root.dataset.theme
  if (settings?.reducedMotion === 'on') root.dataset.reducedMotion = 'on'
  else delete root.dataset.reducedMotion
}

/** The footer's one sentence: what this page keeps, or what the machine is looking after. */
function FooterStatus({ navigation, settings }: {
  readonly navigation: Exclude<AppNavigation, 'onboarding'>
  readonly settings: AppSettings
}): ReactNode {
  const agents = useAgents()
  switch (navigation) {
    case 'agents': return <AgentAppearance />
    case 'threads':
      return lookingAfterSentence(agents.state?.host.threads.filter((thread) => thread.status === 'running').length ?? 0)
    case 'history': return settings.historyEnabled ? 'Kept on this computer only. Nothing leaves it.' : 'History is off.'
    case 'settings': return 'Changes save as you make them.'
    case 'help': return 'Shortcuts, privacy, and troubleshooting.'
    default: {
      const model = MODEL_CATALOG[settings.modelPreset].label
      return `${model} model, ${languageLabel(settings.language)}. ${settings.autoPaste ? 'Pastes automatically.' : 'Copies to the clipboard.'}`
    }
  }
}

function toModelState(status: ModelStatus | undefined): OnboardingModelState {
  if (status === undefined || status.state === 'downloading') return 'checking'
  if (status.state === 'bundled' || status.state === 'ready') return 'ready'
  if (status.state === 'missing') return 'missing'
  return 'error'
}

export function App({ createMicrophoneTest = () => new BrowserMicrophoneTest() }: AppProps): ReactNode {
  const app = useApp()
  const [microphoneState, setMicrophoneState] = useState<MicrophoneTestState>('idle')
  const [microphoneLevel, setMicrophoneLevel] = useState(0)
  const [modelState, setModelState] = useState<OnboardingModelState>('checking')
  const [disclosures, setDisclosures] = useState<ModelDisclosureCatalog | undefined>()
  const [historyQuery, setHistoryQuery] = useState('')
  const [historyClearOpen, setHistoryClearOpen] = useState(false)
  const [agentSheet, setAgentSheet] = useState<'session' | 'new' | null>(null)
  const [historySearchRequest, setHistorySearchRequest] = useState(0)
  const microphoneRef = useRef<MicrophoneTestController | null>(null)
  const microphoneGenerationRef = useRef(0)
  const microphoneMountedRef = useRef(false)
  const microphoneStateRef = useRef<MicrophoneTestState>('idle')
  const microphoneSettledStateRef = useRef<Exclude<MicrophoneTestState, 'requesting'>>('idle')
  const microphoneReleaseTailRef = useRef<Promise<void>>(Promise.resolve())
  const microphoneReleasesRef = useRef(new WeakMap<MicrophoneTestController, Promise<void>>())
  const modelGenerationRef = useRef(0)

  useEffect(() => {
    applyDocumentPreferences(app.settings)
  }, [app.settings])

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

  const checkModel = useCallback(async (): Promise<void> => {
    const generation = ++modelGenerationRef.current
    setModelState('checking')
    const result = await app.actions.getModelStatus('instant')
    if (modelGenerationRef.current !== generation) return
    if (!('preset' in result)) setModelState('unavailable')
  }, [app.actions])

  useEffect(() => {
    if (app.status !== 'ready' || app.settings?.onboardingComplete === true) return
    let current = true
    void checkModel()
    void app.actions.listModelDisclosures().then((result) => {
      if (current && 'models' in result) setDisclosures(result)
    })
    return () => {
      current = false
      ++modelGenerationRef.current
    }
  }, [app.actions, app.settings?.onboardingComplete, app.status, checkModel])

  useEffect(() => {
    const bundled = app.modelStatuses.instant
    if (bundled !== undefined) {
      ++modelGenerationRef.current
      setModelState(toModelState(bundled))
    }
  }, [app.modelStatuses.instant])

  useEffect(() => {
    if (
      app.status !== 'ready' ||
      app.settings === null ||
      !app.settings.onboardingComplete ||
      app.navigation === 'onboarding'
    ) return
    void app.actions.getModelStatus(app.settings.modelPreset)
  }, [app.actions, app.navigation, app.settings, app.status])

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
          modelState={modelState}
          shortcut={app.settings.hotkey}
          platform={app.platform}
          {...(disclosures === undefined ? {} : { disclosures })}
          onRequestMicrophone={requestMicrophone}
          onStopMicrophone={stopMicrophone}
          onRetryModel={checkModel}
          onInstallModel={async (preset: Exclude<ModelPreset, 'instant'>) => {
            const result = await app.actions.installModel({ preset, consent: true })
            if (!result.ok) throw new Error('MODEL_INSTALL_UNAVAILABLE')
          }}
          onComplete={async () => {
            await stopMicrophone()
            const saved = await app.actions.updateSettings({ onboardingComplete: true })
            if (saved) app.actions.navigate('home')
            return saved
          }}
        />
        <ToastRegion messages={recoveryToasts} />
      </>
    )
  } else {
    const navigation = app.navigation

    let view: ReactNode
    switch (navigation) {
      case 'agents':
        view = <AgentRoom initialSheet={agentSheet} onOpenThreads={() => app.actions.navigate('threads')} />
        break
      case 'threads':
        view = <ThreadsView
          onOpenAgents={() => { setAgentSheet('session'); app.actions.navigate('agents') }}
          now={window.sottoE2E?.scenario === 'design-threads' ? E2E_THREADS_NOW : undefined}
        />
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
          modelStatuses={app.modelStatuses}
          updateStatus={app.update}
          onUpdateSettings={app.actions.updateSettings}
          onReplaceHotkey={app.actions.replaceHotkey}
          onSetStartup={app.actions.setStartup}
          onResetSettings={app.actions.resetSettings}
          onClearHistory={app.actions.clearHistory}
          onGetModelStatus={app.actions.getModelStatus}
          onListModelDisclosures={app.actions.listModelDisclosures}
          onInstallModel={app.actions.installModel}
          onRemoveModel={app.actions.removeModel}
          onCheckRemoteAsr={app.actions.checkRemoteAsr}
          onCheckForUpdates={app.actions.checkForUpdates}
          onDownloadUpdate={app.actions.downloadUpdate}
          onInstallUpdate={app.actions.installUpdate}
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
          modelStatus={app.modelStatuses[app.settings.modelPreset]}
          entries={app.history}
          historyStatus={app.historyStatus}
          onStart={app.actions.start}
          onStop={app.actions.stop}
          onOpenSettings={() => app.actions.navigate('settings')}
          onCopy={app.actions.copyHistory}
        />
    }

    const promptKey = updatePromptKey(app.update)
    const updatePrompt = app.update !== null && promptKey !== null && !app.dismissedUpdates.includes(promptKey)
      ? <UpdateBanner
          status={app.update}
          onDownload={app.actions.downloadUpdate}
          onInstall={app.actions.installUpdate}
          onDismiss={app.actions.dismissUpdate}
        />
      : null

    content = (
      <>
        <AppShell
          navigation={navigation}
          platform={app.platform}
          statusText={navigation === 'history' ? <HistoryFooter enabled={app.settings.historyEnabled} status={app.historyStatus} count={app.history.length} onClear={() => setHistoryClearOpen(true)} /> : <FooterStatus navigation={navigation} settings={app.settings} />}
          onNavigate={destination => { if (destination === 'agents') setAgentSheet(null); app.actions.navigate(destination) }}
          onMinimize={app.actions.minimizeApp}
          onClose={app.actions.hideApp}
        >
          {updatePrompt}
          {view}
        </AppShell>
        <ToastRegion messages={app.recoveryNotices.map((notice) => ({
          id: notice.code,
          message: recoveryMessages[notice.code],
        }))} />
      </>
    )
  }

  const management = app.status === 'ready' && app.settings !== null
    && app.settings.onboardingComplete && app.navigation !== 'onboarding'

  return (
    <AgentProvider settings={app.settings} dictation={app.dictation}>
      {management ? content : (
        <AppShell
          navigation={null}
          platform={app.platform}
          onMinimize={app.actions.minimizeApp}
          onClose={app.actions.hideApp}
        >
          {content}
        </AppShell>
      )}
    </AgentProvider>
  )
}
