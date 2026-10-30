import { Check, Mic2, MicOff } from 'lucide-react'
import React, {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react'
import type { MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'

import type { SpeechModelOption, SpeechModelStatus } from '../../../../shared/speechModel'
import type { HostsBridge } from '../../../../shared/hosts'
import type { PhonesBridge } from '../../../../shared/phones'
import type { SottoPlatform } from '../../../../shared/platform'
import type { AppSettings, SettingsPatch } from '../../../../shared/settings'
import { useOptionalAgents } from '../../agents/AgentContext'
import { useAudioInputDevices, type MediaDevicesAdapter } from '../../audio/useAudioInputDevices'
import { formatModelSize, speechModelRefusedMessage, SpeechModelStatus as SpeechModelStatusView, speechModelSummary } from '../../components/SpeechModelStatus'
import { Button } from '../../components/Button'
import { OpenSystemSettingsButton } from '../../components/OpenSystemSettingsButton'
import { Card } from '../../components/Card'
import { Field } from '../../components/Field'
import { Select } from '../../components/Select'
import { SottoMark } from '../../components/SottoMark'
import { VoiceWave } from '../../components/VoiceWave'
import { ShortcutKey } from '../../components/ShortcutKey'
import { platformCopy } from '../../platformCopy'
import { AgentsStep } from './AgentsStep'
import { ComputersStep } from './ComputersStep'
import { liveAgentState, localProjects, localProviders } from './localAgents'
import { LookStep } from './LookStep'
import { MICROPHONE_HEARD_LEVEL, type MicrophoneTestState } from './microphoneTest'
import { PhoneStep } from './PhoneStep'
import { ProjectStep } from './ProjectStep'
import { OmarchySetupPanel, useOmarchySetup } from '../omarchy/OmarchySetup'
import './onboarding.css'

export interface OnboardingProps {
  readonly settings: AppSettings
  readonly onUpdateSettings: (patch: SettingsPatch) => Promise<boolean>
  /** The speech models Sotto can run on this computer; null until main answers. */
  readonly speechModels: readonly SpeechModelOption[] | null
  /** The id of the model dictation uses; null until the user chooses one. */
  readonly speechModelChoice: string | null
  /** Where the chosen speech model stands (ADR-0071); null until main answers. */
  readonly speechModel: SpeechModelStatus | null
  /** Chooses a model for dictation; choosing one of Sotto's models not here yet downloads it. */
  readonly onChooseSpeechModel: (id: string) => void
  /** True when the last choice was refused because that model is no longer on this computer. */
  readonly speechModelRefused?: boolean
  /** Tries the chosen model again after it failed. */
  readonly onRetrySpeechModel: () => void
  readonly microphoneState: MicrophoneTestState
  readonly microphoneLevel?: number
  readonly shortcut: string
  readonly platform: SottoPlatform
  readonly mediaDevices?: MediaDevicesAdapter | undefined
  readonly onRequestMicrophone: (selectedDeviceId?: string | null) => void | Promise<void>
  readonly onStopMicrophone?: () => void | Promise<void>
  /** Stops any running test and forgets its result, without opening the microphone. */
  readonly onResetMicrophone?: () => void | Promise<void>
  /** Opens an install guide or the TestFlight page in the browser; false when it did not open. */
  readonly onOpenLink?: (url: string) => Promise<boolean>
  readonly hostsBridge?: HostsBridge | undefined
  readonly phonesBridge?: PhonesBridge | undefined
  readonly onComplete: (
    outcome: { readonly microphoneSkipped: boolean },
  ) => boolean | void | Promise<boolean | void>
}

type StepId = 'welcome' | 'omarchy' | 'look' | 'microphone' | 'speech-model' | 'shortcut' | 'agents' | 'project' | 'computers' | 'phone'

type StepGroup = 'start' | 'dictation' | 'agents' | 'elsewhere'

interface SetupStep {
  readonly id: StepId
  readonly group: StepGroup
}

/** The progress bar's group names, in the interface language where they are shown. */
const GROUP_NAMES: Readonly<Record<StepGroup, MessageDescriptor>> = {
  start: msg({ message: 'Start', comment: 'First-run setup: the group of steps that begins it' }),
  dictation: msg({ message: 'Dictation', comment: 'First-run setup: the group of steps about dictation' }),
  agents: msg({ message: 'Agents', comment: 'First-run setup: the group of steps about coding agents' }),
  elsewhere: msg({ message: 'Elsewhere', comment: 'First-run setup: the group of steps about other computers and the iPhone' }),
}

/** First-run setup, in order: what Sotto is, how it looks, dictation, the coding agents, and other places to use it. */
const STEPS: readonly SetupStep[] = [
  { id: 'welcome', group: 'start' },
  { id: 'look', group: 'start' },
  { id: 'microphone', group: 'dictation' },
  { id: 'speech-model', group: 'dictation' },
  { id: 'shortcut', group: 'dictation' },
  { id: 'agents', group: 'agents' },
  { id: 'project', group: 'agents' },
  { id: 'computers', group: 'elsewhere' },
  { id: 'phone', group: 'elsewhere' },
]
const GROUPS = [...new Set(STEPS.map(step => step.group))]
const LINUX_STEPS: readonly SetupStep[] = [STEPS[0]!, { id: 'omarchy', group: 'start' }, ...STEPS.slice(1)]

/**
 * The microphone test passes once Sotto hears a voice, the level Settings' test counts as one, for this long in all,
 * a quiet stretch taking a third of its own length back.
 */
const HEARD_MS = 300
const LEVEL_READ_MS = 50
/** How long the test listens before it says it has heard nothing yet. */
const NOTHING_HEARD_MS = 6000

const openInBrowser = async (url: string): Promise<boolean> => {
  const result = await window.sotto?.openExternalLink?.(url).catch(() => null)
  return result?.ok === true
}

/** A step's heading and one-line lead. The bar above the card already names the step, so only the welcome has an eyebrow. */
function StepHeading({ title, lead, headingRef }: {
  readonly title: string
  readonly lead: ReactNode
  readonly headingRef: RefObject<HTMLHeadingElement | null>
}): ReactNode {
  return (
    <>
      <h1 id="onboarding-heading" ref={headingRef} tabIndex={-1}>{title}</h1>
      <p className="onboarding-lead tt-paragraph">{lead}</p>
    </>
  )
}

export function Onboarding({
  settings,
  onUpdateSettings,
  speechModels,
  speechModelChoice,
  speechModel,
  onChooseSpeechModel,
  speechModelRefused = false,
  onRetrySpeechModel,
  microphoneState,
  microphoneLevel = 0,
  shortcut,
  platform,
  mediaDevices = typeof navigator === 'undefined' ? undefined : navigator.mediaDevices,
  onRequestMicrophone,
  onStopMicrophone,
  onResetMicrophone,
  onOpenLink = openInBrowser,
  hostsBridge,
  phonesBridge,
  onComplete,
}: OnboardingProps): ReactNode {
  const { t, i18n } = useLingui()
  const [index, setIndex] = useState(0)
  const steps = platform === 'linux' ? LINUX_STEPS : STEPS
  const step = steps[index]!
  const omarchy = useOmarchySetup(platform === 'linux' && step.id === 'omarchy')
  const keysSet = omarchy.state && ['done', 'manual'].includes(omarchy.state.pieces.keys.status)

  // Nothing downloads until the user picks one of Sotto's models; models already on this computer come first.
  const installedSpeechModels = speechModels?.filter(model => model.installed) ?? []
  const downloadableSpeechModels = speechModels?.filter(model => !model.installed) ?? []
  const chosenSpeechModel = speechModels?.find(model => model.id === speechModelChoice) ?? null
  const [microphoneId, setMicrophoneId] = useState(settings.microphoneId)
  const [savedMicrophoneId, setSavedMicrophoneId] = useState(settings.microphoneId)
  if (settings.microphoneId !== savedMicrophoneId) {
    setSavedMicrophoneId(settings.microphoneId)
    setMicrophoneId(settings.microphoneId)
  }
  const savedMicrophoneRef = useRef(settings.microphoneId)
  savedMicrophoneRef.current = settings.microphoneId
  const microphoneSaveRef = useRef(0)
  const [microphoneSaveFailed, setMicrophoneSaveFailed] = useState(false)
  const [skipRequested, setSkipRequested] = useState(false)
  const [pasteTest, setPasteTest] = useState('')
  const [finishing, setFinishing] = useState(false)
  const [completionError, setCompletionError] = useState(false)
  const [hostCount, setHostCount] = useState(0)
  // The test the user started on this visit to the step, whether it has heard a voice, and the test that has heard
  // nothing for NOTHING_HEARD_MS. Leaving the step closes the microphone; a new test or another microphone starts over.
  const [microphoneOpen, setMicrophoneOpen] = useState(false)
  const [microphoneHeard, setMicrophoneHeard] = useState(false)
  const [testRun, setTestRun] = useState(0)
  const [quietRun, setQuietRun] = useState<number | null>(null)
  const levelRef = useRef(microphoneLevel)
  levelRef.current = microphoneLevel
  const headingRef = useRef<HTMLHeadingElement>(null)
  const copy = platformCopy(platform)
  const { devices: microphones, state: deviceState } = useAudioInputDevices(mediaDevices, microphoneState)
  const microphoneKnown = settings.microphoneId === null || microphones.some(({ deviceId }) => deviceId === settings.microphoneId)
  const agentState = liveAgentState(useOptionalAgents()?.state)

  useEffect(() => {
    headingRef.current?.focus()
  }, [index])

  const stopMicrophoneRef = useRef(onStopMicrophone)
  stopMicrophoneRef.current = onStopMicrophone
  const onMicrophoneStep = step.id === 'microphone'
  useEffect(() => {
    if (!onMicrophoneStep) void Promise.resolve(stopMicrophoneRef.current?.()).catch(() => undefined)
    return () => {
      if (onMicrophoneStep) void Promise.resolve(stopMicrophoneRef.current?.()).catch(() => undefined)
    }
  }, [onMicrophoneStep])

  // The test listens until it hears a voice, then closes the microphone: hearing one is what passes it.
  // The level is read on a timer rather than as it changes, so a voice held at one level still counts.
  const listening = onMicrophoneStep && microphoneOpen && microphoneState === 'ready' && !microphoneHeard
  useEffect(() => {
    if (!listening) return
    let loudMs = 0
    let last = Date.now()
    const timer = setInterval(() => {
      const now = Date.now()
      const elapsed = now - last
      last = now
      loudMs = Math.max(0, loudMs + (levelRef.current > MICROPHONE_HEARD_LEVEL ? elapsed : -elapsed / 3))
      if (loudMs < HEARD_MS) return
      clearInterval(timer)
      setMicrophoneHeard(true)
      setMicrophoneOpen(false)
      void Promise.resolve(stopMicrophoneRef.current?.()).catch(() => undefined)
    }, LEVEL_READ_MS)
    return () => clearInterval(timer)
  }, [listening])
  useEffect(() => {
    if (!listening) return
    const run = testRun
    const timer = setTimeout(() => setQuietRun(run), NOTHING_HEARD_MS)
    return () => clearTimeout(timer)
  }, [listening, testRun])
  const nothingHeard = listening && quietRun === testRun

  const stopTest = (): void => {
    setMicrophoneOpen(false)
    void Promise.resolve(onStopMicrophone?.()).catch(() => undefined)
  }
  // What the test box says: what happened, and what to do next.
  const testStatus: { readonly title: string; readonly next: string } = microphoneHeard ? { title: t`Sotto heard you. Your microphone works.`, next: t`Test again after changing the microphone.` }
    : nothingHeard ? { title: t`Nothing heard yet.`, next: t`Check that the microphone above is the one you speak into, then say something.` }
    : listening ? { title: t`Listening. Say something.`, next: t`The test passes once Sotto hears your voice.` }
    : microphoneState === 'requesting' ? { title: t`Opening the microphone…`, next: '' }
    : microphoneState === 'denied' ? { title: t`Microphone access is blocked.`, next: '' }
    : microphoneState === 'missing' ? { title: t`No microphone was found.`, next: '' }
    : microphoneState === 'error' ? { title: t`The microphone test could not start.`, next: t`Try again, or choose another microphone.` }
    : { title: t`Not tested yet.`, next: t`Press Test microphone, then say a few words.` }

  const testMicrophone = (): void => {
    setMicrophoneHeard(false)
    setMicrophoneOpen(true)
    setTestRun(run => run + 1)
    void onRequestMicrophone(microphoneId)
  }

  // A test that later reports ready retires the skip, so finishing after a
  // second attempt leaves the dictation surfaces in their working state.
  // Dictation needs access to the microphone, which a test that has not yet
  // heard a voice has already confirmed.
  const microphoneSkipped = skipRequested && microphoneState !== 'ready'

  // Whether a step's own task is done, which decides whether moving on is Continue or Skip for now.
  const stepDone = (id: StepId): boolean => {
    switch (id) {
      case 'omarchy': return !!omarchy.state && Object.values(omarchy.state.pieces).some(piece => ['done', 'manual'].includes(piece.status))
      case 'microphone': return microphoneHeard
      // Once the download is under way setup can go on; dictation works as soon as it finishes.
      case 'speech-model': return speechModelChoice !== null && speechModel !== null && speechModel.state !== 'missing' && speechModel.state !== 'failed'
      case 'agents': return agentState !== null && localProviders(agentState).some(provider => provider.connection === 'connected')
      case 'project': return agentState !== null && localProjects(agentState).length > 0
      case 'computers': return hostCount > 0
      default: return true
    }
  }

  const goBack = (): void => {
    setMicrophoneOpen(false)
    setIndex(current => Math.max(0, current - 1))
  }
  const advance = (): void => {
    if (step.id === 'microphone' && microphoneState !== 'ready') setSkipRequested(true)
    setMicrophoneOpen(false)
    setIndex(current => Math.min(steps.length - 1, current + 1))
  }

  // A picker change records the choice and retires the previous input's test:
  // a result belongs to one input, so Continue waits for a test of the new one.
  // Opening the microphone waits for the Test button: arrowing through a closed
  // picker must not open capture or raise the system's permission prompt once
  // per option.
  const chooseMicrophone = async (next: string | null): Promise<void> => {
    const sequence = ++microphoneSaveRef.current
    setMicrophoneId(next)
    setMicrophoneHeard(false)
    setMicrophoneOpen(false)
    void Promise.resolve(onResetMicrophone?.()).catch(() => undefined)
    setMicrophoneSaveFailed(false)
    const saved = await onUpdateSettings({ microphoneId: next }).catch(() => false)
    if (sequence !== microphoneSaveRef.current || saved) return
    setMicrophoneId(savedMicrophoneRef.current)
    setMicrophoneSaveFailed(true)
  }

  const finish = async (): Promise<void> => {
    if (finishing || (microphoneState !== 'ready' && !microphoneSkipped)) return
    setFinishing(true)
    setCompletionError(false)
    try {
      const completed = await onComplete({ microphoneSkipped })
      if (completed === false) setCompletionError(true)
    } catch {
      setCompletionError(true)
    } finally {
      setFinishing(false)
    }
  }

  const heading = (title: string, lead: ReactNode): ReactNode =>
    <StepHeading title={title} lead={lead} headingRef={headingRef} />

  const last = index === steps.length - 1
  const done = stepDone(step.id)
  const stepNumber = index + 1
  const stepCount = steps.length

  return (
    <main className="onboarding-shell" aria-labelledby="onboarding-heading">
      <nav className="onboarding-progress" aria-label={t`Setup progress: step ${stepNumber} of ${stepCount}`}>
        <span className="onboarding-progress__text" aria-live="polite" aria-atomic="true">
          <Trans>Step {stepNumber} of {stepCount}</Trans>
        </span>
        <ol aria-hidden="true">
          {GROUPS.map(group => {
            const members = steps.map((member, at) => ({ member, at })).filter(({ member }) => member.group === group)
            return (
              <li key={group} data-current={step.group === group} style={{ flexGrow: members.length }}>
                <span className="onboarding-progress__bars">
                  {members.map(({ at }) => <i key={at} data-complete={at < index} data-current={at === index} />)}
                </span>
                <span className="onboarding-progress__group">{i18n._(GROUP_NAMES[group])}</span>
              </li>
            )
          })}
        </ol>
      </nav>

      <Card className="onboarding-card">
        {/* The step scrolls inside the card, so Back and the way forward always stay in view. */}
        <div className="onboarding-card__body">
          {step.id === 'welcome' ? (
            <section aria-labelledby="onboarding-heading">
              <SottoMark className="onboarding-welcome__mark" />
              {heading(t`Talk to your computer and your coding agents`, platform === 'linux'
                ? t`Set up Sotto in Omarchy in the next step, then hold F9 to talk. Sotto copies your words, then pastes them into the focused app or terminal. Sotto also runs Codex, Claude Code, Grok Build and Devin threads in one window, on this computer or another.`
                : t`Press a shortcut and speak, and your words arrive as text wherever you were typing. Sotto also runs Codex, Claude Code, Grok Build and Devin threads in one window, on this computer or another.`)}
              <div className="onboarding-assurances">
                <p className="tt-paragraph"><Check aria-hidden="true" size={18} /> <Trans>Transcribed on this computer by the speech model you choose</Trans></p>
                <p className="tt-paragraph"><Check aria-hidden="true" size={18} /> <Trans>Your audio never leaves this computer</Trans></p>
                <p className="tt-paragraph"><Check aria-hidden="true" size={18} /> <Trans>Your threads go only to each agent's own provider</Trans></p>
                <p className="tt-paragraph"><Check aria-hidden="true" size={18} /> <Trans>No Sotto account, no telemetry</Trans></p>
              </div>
              <p className="onboarding-aside tt-paragraph"><Trans>Every step after this one can be skipped and finished later in Settings.</Trans></p>
            </section>
          ) : null}

          {step.id === 'omarchy' ? <section aria-labelledby="onboarding-heading">
            {heading(t`Set up Sotto in Omarchy`, t`Three changes to your Omarchy settings. Remove any of them later in Settings › Dictation.`)}
            <OmarchySetupPanel surface="first-run" controller={omarchy} />
          </section> : null}

          {step.id === 'look' ? (
            <LookStep settings={settings} platform={platform} onUpdateSettings={onUpdateSettings}
              heading={heading(t`Choose how Sotto looks`, t`Pick light or dark and a theme. The window and the owl follow your choice.`)} />
          ) : null}

          {step.id === 'microphone' ? (
            <section aria-labelledby="onboarding-heading">
              {heading(t`Check your microphone`, t`Sotto opens the microphone only while you dictate or run this test.`)}
              <Field
                className="onboarding-microphone-picker"
                label={t({ message: 'Microphone', comment: 'The microphone picker' })}
                {...(deviceState === 'error' ? { description: copy.settingsMicrophoneUnavailable } : {})}
                {...(microphoneSaveFailed ? { error: t`Sotto could not save that microphone. The previous one is still selected.` } : {})}
              >
                <Select
                  value={microphoneId ?? ''}
                  onChange={(event) => void chooseMicrophone(event.currentTarget.value || null)}
                >
                  <option value="">{copy.settingsMicrophoneDefaultOption}</option>
                  {!microphoneKnown && settings.microphoneId !== null ? <option value={settings.microphoneId}>{t`Previous microphone (unavailable)`}</option> : null}
                  {microphones.map((microphone, at) => {
                    const number = at + 1
                    return <option key={microphone.deviceId} value={microphone.deviceId}>{microphone.label || t`Microphone ${number}`}</option>
                  })}
                </Select>
              </Field>
              <div className="onboarding-microphone-test" data-state={microphoneHeard ? 'heard' : listening ? 'listening' : microphoneState}>
                {microphoneHeard
                  ? <span className="onboarding-microphone-test__heard"><Check aria-hidden="true" size={18} /></span>
                  // The wave the widget and the Dictate room show; it listens for as long as the test's stream runs.
                  : <VoiceWave stage={microphoneState === 'requesting' || listening ? 'listening' : 'idle'} value={microphoneLevel} label={t`Microphone level`} size="deck" holdSpeaking={listening} />}
                <p className="tt-paragraph" role="status"><strong>{testStatus.title}</strong>{testStatus.next ? <span>{testStatus.next}</span> : null}</p>
                {/* One button that changes with the test, so focus stays on it from Test to Stop to Test again. */}
                <Button
                  variant={listening || microphoneHeard ? 'secondary' : 'primary'}
                  aria-disabled={microphoneState === 'requesting'}
                  onClick={microphoneState === 'requesting' ? undefined : listening ? stopTest : testMicrophone}
                >
                  {listening ? <MicOff aria-hidden="true" size={18} /> : <Mic2 aria-hidden="true" size={18} />}
                  {listening ? t`Stop test`
                    : microphoneState === 'denied' || microphoneState === 'missing' || microphoneState === 'error' ? t`Try microphone again`
                    : microphoneHeard ? t`Test again` : t`Test microphone`}
                </Button>
              </div>
              {microphoneSkipped ? (
                <p className="onboarding-aside tt-paragraph"><Trans>Microphone test skipped. Dictation waits until you run the test in Settings.</Trans></p>
              ) : null}
              {microphoneState === 'denied' ? (
                <>
                  <p className="onboarding-recovery tt-paragraph">{copy.onboardingMicrophoneDenied}</p>
                  <OpenSystemSettingsButton platform={platform} pane="microphone" />
                </>
              ) : null}
              {microphoneState === 'missing' ? (
                <p className="onboarding-recovery tt-paragraph">{copy.onboardingMicrophoneMissing}</p>
              ) : null}
            </section>
          ) : null}

          {step.id === 'speech-model' ? (
            <section aria-labelledby="onboarding-heading">
              {heading(t`Choose a speech model`, t`Sotto turns your voice into text on this computer. Your audio never leaves it.`)}
              {speechModels === null ? (
                <p className="tt-field__description tt-paragraph" role="status"><Trans>Looking for speech models on this computer…</Trans></p>
              ) : (
                <>
                  {installedSpeechModels.length > 0 ? <p className="onboarding-speech-models__intro"><Trans>Already on this computer:</Trans></p> : null}
                  <ul className="onboarding-speech-models">
                    {[...installedSpeechModels, ...downloadableSpeechModels].map((model, position) => {
                      const chosen = model.id === speechModelChoice
                      const { name, maker, languages } = model
                      const size = formatModelSize(model.bytes)
                      return (
                        <li key={model.id} className="onboarding-speech-model" data-chosen={chosen || undefined}>
                          <div>
                            <span className="tt-field__label"><Trans>{name}, by {maker}</Trans></span>
                            <p className="tt-field__description tt-paragraph" {...(chosen ? { role: 'status' } : {})}>
                              {chosen && speechModel !== null && speechModel.state !== 'failed' && speechModel.state !== 'missing'
                                ? speechModel.state === 'ready' ? t`${languages}. Ready.` : `${speechModelSummary(speechModel, model.name)}.`
                                : model.installed ? `${languages}.` : t`${languages}. ${size}, from GitHub.`}
                            </p>
                          </div>
                          {/* The button stays once chosen (pressed) so keyboard focus is not lost. */}
                          <Button
                            variant={chosen || (position === 0 && speechModelChoice === null) ? 'primary' : 'secondary'}
                            aria-pressed={chosen}
                            onClick={() => { if (!chosen) onChooseSpeechModel(model.id) }}
                          >
                            {chosen ? <Check aria-hidden="true" size={16} /> : null}
                            {model.installed ? t`Use ${name}` : t`Download ${name}`}
                          </Button>
                        </li>
                      )
                    })}
                  </ul>
                  {speechModelRefused ? <p className="onboarding-recovery tt-paragraph" role="status">{speechModelRefusedMessage()}</p> : null}
                  {/* Rows say how the chosen model stands in one line, so every row fits the smallest window;
                      a failure needs its whole sentence and Try again, so it gets them below the list. */}
                  {speechModelChoice !== null && (chosenSpeechModel === null || speechModel?.state === 'failed')
                    ? <SpeechModelStatusView status={speechModel} model={chosenSpeechModel} onRetry={onRetrySpeechModel} />
                    : null}
                </>
              )}
              <p className="onboarding-aside tt-paragraph onboarding-speech-model__aside">{chosenSpeechModel?.source === 'sotto' && speechModel?.state === 'downloading'
                ? t`You can continue while it downloads. Dictation works as soon as it finishes. AI cleanup is optional; turn it on in Settings → Cleanup.`
                : t`AI cleanup is optional; turn it on in Settings → Cleanup.`}</p>
            </section>
          ) : null}

          {step.id === 'shortcut' ? (
            <section aria-labelledby="onboarding-heading">
              {platform === 'linux'
                ? heading(keysSet ? t`Hold F9 to try it` : t`Speak, then paste into any window`, keysSet
                  ? t`Hold F9 to talk, then release it. Sotto copies your text, then pastes into the focused app or terminal. If paste does not get through, use Super+V, Omarchy’s universal paste.`
                  : t`Set up the keys in Settings › Dictation when you’re ready. You can still dictate with Sotto’s button. If paste does not get through, use Super+V, Omarchy’s universal paste.`)
                : heading(t`One shortcut from speech to text`, t`Press it to start and again to finish. Your text is always copied before Sotto pastes it.`)}
              <div className="onboarding-shortcut">{platform === 'linux'
                ? <><span><Trans>Omarchy defaults</Trans></span><span>F9 · Super+Ctrl+X</span></>
                : <><span><Trans>Active shortcut</Trans></span><ShortcutKey accelerator={shortcut} platform={platform} /></>}</div>
              <Field label={t`Paste test`} description={t`A safe local field for testing your clipboard or shortcut.`}>
                <textarea
                  className="tt-input onboarding-paste-field"
                  value={pasteTest}
                  onChange={(event) => setPasteTest(event.currentTarget.value)}
                  placeholder={t`Paste or type here`}
                />
              </Field>
              {microphoneSkipped ? <p className="onboarding-aside tt-paragraph"><Trans>Microphone test skipped. Run it in Settings when you want to dictate.</Trans></p> : null}
            </section>
          ) : null}

          {step.id === 'agents' ? (
            <AgentsStep onOpenLink={onOpenLink}
              heading={heading(t`Your coding agents`, t`Sotto connects every agent installed on this computer, each signed in with your own account.`)} />
          ) : null}

          {step.id === 'project' ? (
            <ProjectStep
              heading={heading(t`Choose a project folder`, t`A project is a folder your agents work in, usually a Git repository. Threads start in it.`)} />
          ) : null}

          {step.id === 'computers' ? (
            <ComputersStep bridge={hostsBridge ?? window.sotto?.hosts} onHostsChange={setHostCount}
              heading={heading(t`Run agents on another computer`, t`Sotto can run threads on another PC, a Mac or a Linux box over Tailscale or SSH, and show them here.`)} />
          ) : null}

          {step.id === 'phone' ? (
            <>
              <PhoneStep phoneAccess={settings.phoneAccess} onUpdateSettings={onUpdateSettings} onOpenLink={onOpenLink}
                bridge={phonesBridge ?? window.sotto?.phones}
                heading={heading(t`Answer your threads from your iPhone`, t`The beta reads and answers threads on your computers, questions included. It needs Tailscale on the iPhone and on this computer.`)} />
              {completionError ? <p className="onboarding-completion-error tt-paragraph" role="alert"><Trans>Setup could not be saved. Your choices are intact; please try again.</Trans></p> : null}
            </>
          ) : null}
        </div>

        <footer className="onboarding-actions">
          {index > 0 ? <Button variant="ghost" onClick={goBack} disabled={finishing || step.id === 'omarchy' && omarchy.busy}><Trans>Back</Trans></Button> : <span />}
          {step.id === 'welcome' ? <Button onClick={advance}><Trans>Get started</Trans></Button> : null}
          {step.id !== 'welcome' && !last ? <Button variant={done ? 'primary' : 'secondary'} disabled={step.id === 'omarchy' && omarchy.busy} onClick={advance}>{done ? t`Continue` : t`Skip for now`}</Button> : null}
          {last ? (
            <Button onClick={() => void finish()} disabled={(microphoneState !== 'ready' && !microphoneSkipped) || finishing}>
              {finishing ? t`Saving setup...` : t`Finish setup`}
            </Button>
          ) : null}
        </footer>
      </Card>
    </main>
  )
}
