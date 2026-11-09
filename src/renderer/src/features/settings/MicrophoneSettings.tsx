import React, { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useLingui } from '@lingui/react/macro'

import type { AppSettings, SettingsPatch } from '../../../../shared/settings'
import type { SottoPlatform } from '../../../../shared/platform'
import { useAudioInputDevices, type MediaDevicesAdapter } from '../../audio/useAudioInputDevices'
import { Button } from '../../components/Button'
import { Field } from '../../components/Field'
import { OpenSystemSettingsButton } from '../../components/OpenSystemSettingsButton'
import { Select } from '../../components/Select'
import { VoiceWave } from '../../components/VoiceWave'
import { platformCopy } from '../../platformCopy'
import { MICROPHONE_HEARD_LEVEL, WorkletMicrophoneTest, type MicrophoneTestController, type MicrophoneTestState } from '../onboarding/microphoneTest'

interface MicrophoneSettingsProps {
  readonly settings: Pick<AppSettings, 'microphoneId' | 'microphoneSkipped'>
  readonly platform: SottoPlatform
  readonly enabled: boolean
  readonly visible: boolean
  readonly mediaDevices?: MediaDevicesAdapter | undefined
  readonly createMicrophoneTest?: (() => MicrophoneTestController) | undefined
  readonly onSave: (patch: SettingsPatch) => Promise<boolean>
  readonly onUpdateSettings: (patch: SettingsPatch) => Promise<boolean>
}

/** Keeps the input choice and its live test together, mounted while Settings changes pages. */
export function MicrophoneSettings({
  settings,
  platform,
  enabled,
  visible,
  mediaDevices = typeof navigator === 'undefined' ? undefined : navigator.mediaDevices,
  createMicrophoneTest = () => new WorkletMicrophoneTest(),
  onSave,
  onUpdateSettings,
}: MicrophoneSettingsProps): ReactNode {
  const { t } = useLingui()
  const copy = platformCopy(platform)
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
  const microphoneSaveRef = useRef(0)
  const settingsRef = useRef(settings)
  settingsRef.current = settings

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

  useEffect(() => { if (!enabled || !visible) stopMicrophoneTest() }, [enabled, visible, stopMicrophoneTest])

  const microphoneKnown = settings.microphoneId === null || microphones.some(({ deviceId }) => deviceId === settings.microphoneId)
  if (!enabled) return null

  return <>
    <Field setting="microphone" label={t`Microphone`} {...(deviceState === 'error' ? { description: copy.settingsMicrophoneUnavailable } : {})}>
      <Select value={microphoneId ?? ''} onChange={(event) => {
        const next = event.currentTarget.value || null
        const sequence = ++microphoneSaveRef.current
        setMicrophoneId(next)
        void onSave({ microphoneId: next }).then((saved) => {
          // The notice says the previous setting is still active; show it.
          if (!saved && sequence === microphoneSaveRef.current) setMicrophoneId(settingsRef.current.microphoneId)
        })
      }}>
        <option value="">{copy.settingsMicrophoneDefaultOption}</option>
        {!microphoneKnown && settings.microphoneId !== null ? <option value={settings.microphoneId}>{t`Previous microphone (unavailable)`}</option> : null}
        {microphones.map((microphone, index) => {
          const number = index + 1
          return <option key={microphone.deviceId} value={microphone.deviceId}>{microphone.label || t`Microphone ${number}`}</option>
        })}
      </Select>
    </Field>
    {/* A row on the Microphone card like the others (ADR-0110, #1831): the label over its description and what the
        test found, and the level and the button at the row's end. */}
    <div className="tt-field settings-microphone-test" data-state={microphoneState}>
      <p className="tt-field__label" id="settings-microphone-test-label">{t`Microphone test`}</p>
      <p className="tt-field__description tt-paragraph" id="settings-microphone-test-description">{t`Check that Sotto can hear you. Access is asked for only while the test runs.`}</p>
      <p className="settings-microphone-test__status tt-paragraph" role="status">
        {microphoneState === 'ready' ? t`Listening. Say something.` : null}
        {microphoneState === 'closed' ? microphonePeakRef.current > MICROPHONE_HEARD_LEVEL ? t`Sotto heard you. The microphone is closed.` : t`Sotto did not hear anything. Check that the microphone is not muted.` : null}
        {microphoneState === 'requesting' ? t`Waiting for microphone permission...` : null}
        {microphoneState === 'idle' && settings.microphoneSkipped ? t`No microphone is set up. Run this test to set one up.` : null}
        {microphoneState === 'denied' ? copy.settingsMicrophoneDenied : null}
        {microphoneState === 'missing' ? !microphoneKnown && microphones.length > 0 ? t`The chosen microphone is not connected. Plug it in or choose another.` : t`No microphone was found.` : null}
        {microphoneState === 'error' ? t`The microphone test could not start.` : null}
      </p>
      <div className="settings-microphone-test__controls">
        {/* The wave the widget and the Dictate room show; it listens for as long as the test's stream runs. */}
        <VoiceWave stage={microphoneState === 'requesting' || microphoneState === 'ready' ? 'listening' : 'idle'} value={microphoneLevel} label={t`Microphone level`} size="deck" holdSpeaking={microphoneState === 'ready'} />
        <Button
          data-setting="microphone-test"
          aria-describedby="settings-microphone-test-label settings-microphone-test-description"
          variant="secondary"
          disabled={microphoneState === 'requesting'}
          onClick={() => microphoneState === 'ready' ? stopMicrophoneTest() : void runMicrophoneTest()}
        >
          {microphoneState === 'ready' ? t`Stop test` : microphoneState === 'closed' ? t`Test again` : t`Test microphone`}
        </Button>
        {microphoneState === 'denied' ? <OpenSystemSettingsButton platform={platform} pane="microphone" /> : null}
      </div>
    </div>
  </>
}
