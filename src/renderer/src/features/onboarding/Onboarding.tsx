import { Check, Download, HardDrive, Keyboard, Mic2, ShieldCheck } from 'lucide-react'
import React, {
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'

import type { ModelDisclosure, ModelDisclosureCatalog } from '../../../../shared/contracts'
import { MODEL_CATALOG } from '../../../../shared/modelCatalog'
import type { ModelPreset } from '../../../../shared/settings'
import { Button } from '../../components/Button'
import { Card } from '../../components/Card'
import { Field } from '../../components/Field'
import { LevelMeter } from '../../components/LevelMeter'
import { ShortcutKey } from '../../components/ShortcutKey'
import type { MicrophoneTestState } from './microphoneTest'

export type OnboardingModelState = 'checking' | 'ready' | 'missing' | 'error' | 'unavailable'

export interface OnboardingProps {
  readonly microphoneState: MicrophoneTestState
  readonly microphoneLevel?: number
  readonly modelState: OnboardingModelState
  readonly shortcut: string
  readonly disclosures?: ModelDisclosureCatalog
  readonly onRequestMicrophone: () => void | Promise<void>
  readonly onStopMicrophone?: () => void | Promise<void>
  readonly onRetryModel?: () => void | Promise<void>
  readonly onInstallModel?: (preset: Exclude<ModelPreset, 'balanced'>) => void | Promise<void>
  readonly onComplete: () => boolean | void | Promise<boolean | void>
}

const STEP_COUNT = 4

function formatBytes(bytes: number): string {
  const megabytes = bytes / 1_000_000
  return `${megabytes < 10 ? megabytes.toFixed(1) : Math.round(megabytes)} MB`
}

function StepIcon({ step }: { readonly step: number }): ReactNode {
  const Icon = [ShieldCheck, Mic2, HardDrive, Keyboard][step - 1] ?? ShieldCheck
  return <Icon aria-hidden="true" size={24} strokeWidth={1.8} />
}

function OptionalModelCard({
  disclosure,
  consent,
  downloadsBusy,
  installing,
  onConsent,
  onInstall,
}: {
  readonly disclosure: ModelDisclosure
  readonly consent: boolean
  readonly downloadsBusy: boolean
  readonly installing: boolean
  readonly onConsent: (consent: boolean) => void
  readonly onInstall?: (() => void) | undefined
}): ReactNode {
  const name = MODEL_CATALOG[disclosure.preset].label
  const consentId = `optional-${disclosure.preset}-consent`
  return (
    <article className="onboarding-model-card">
      <div>
        <h3>{name}</h3>
        <p>{disclosure.repository}</p>
        <p>{formatBytes(disclosure.totalBytes)} / {disclosure.license} / {disclosure.sourceProvider}</p>
      </div>
      <label className="onboarding-consent" htmlFor={consentId}>
        <input
          id={consentId}
          type="checkbox"
          checked={consent}
          onChange={(event) => onConsent(event.currentTarget.checked)}
        />
        <span>Allow the {name} model download from {disclosure.sourceHost}</span>
      </label>
      <Button
        variant="secondary"
        disabled={!consent || downloadsBusy || onInstall === undefined}
        onClick={onInstall}
      >
        <Download aria-hidden="true" size={17} /> {installing ? `Starting ${name}...` : `Install ${name}`}
      </Button>
    </article>
  )
}

export function Onboarding({
  microphoneState,
  microphoneLevel = 0,
  modelState,
  shortcut,
  disclosures,
  onRequestMicrophone,
  onStopMicrophone,
  onRetryModel,
  onInstallModel,
  onComplete,
}: OnboardingProps): ReactNode {
  const [step, setStep] = useState(1)
  const [pasteTest, setPasteTest] = useState('')
  const [consent, setConsent] = useState({ instant: false, fast: false, accurate: false })
  const [installingPreset, setInstallingPreset] = useState<Exclude<ModelPreset, 'balanced'> | null>(null)
  const [installationError, setInstallationError] = useState<Exclude<ModelPreset, 'balanced'> | null>(null)
  const [finishing, setFinishing] = useState(false)
  const [completionError, setCompletionError] = useState(false)
  const headingRef = useRef<HTMLHeadingElement>(null)

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
    if (finishing || microphoneState !== 'ready' || modelState !== 'ready') return
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

  const installOptionalModel = async (preset: Exclude<ModelPreset, 'balanced'>): Promise<void> => {
    if (!consent[preset] || installingPreset !== null || onInstallModel === undefined) return
    setInstallingPreset(preset)
    setInstallationError(null)
    try {
      await onInstallModel(preset)
    } catch {
      setInstallationError(preset)
    } finally {
      setInstallingPreset(null)
    }
  }

  const optionalModels = disclosures?.models.filter(
    (model): model is ModelDisclosure & { preset: Exclude<ModelPreset, 'balanced'> } =>
      model.preset !== 'balanced',
  ) ?? []

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
            <p className="onboarding-eyebrow">Welcome to TalkType</p>
            <h1 id="onboarding-heading" ref={headingRef} tabIndex={-1}>Private dictation, ready when you are</h1>
            <p className="onboarding-lead">Speech stays on this computer during transcription. TalkType is free, needs no account, and includes no telemetry.</p>
            <div className="onboarding-assurances">
              <p><Check aria-hidden="true" size={18} /> Balanced speech model included</p>
              <p><Check aria-hidden="true" size={18} /> No cloud transcription or API key</p>
              <p><Check aria-hidden="true" size={18} /> Optional model downloads are always disclosed first</p>
            </div>
          </section>
        ) : null}

        {step === 2 ? (
          <section>
            <p className="onboarding-eyebrow">Microphone</p>
            <h1 id="onboarding-heading" ref={headingRef} tabIndex={-1}>Check your microphone</h1>
            <p className="onboarding-lead">TalkType needs microphone access only while you record or run this test.</p>
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
              <p className="onboarding-recovery">Open Windows Settings &gt; Privacy &amp; security &gt; Microphone, allow desktop apps, then try again.</p>
            ) : null}
            {microphoneState === 'missing' ? (
              <p className="onboarding-recovery">Connect or enable an input device in Windows Settings &gt; System &gt; Sound, then try again.</p>
            ) : null}
          </section>
        ) : null}

        {step === 3 ? (
          <section>
            <p className="onboarding-eyebrow">Speech model</p>
            <h1 id="onboarding-heading" ref={headingRef} tabIndex={-1}>Your local model</h1>
            {modelState === 'ready' ? (
              <div className="onboarding-ready"><Check aria-hidden="true" size={20} /><strong>The Balanced model is included and ready.</strong></div>
            ) : (
              <div className="onboarding-model-problem" role="status">
                <strong>{modelState === 'checking' ? 'Checking the bundled Balanced model...' : 'The bundled Balanced model is not ready.'}</strong>
                {modelState === 'checking' ? null : <Button variant="secondary" onClick={() => void onRetryModel?.()}>Retry model check</Button>}
              </div>
            )}
            <p className="onboarding-lead">Balanced is the dependable default. You can add the English-only Instant model, a smaller Fast model, or a larger Accurate model later.</p>
            {disclosures === undefined ? (
              <p className="onboarding-muted">
                Optional download details are unavailable. {modelState === 'ready'
                  ? 'Balanced remains local and usable.'
                  : modelState === 'checking'
                    ? 'Balanced availability is still being checked.'
                    : 'Balanced must pass the model check before it can be used.'}
              </p>
            ) : (
              <div className="onboarding-download-disclosure">
                <p>{disclosures.optionalDownloadNotice}</p>
                <div className="onboarding-model-list">
                  {optionalModels.map((model) => (
                    <OptionalModelCard
                      key={model.preset}
                      disclosure={model}
                      consent={consent[model.preset]}
                      downloadsBusy={installingPreset !== null}
                      installing={installingPreset === model.preset}
                      onConsent={(allowed) => setConsent((current) => ({ ...current, [model.preset]: allowed }))}
                      {...(onInstallModel === undefined ? {} : {
                        onInstall: () => void installOptionalModel(model.preset),
                      })}
                    />
                  ))}
                </div>
                {installationError === null ? null : (
                  <p className="onboarding-completion-error" role="alert">
                    The {MODEL_CATALOG[installationError].label} download could not start. The included Balanced model is unchanged.
                  </p>
                )}
              </div>
            )}
          </section>
        ) : null}

        {step === 4 ? (
          <section>
            <p className="onboarding-eyebrow">Shortcut &amp; paste</p>
            <h1 id="onboarding-heading" ref={headingRef} tabIndex={-1}>One shortcut from speech to text</h1>
            <p className="onboarding-lead">Press this shortcut to start. Press it again to finish. Your text is always copied before TalkType attempts to paste.</p>
            <div className="onboarding-shortcut"><span>Active shortcut</span><ShortcutKey accelerator={shortcut} /></div>
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
              disabled={microphoneState !== 'ready' || modelState !== 'ready' || finishing}
            >
              {finishing ? 'Saving setup...' : 'Finish setup'}
            </Button>
          )}
        </footer>
      </Card>
    </main>
  )
}
