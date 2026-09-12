import { Check, KeyRound, Keyboard, Mic2, ShieldCheck } from 'lucide-react'
import React, {
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'

import type { TranscriptionKeyCheck } from '../../../../shared/contracts'
import type { SottoPlatform } from '../../../../shared/platform'
import type { AppSettings, SettingsPatch } from '../../../../shared/settings'
import { OpenRouterKeyField } from '../../components/OpenRouterKeyField'
import { Button } from '../../components/Button'
import { Card } from '../../components/Card'
import { Field } from '../../components/Field'
import { LevelMeter } from '../../components/LevelMeter'
import { ShortcutKey } from '../../components/ShortcutKey'
import { platformCopy } from '../../platformCopy'
import type { MicrophoneTestState } from './microphoneTest'

export interface OnboardingProps {
  readonly settings: AppSettings
  readonly onUpdateSettings: (patch: SettingsPatch) => Promise<boolean>
  readonly onCheckTranscriptionKey: () => Promise<TranscriptionKeyCheck>
  readonly microphoneState: MicrophoneTestState
  readonly microphoneLevel?: number
  readonly shortcut: string
  readonly platform: SottoPlatform
  readonly onRequestMicrophone: () => void | Promise<void>
  readonly onStopMicrophone?: () => void | Promise<void>
  readonly onComplete: () => boolean | void | Promise<boolean | void>
}

const STEP_COUNT = 4

function StepIcon({ step }: { readonly step: number }): ReactNode {
  const Icon = [ShieldCheck, Mic2, KeyRound, Keyboard][step - 1] ?? ShieldCheck
  return <Icon aria-hidden="true" size={24} strokeWidth={1.8} />
}

export function Onboarding({
  settings,
  onUpdateSettings,
  onCheckTranscriptionKey,
  microphoneState,
  microphoneLevel = 0,
  shortcut,
  platform,
  onRequestMicrophone,
  onStopMicrophone,
  onComplete,
}: OnboardingProps): ReactNode {
  const [step, setStep] = useState(1)
  const [pasteTest, setPasteTest] = useState('')
  const [finishing, setFinishing] = useState(false)
  const [completionError, setCompletionError] = useState(false)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const copy = platformCopy(platform)

  useEffect(() => {
    headingRef.current?.focus()
  }, [step])

  useEffect(() => {
    if (step !== 2) void Promise.resolve(onStopMicrophone?.()).catch(() => undefined)
    return () => {
      if (step === 2) void Promise.resolve(onStopMicrophone?.()).catch(() => undefined)
    }
  }, [onStopMicrophone, step])

  const advance = (): void => setStep((current) => Math.min(STEP_COUNT, current + 1))
  const goBack = (): void => setStep((current) => Math.max(1, current - 1))

  const finish = async (): Promise<void> => {
    if (finishing || microphoneState !== 'ready') return
    setFinishing(true)
    setCompletionError(false)
    try {
      const completed = await onComplete()
      if (completed === false) setCompletionError(true)
    } catch {
      setCompletionError(true)
    } finally {
      setFinishing(false)
    }
  }

  return (
    <main className="onboarding-shell" aria-labelledby="onboarding-heading">
      <div className="onboarding-progress" aria-label={`Setup progress: step ${step} of ${STEP_COUNT}`}>
        <span className="onboarding-progress__text" aria-live="polite" aria-atomic="true">
          Step {step} of {STEP_COUNT}
        </span>
        <ol aria-hidden="true">
          {Array.from({ length: STEP_COUNT }, (_, index) => (
            <li key={index} data-current={index + 1 === step} data-complete={index + 1 < step} />
          ))}
        </ol>
      </div>

      <Card className="onboarding-card">
        <div className="onboarding-step-icon"><StepIcon step={step} /></div>
        {step === 1 ? (
          <section>
            <p className="onboarding-eyebrow">Welcome to Sotto</p>
            <h1 id="onboarding-heading" ref={headingRef} tabIndex={-1}>Dictation, ready when you are</h1>
            <p className="onboarding-lead">Press a shortcut, speak, and your words arrive as text wherever you were typing. You will need an OpenRouter API key.</p>
            <div className="onboarding-assurances">
              <p><Check aria-hidden="true" size={18} /> Transcribed by Microsoft MAI-Transcribe-2 through OpenRouter</p>
              <p><Check aria-hidden="true" size={18} /> Audio leaves this computer only while you dictate</p>
              <p><Check aria-hidden="true" size={18} /> No Sotto account, no telemetry</p>
            </div>
          </section>
        ) : null}

        {step === 2 ? (
          <section>
            <p className="onboarding-eyebrow">Microphone</p>
            <h1 id="onboarding-heading" ref={headingRef} tabIndex={-1}>Check your microphone</h1>
            <p className="onboarding-lead">Sotto needs microphone access only while you record or run this test.</p>
            <div className="onboarding-microphone-test" data-state={microphoneState}>
              <LevelMeter value={microphoneLevel} label="Microphone level" />
              <p role="status">
                {microphoneState === 'ready' ? 'Microphone ready. Access is confirmed; retest any time to check current input activity.' : null}
                {microphoneState === 'requesting' ? 'Waiting for microphone permission...' : null}
                {microphoneState === 'idle' ? 'Run a quick input-level test.' : null}
                {microphoneState === 'denied' ? 'Microphone access is blocked.' : null}
                {microphoneState === 'missing' ? 'No microphone was found.' : null}
                {microphoneState === 'error' ? 'The microphone test could not start.' : null}
              </p>
              <Button
                variant={microphoneState === 'ready' ? 'secondary' : 'primary'}
                disabled={microphoneState === 'requesting'}
                onClick={() => void onRequestMicrophone()}
              >
                <Mic2 aria-hidden="true" size={18} />
                {microphoneState === 'denied' || microphoneState === 'missing' || microphoneState === 'error'
                  ? 'Try microphone again'
                  : microphoneState === 'ready' ? 'Retest microphone' : 'Test microphone'}
              </Button>
            </div>
            {microphoneState === 'denied' ? (
              <p className="onboarding-recovery">{copy.onboardingMicrophoneDenied}</p>
            ) : null}
            {microphoneState === 'missing' ? (
              <p className="onboarding-recovery">{copy.onboardingMicrophoneMissing}</p>
            ) : null}
          </section>
        ) : null}

        {step === 3 ? (
          <section aria-label="Connect OpenRouter">
            <p className="onboarding-eyebrow">Transcription</p>
            <h1 id="onboarding-heading" ref={headingRef} tabIndex={-1}>Connect your OpenRouter key</h1>
            <p className="onboarding-lead">Sotto transcribes with Microsoft MAI-Transcribe-2 through OpenRouter. Paste a key from openrouter.ai/keys, then verify it.</p>
            <OpenRouterKeyField apiKey={settings.llmApiKey} onUpdateSettings={onUpdateSettings} onCheckTranscriptionKey={onCheckTranscriptionKey} />
            <p className="onboarding-aside">You can skip this step and add a key in Settings later.</p>
          </section>
        ) : null}

        {step === 4 ? (
          <section>
            <p className="onboarding-eyebrow">Shortcut &amp; paste</p>
            <h1 id="onboarding-heading" ref={headingRef} tabIndex={-1}>One shortcut from speech to text</h1>
            <p className="onboarding-lead">Press this shortcut to start. Press it again to finish. Your text is always copied before Sotto attempts to paste.</p>
            <div className="onboarding-shortcut"><span>Active shortcut</span><ShortcutKey accelerator={shortcut} platform={platform} /></div>
            <Field label="Paste test" description="A safe local field for testing your clipboard or shortcut.">
              <textarea
                className="tt-input onboarding-paste-field"
                value={pasteTest}
                onChange={(event) => setPasteTest(event.currentTarget.value)}
                placeholder="Paste or type here"
              />
            </Field>
            {completionError ? <p className="onboarding-completion-error" role="alert">Setup could not be saved. Your choices are intact; please try again.</p> : null}
          </section>
        ) : null}

        <footer className="onboarding-actions">
          <Button variant="ghost" onClick={goBack} disabled={step === 1 || finishing}>Back</Button>
          {step < STEP_COUNT ? <Button onClick={advance}>Continue</Button> : (
            <Button
              onClick={() => void finish()}
              disabled={microphoneState !== 'ready' || finishing}
            >
              {finishing ? 'Saving setup...' : 'Finish setup'}
            </Button>
          )}
        </footer>
      </Card>
    </main>
  )
}
