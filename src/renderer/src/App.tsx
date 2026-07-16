import React, { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'

import type { ModelDisclosureCatalog, ModelStatus } from '../../shared/contracts'
import type { AppSettings, ModelPreset } from '../../shared/settings'
import { Card } from './components/Card'
import { Onboarding, type OnboardingModelState } from './features/onboarding/Onboarding'
import {
  BrowserMicrophoneTest,
  type MicrophoneTestController,
  type MicrophoneTestState,
} from './features/onboarding/microphoneTest'
import { useApp } from './state/AppContext'

export interface AppProps {
  readonly createMicrophoneTest?: () => MicrophoneTestController
}

export function applyDocumentPreferences(settings: AppSettings | null, root: HTMLElement = document.documentElement): void {
  if (settings?.theme === 'light' || settings?.theme === 'dark') {
    root.dataset.theme = settings.theme
  } else {
    delete root.dataset.theme
  }
  if (settings?.reducedMotion === 'on') root.dataset.reducedMotion = 'on'
  else delete root.dataset.reducedMotion
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
    const result = await app.actions.getModelStatus('balanced')
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
    const balanced = app.modelStatuses.balanced
    if (balanced !== undefined) {
      ++modelGenerationRef.current
      setModelState(toModelState(balanced))
    }
  }, [app.modelStatuses.balanced])

  if (app.status === 'loading') {
    return <main className="app-loading" aria-busy="true"><p role="status">Preparing TalkType...</p></main>
  }

  if (app.status === 'unavailable' || app.settings === null) {
    return (
      <main className="app-unavailable">
        <Card>
          <h1>TalkType could not finish starting</h1>
          <p>Your data was not changed. Close and reopen TalkType, then try again.</p>
        </Card>
      </main>
    )
  }

  if (!app.settings.onboardingComplete || app.navigation === 'onboarding') {
    return (
      <Onboarding
        microphoneState={microphoneState}
        microphoneLevel={microphoneLevel}
        modelState={modelState}
        shortcut={app.settings.hotkey}
        {...(disclosures === undefined ? {} : { disclosures })}
        onRequestMicrophone={requestMicrophone}
        onStopMicrophone={stopMicrophone}
        onRetryModel={checkModel}
        onInstallModel={async (preset: Extract<ModelPreset, 'fast' | 'accurate'>) => {
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
    )
  }

  return (
    <main className="app-ready-shell">
      <Card className="app-ready-shell__card">
        <p className="onboarding-eyebrow">TalkType</p>
        <h1>Ready to dictate</h1>
        <p>Press {app.settings.hotkey} anywhere to start. Your full dashboard is next.</p>
      </Card>
    </main>
  )
}
